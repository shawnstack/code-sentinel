import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { db } from './db.js'
import * as G from './git.js'
import { listRules, saveRule, deleteRule, normalizeRule, type Rule } from './rules.js'
import { runScan, abortScan } from './scanner.js'
import { runFix, mergeFix, discardFix } from './fixer.js'
import { chat } from './ai.js'
import { listTextFiles, extractExports, findReferences } from './refs.js'
import { parseScanConfig, normalizeScanConfig } from './scanconfig.js'
import { WEB_DIST } from './config.js'

export const api = express.Router()
api.use(express.json({ limit: '5mb' }))

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => (
  req: express.Request,
  res: express.Response
) => {
  fn(req, res).catch((e) => res.status(500).json({ error: (e as Error).message }))
}

function projectOf(req: express.Request) {
  const id = Number(req.params.id)
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | { id: number; name: string; path: string }
    | undefined
  if (!p) throw new Error('项目不存在')
  return p
}

// ---------- health ----------
api.get('/health', (_req, res) => res.json({ ok: true }))

// ---------- 项目 ----------
api.get(
  '/projects',
  wrap(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM scans s WHERE s.project_id = p.id) scan_count,
                (SELECT MAX(s.created_at) FROM scans s WHERE s.project_id = p.id) last_scan_at
         FROM projects p ORDER BY p.id`
      )
      .all()
    res.json(rows)
  })
)

api.post(
  '/projects',
  wrap(async (req, res) => {
    const { path: rawPath, name } = req.body as { path?: string; name?: string }
    if (!rawPath) throw new Error('缺少 path')
    const abs = path.resolve(rawPath.replace('~', os.homedir()))
    if (!(await G.isGitRepo(abs))) throw new Error(`${abs} 不是 git 仓库`)
    const root = await G.repoRoot(abs)
    const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(root)
    if (existing) throw new Error('该项目已添加')
    const r = db
      .prepare('INSERT INTO projects (name, path) VALUES (?, ?)')
      .run(name?.trim() || path.basename(root), root)
    res.json({ id: Number(r.lastInsertRowid) })
  })
)

api.delete(
  '/projects/:id',
  wrap(async (req, res) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id))
    res.json({ ok: true })
  })
)

api.get(
  '/projects/:id/info',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const [branches, commits, clean, rules] = await Promise.all([
      G.listBranches(p.path),
      G.log(p.path, { max: 30 }),
      G.isClean(p.path),
      Promise.resolve(listRules(p.path))
    ])
    res.json({ currentBranch: branches.find((b) => b.isCurrent)?.name, branches, commits, isClean: clean, rulesCount: rules.length })
  })
)

// 文件树（代码 view）
api.get(
  '/projects/:id/tree',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const ref = (req.query.ref as string) || null
    let files: string[]
    if (ref) {
      const text = await G.git(p.path, ['ls-tree', '-r', '--name-only', ref])
      files = text.split('\n').filter((f) => f && !f.includes('\0') && !isBinaryName(f))
    } else {
      files = await listTextFiles(p.path, 12000)
    }
    res.json({ files })
  })
)

function isBinaryName(f: string): boolean {
  return /\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|gz|tar|mp4|mp3|woff2?|ttf|eot|so|dylib|dll|exe|sqlite3?|db)$/i.test(f)
}

// 单文件内容 + blame + 引用（代码 view / 问题上下文）
api.get(
  '/projects/:id/file',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const filePath = req.query.path as string
    const ref = (req.query.ref as string) || null
    if (!filePath) throw new Error('缺少 path')
    const content = await G.readFileAt(p.path, ref, filePath)
    if (content == null) throw new Error('文件不存在或为二进制')
    const blame = await G.blame(p.path, ref, filePath)
    const blameArr: { line: number; author: string; date: string; summary: string }[] = []
    for (const [line, info] of blame) blameArr.push({ line, ...info })
    const exports = extractExports(filePath, content)
    const refs = exports.length ? await findReferences(p.path, ref, exports, [filePath], 30) : { exports: [], hits: [], truncated: false }
    res.json({ path: filePath, content, blame: blameArr, exports, refs })
  })
)

// git log（可按文件）
api.get(
  '/projects/:id/log',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const ref = (req.query.ref as string) || undefined
    const file = (req.query.file as string) || undefined
    const max = Number(req.query.max) || 50
    res.json(await G.log(p.path, { ref, file, max }))
  })
)

// ---------- 扫描 ----------
api.get(
  '/projects/:id/scans',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const rows = db
      .prepare(
        `SELECT s.id, s.type, s.base_ref, s.head_ref, s.title, s.status, s.stats, s.error, s.created_at, s.finished_at,
                (SELECT COUNT(*) FROM issues i WHERE i.scan_id = s.id) issue_count
         FROM scans s WHERE s.project_id = ? ORDER BY s.id DESC`
      )
      .all(p.id)
    res.json(rows)
  })
)

api.post(
  '/projects/:id/scans',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const { type, base, head } = req.body as { type?: string; base?: string; head?: string }
    if (!['branch', 'commits', 'workdir'].includes(type ?? '')) throw new Error('type 必须为 branch | commits | workdir')

    let title = ''
    if (type === 'workdir') {
      title = '工作区改动'
    } else {
      if (!base || !head) throw new Error('缺少 base/head')
      const bv = await G.revParse(p.path, base)
      const hv = await G.revParse(p.path, head)
      if (!bv) throw new Error(`base ${base} 不是有效引用`)
      if (!hv) throw new Error(`head ${head} 不是有效引用`)
      title = type === 'branch' ? `${base}...${head}` : `${base}..${head}`
    }
    const r = db
      .prepare('INSERT INTO scans (project_id, type, base_ref, head_ref, title, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, type, type === 'workdir' ? null : base, type === 'workdir' ? null : head, title, 'pending')
    const scanId = Number(r.lastInsertRowid)
    runScan(scanId).catch(() => {})
    res.json({ id: scanId })
  })
)

// 取消扫描（中断 AI 请求，保留已完成部分的问题）
api.post(
  '/scans/:id/cancel',
  wrap(async (req, res) => {
    const id = Number(req.params.id)
    const scan = db.prepare('SELECT status FROM scans WHERE id = ?').get(id) as { status: string } | undefined
    if (!scan) throw new Error('扫描不存在')
    if (scan.status !== 'running' && scan.status !== 'pending') throw new Error('扫描已结束，无法取消')
    // 活跃任务走 AbortController；尚未启动（pending）直接置 canceled，runScan 启动时会自检
    if (!abortScan(id)) {
      db.prepare("UPDATE scans SET status = 'canceled', finished_at = ? WHERE id = ? AND status = 'pending'").run(
        new Date().toISOString(),
        id
      )
    }
    res.json({ ok: true })
  })
)

// 项目扫描配置
api.get(
  '/projects/:id/scan-config',
  wrap(async (req, res) => {
    const p = projectOf(req) as { scan_config?: string | null }
    res.json(parseScanConfig(p.scan_config))
  })
)

api.put(
  '/projects/:id/scan-config',
  wrap(async (req, res) => {
    const p = projectOf(req) as { id: number }
    const config = normalizeScanConfig(req.body)
    db.prepare('UPDATE projects SET scan_config = ? WHERE id = ?').run(JSON.stringify(config), p.id)
    res.json(config)
  })
)

api.get(
  '/scans/:id',
  wrap(async (req, res) => {
    const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(Number(req.params.id)) as
      | Record<string, unknown>
      | undefined
    if (!scan) throw new Error('扫描不存在')
    const issues = db.prepare('SELECT * FROM issues WHERE scan_id = ? ORDER BY severity, file_path, line_new').all(scan.id)
    const fixes = db
      .prepare('SELECT id, scan_id, branch, base_branch, issue_ids, status, commit_sha, created_at, finished_at FROM fix_tasks WHERE scan_id = ? ORDER BY id DESC')
      .all(scan.id)
    res.json({ scan, issues, fixes })
  })
)

api.patch(
  '/issues/:id',
  wrap(async (req, res) => {
    const { status } = req.body as { status?: string }
    if (!['open', 'resolved', 'wont_fix'].includes(status ?? '')) throw new Error('非法 status')
    db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(status, Number(req.params.id))
    res.json({ ok: true })
  })
)

// ---------- 修复任务 ----------
api.post(
  '/scans/:id/fixes',
  wrap(async (req, res) => {
    const scanId = Number(req.params.id)
    const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId) as { project_id: number } | undefined
    if (!scan) throw new Error('扫描不存在')
    const ids: number[] = Array.isArray(req.body.issue_ids) ? req.body.issue_ids.map(Number) : []
    if (ids.length === 0) throw new Error('未选择问题')
    const r = db
      .prepare('INSERT INTO fix_tasks (scan_id, project_id, issue_ids, status) VALUES (?, ?, ?, ?)')
      .run(scanId, scan.project_id, JSON.stringify(ids), 'pending')
    const fixId = Number(r.lastInsertRowid)
    runFix(fixId).catch(() => {})
    res.json({ id: fixId })
  })
)

api.get(
  '/projects/:id/fixes',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const rows = db
      .prepare(
        `SELECT f.id, f.scan_id, f.branch, f.base_branch, f.issue_ids, f.status, f.commit_sha, f.log, f.result_diff, f.created_at, f.finished_at,
                (SELECT title FROM scans s WHERE s.id = f.scan_id) scan_title
         FROM fix_tasks f WHERE f.project_id = ? ORDER BY f.id DESC`
      )
      .all(p.id)
    res.json(rows)
  })
)

api.get(
  '/fixes/:id',
  wrap(async (req, res) => {
    const fix = db.prepare('SELECT * FROM fix_tasks WHERE id = ?').get(Number(req.params.id))
    if (!fix) throw new Error('修复任务不存在')
    res.json(fix)
  })
)

api.post(
  '/fixes/:id/merge',
  wrap(async (req, res) => {
    await mergeFix(Number(req.params.id))
    res.json({ ok: true })
  })
)

api.post(
  '/fixes/:id/discard',
  wrap(async (req, res) => {
    await discardFix(Number(req.params.id))
    res.json({ ok: true })
  })
)

// ---------- 规则 ----------
api.get(
  '/projects/:id/rules',
  wrap(async (req, res) => {
    const p = projectOf(req)
    res.json(listRules(p.path))
  })
)

api.put(
  '/projects/:id/rules',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const raw = req.body as Partial<Rule>
    if (!raw.id?.trim()) throw new Error('规则 id 必填')
    const rule = normalizeRule(raw)
    const file = saveRule(p.path, rule)
    res.json({ ok: true, file })
  })
)

api.delete(
  '/projects/:id/rules',
  wrap(async (req, res) => {
    const p = projectOf(req)
    const ok = deleteRule(p.path, String(req.query.id))
    if (!ok) throw new Error('规则不存在')
    res.json({ ok: true })
  })
)

// ---------- AI 配置 ----------
function maskProviders() {
  return (db.prepare('SELECT * FROM ai_providers ORDER BY is_active DESC, id').all() as Record<string, unknown>[]).map(
    (p) => ({ ...p, api_key: p.api_key ? `${String(p.api_key).slice(0, 6)}…` : '' })
  )
}

api.get('/ai/providers', (_req, res) => res.json(maskProviders()))

api.post(
  '/ai/providers',
  wrap(async (req, res) => {
    const { name, base_url, api_key, model, is_active } = req.body as Record<string, string | boolean>
    if (!name || !base_url || !model) throw new Error('name / base_url / model 必填')
    if (is_active) db.prepare('UPDATE ai_providers SET is_active = 0').run()
    const r = db
      .prepare('INSERT INTO ai_providers (name, base_url, api_key, model, is_active) VALUES (?, ?, ?, ?, ?)')
      .run(name, base_url, api_key ?? '', model, is_active ? 1 : 0)
    res.json({ id: Number(r.lastInsertRowid) })
  })
)

api.patch(
  '/ai/providers/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id)
    const { is_active, name, base_url, api_key, model } = req.body as Record<string, string | boolean>
    if (is_active) db.prepare('UPDATE ai_providers SET is_active = 0').run()
    const sets: string[] = []
    const vals: unknown[] = []
    if (is_active !== undefined) {
      sets.push('is_active = ?')
      vals.push(is_active ? 1 : 0)
    }
    for (const [k, v] of Object.entries({ name, base_url, model, api_key })) {
      if (v !== undefined && v !== '') {
        sets.push(`${k} = ?`)
        vals.push(v)
      }
    }
    if (sets.length) db.prepare(`UPDATE ai_providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    res.json({ ok: true })
  })
)

api.delete(
  '/ai/providers/:id',
  wrap(async (req, res) => {
    db.prepare('DELETE FROM ai_providers WHERE id = ?').run(Number(req.params.id))
    res.json({ ok: true })
  })
)

api.post(
  '/ai/test',
  wrap(async (_req, res) => {
    const reply = await chat([{ role: 'user', content: '只回复两个字：正常' }], { maxTokens: 50, temperature: 0 })
    res.json({ ok: true, reply: reply.slice(0, 50) })
  })
)

/** 从 NoteFlow 配置目录导入 provider（~/.noteflow/config/providers.json 的 customProviders 结构） */
api.post(
  '/ai/import-noteflow',
  wrap(async (_req, res) => {
    const file = path.join(os.homedir(), '.noteflow', 'config', 'providers.json')
    if (!fs.existsSync(file)) throw new Error(`未找到 NoteFlow 配置文件 ${file}`)
    const found: { name: string; base_url: string; api_key: string; model: string }[] = []
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        customProviders?: Record<string, {
          name?: string
          baseUrl?: string
          apiKey?: string
          models?: { id?: string; baseUrl?: string }[]
        }>
      }
      for (const p of Object.values(data.customProviders ?? {})) {
        if (!p?.baseUrl || !Array.isArray(p.models)) continue
        for (const m of p.models.slice(0, 10)) {
          const modelId = typeof m === 'string' ? m : m?.id
          if (!modelId) continue
          if (found.length >= 30) break
          // model 自带 baseUrl 时优先（可能指向不同端点）
          const baseUrl = (typeof m === 'object' && m.baseUrl) || p.baseUrl
          found.push({ name: p.name ?? 'noteflow', base_url: baseUrl, api_key: p.apiKey ?? '', model: modelId })
        }
      }
    } catch {
      throw new Error('providers.json 解析失败')
    }
    if (found.length === 0) throw new Error('NoteFlow 配置中未识别出 provider')
    for (const p of found) {
      const dup = db.prepare('SELECT id FROM ai_providers WHERE name = ? AND model = ?').get(p.name, p.model)
      if (!dup) {
        db.prepare('INSERT INTO ai_providers (name, base_url, api_key, model, is_active) VALUES (?, ?, ?, ?, 0)').run(
          p.name, p.base_url, p.api_key, p.model
        )
      }
    }
    const anyActive = db.prepare('SELECT id FROM ai_providers WHERE is_active = 1').get()
    if (!anyActive) db.prepare('UPDATE ai_providers SET is_active = 1 WHERE id = (SELECT MIN(id) FROM ai_providers)').run()
    res.json({ imported: found.length, providers: maskProviders() })
  })
)

// ---------- 文件系统浏览（添加项目时的目录选择） ----------

interface FsListResult {
  path: string
  parent: string | null
  dirs: string[]
  isGitRepo: boolean
  places: { name: string; path: string }[]
  error?: string
}

api.get(
  '/fs/list',
  wrap(async (req, res) => {
    const home = os.homedir()
    const raw = (req.query.dir as string) || ''
    const dir = raw ? path.resolve(raw.replace(/^~(?=\/|$)/, home)) : home
    const result: FsListResult = {
      path: dir,
      parent: path.dirname(dir) === dir ? null : path.dirname(dir),
      dirs: [],
      isGitRepo: false,
      places: []
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      result.dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    } catch (e) {
      result.error = `无法读取目录：${(e as Error).message}`
    }
    try {
      result.isGitRepo = fs.existsSync(path.join(dir, '.git'))
    } catch {
      /* ignore */
    }
    const candidates: { name: string; path: string }[] = [
      { name: '🏠 家目录', path: home },
      { name: '🖥 桌面', path: path.join(home, 'Desktop') },
      { name: '📄 文档', path: path.join(home, 'Documents') },
      { name: '⬇️ 下载', path: path.join(home, 'Downloads') },
      { name: '💻 根目录', path: '/' }
    ]
    result.places = candidates.filter((p) => p.path === '/' || fs.existsSync(p.path))
    res.json(result)
  })
)

/** macOS 原生目录选择对话框（osascript）。不可用/失败时前端降级为网页目录浏览器 */
api.post(
  '/fs/pick-folder',
  wrap(async (_req, res) => {
    if (process.platform !== 'darwin') {
      res.json({ available: false })
      return
    }
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          'osascript',
          ['-e', 'POSIX path of (choose folder with prompt "选择 git 仓库目录")'],
          { timeout: 180_000 }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => {
          stdout += d
        })
        child.stderr.on('data', (d) => {
          stderr += d
        })
        child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))))
        child.on('error', reject)
      })
      res.json({ available: true, ok: true, path: out.replace(/\/+$/, '') })
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (/User canceled|用户取消|canceled/i.test(msg)) {
        res.json({ available: true, canceled: true })
        return
      }
      res.json({ available: true, ok: false, reason: msg.slice(0, 200) })
    }
  })
)

// ---------- 静态托管（生产） ----------
export function mountStatic(app: express.Express) {
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST))
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, 'index.html'))
    })
  }
}
