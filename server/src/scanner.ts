import { db } from './db.js'
import * as G from './git.js'
import { parseUnifiedDiff, type DiffFile } from './diff.js'
import { listRules, matchRulesForFile, type Rule } from './rules.js'
import { extractExports, findReferences, isTextFile } from './refs.js'
import { chat, extractJson } from './ai.js'
import { classifyPath, parseScanConfig, type ScanConfig } from './scanconfig.js'

/**
 * 扫描引擎：
 * 1. 三种入口（branch / commits / workdir）计算 diff，应用项目扫描配置（include / exclude / allowlist / maxFiles）
 * 2. 触发器确定性命中 → rule_match issue（bad_case / rule）
 * 3. 逐文件调用 AI 评审（注入规则库、blame 作者、引用影响面）→ ai_found issue
 * 4. 全程逐文件进度写入 stats.progress（前端实时展示），单文件失败不中断，支持随时取消（保留已完成部分）
 */

const MAX_FILE_CHARS = 30_000
const MAX_DIFF_CHARS = 30_000
const CONCURRENCY = 3

interface ScanRow {
  id: number
  project_id: number
  type: 'branch' | 'commits' | 'workdir'
  base_ref: string | null
  head_ref: string | null
  status: string
  project_path?: string
  project_scan_config?: string | null
}

interface AiIssue {
  file?: string
  line?: number
  severity?: string
  title?: string
  description?: string
  suggestion?: string
  rule_ids?: string[]
  confidence?: string
}

/** 逐文件实时进度（stats.progress 数组元素） */
interface FileProgress {
  file: string
  state: 'running' | 'done' | 'error' | 'canceled' | 'exempt'
  ms?: number
  issues?: number
  note?: string
}

const insIssue = db.prepare(`
  INSERT INTO issues (scan_id, file_path, line_new, severity, title, description, suggestion, rule_ids, source, author, blame_date, status, confidence)
  VALUES (@scan_id, @file_path, @line_new, @severity, @title, @description, @suggestion, @rule_ids, @source, @author, @blame_date, 'open', @confidence)
`)

function setScan(scanId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields)
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE scans SET ${sets} WHERE id = @id`).run({ ...fields, id: scanId })
}

// ---------- 取消 ----------
const activeAborts = new Map<number, AbortController>()

/** 取消运行中的扫描；返回 false 表示没有活跃任务（调用方可直接置 canceled） */
export function abortScan(scanId: number): boolean {
  const ac = activeAborts.get(scanId)
  if (!ac) return false
  ac.abort()
  return true
}

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'AbortError') return true
  const cause = (e as Error & { cause?: { name?: string } }).cause
  return cause?.name === 'AbortError'
}

export async function runScan(scanId: number): Promise<void> {
  const scan = db
    .prepare(
      `SELECT s.*, p.path AS project_path, p.scan_config AS project_scan_config
       FROM scans s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`
    )
    .get(scanId) as ScanRow | undefined
  if (!scan || !scan.project_path) return
  if (scan.status === 'canceled') return // pending 阶段已被取消

  const ac = new AbortController()
  activeAborts.set(scanId, ac)
  const started = Date.now()
  setScan(scanId, { status: 'running', stats: null, error: null, finished_at: null })

  try {
    const repo = scan.project_path
    const config = parseScanConfig(scan.project_scan_config)
    const files = await collectDiffFiles(repo, scan, config)
    const rules = listRules(repo)

    // 固化扫描时点的 diff，供前端展示
    setScan(scanId, { diff: JSON.stringify(files) })

    const stats = {
      total: files.filter((f) => !f.exempt).length,
      done: 0,
      files: files.length,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      issues: 0,
      excluded: collectExcludedHint,
      exempted: files.filter((f) => f.exempt).length,
      aiErrors: [] as string[],
      rules: rules.length,
      progress: [] as FileProgress[]
    }
    const persist = () => setScan(scanId, { stats: JSON.stringify(stats) })
    persist()

    const progressOf = (file: string): FileProgress | undefined => stats.progress.find((p) => p.file === file)

    await runPool(
      files,
      CONCURRENCY,
      async (df) => {
        if (ac.signal.aborted) return

        // 豁免文件：不评审、不报问题（diff 仍展示），不计入评审进度 done/total
        if (df.exempt) {
          stats.progress.push({ file: df.path, state: 'exempt', note: df.exemptReason ?? '已豁免' })
          persist()
          return
        }

        const t0 = Date.now()
        stats.progress.push({ file: df.path, state: 'running' })
        persist()
        try {
          await reviewFile(repo, scanId, scan, df, rules, ac.signal, (patch) => {
            stats.done++
            const pr = progressOf(df.path)
            if (pr) {
              pr.state = 'done'
              pr.ms = Date.now() - t0
              pr.issues = patch?.fileIssues
            }
            if (patch?.issues != null) stats.issues = patch.issues
            persist()
          })
        } catch (e) {
          const pr = progressOf(df.path)
          const canceled = isAbortError(e)
          if (pr) {
            pr.state = canceled ? 'canceled' : 'error'
            pr.ms = Date.now() - t0
            pr.note = canceled ? '已停止' : (e as Error).message.slice(0, 160)
          }
          stats.done++
          if (!canceled) stats.aiErrors.push(`${df.path}: ${(e as Error).message.slice(0, 200)}`)
          persist()
        }
      },
      () => ac.signal.aborted
    )

    const canceled = ac.signal.aborted
    setScan(scanId, {
      status: canceled ? 'canceled' : 'done',
      finished_at: new Date().toISOString(),
      stats: JSON.stringify({ ...stats, durationMs: Date.now() - started, canceled })
    })
  } catch (e) {
    setScan(scanId, { status: 'error', error: (e as Error).message, finished_at: new Date().toISOString() })
  } finally {
    activeAborts.delete(scanId)
  }
}

/** collectDiffFiles 回传的排除文件数（fire-and-forget 单任务执行，模块级暂存可接受） */
let collectExcludedHint = 0

/** 按扫描类型收集变更文件（含 workdir 的 untracked 文件），并应用扫描配置 */
async function collectDiffFiles(repo: string, scan: ScanRow, config: ScanConfig): Promise<DiffFile[]> {
  collectExcludedHint = 0
  let text = ''
  if (scan.type === 'branch') {
    if (!scan.base_ref || !scan.head_ref) throw new Error('branch 扫描缺少 base/head')
    text = await G.diffText(repo, 'branch', { base: scan.base_ref, head: scan.head_ref })
  } else if (scan.type === 'commits') {
    if (!scan.base_ref || !scan.head_ref) throw new Error('commits 扫描缺少 from/to')
    text = await G.diffText(repo, 'commits', { base: scan.base_ref, head: scan.head_ref })
  } else {
    text = await G.diffText(repo, 'workdir', {})
  }

  const files: DiffFile[] = []
  const applyConfig = (f: DiffFile): boolean => {
    const cls = classifyPath(config, f.path)
    if (cls === 'excluded') {
      collectExcludedHint++
      return false
    }
    if (cls === 'allowlisted') {
      f.exempt = true
      f.exemptReason = '白名单豁免'
    }
    return true
  }

  for (const f of parseUnifiedDiff(text).filter((f) => !f.isBinary && f.additions + f.deletions > 0)) {
    // 规则文件本身不是业务代码（bad 示例会自命中触发器）
    if (f.path.startsWith('.codescan/')) continue
    if (applyConfig(f)) files.push(f)
  }

  // workdir：untracked 新文件补进扫描范围
  if (scan.type === 'workdir') {
    const st = await G.status(repo)
    for (const s of st) {
      const untracked = s.workdir === '?' || s.index === '?'
      if (!untracked || files.some((f) => f.path === s.path)) continue
      if (!isTextFile(s.path)) continue
      const content = await G.readFileAt(repo, null, s.path)
      if (content == null || content.includes('\0') || content.length > MAX_FILE_CHARS) continue
      const df = untrackedDiffFile(s.path, content)
      if (applyConfig(df)) files.push(df)
    }
  }

  // 超出评审上限的文件保留 diff 展示，但标记为不评审（按变更量优先保留）
  const toReview = files.filter((f) => !f.exempt)
  if (toReview.length > config.maxFiles) {
    const keep = new Set(
      [...toReview]
        .sort((a, b) => b.additions + b.deletions - (a.additions + b.deletions))
        .slice(0, config.maxFiles)
        .map((f) => f.path)
    )
    for (const f of toReview) {
      if (!keep.has(f.path)) {
        f.exempt = true
        f.exemptReason = `超出单次评审上限（${config.maxFiles}），保留 diff 但跳过评审`
      }
    }
  }
  return files
}

function untrackedDiffFile(filePath: string, content: string): DiffFile {
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return {
    path: filePath,
    oldPath: filePath,
    status: 'added',
    hunks: [
      {
        header: `@@ -0,0 +1,${lines.length} @@`,
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: lines.length,
        lines: lines.map((c, i) => ({ type: 'add' as const, oldLine: null, newLine: i + 1, content: c }))
      }
    ],
    additions: lines.length,
    deletions: 0,
    isBinary: false
  }
}

function renderUnified(df: DiffFile): string {
  const parts = [`--- a/${df.oldPath}`, `+++ b/${df.path}`]
  for (const h of df.hunks) {
    parts.push(h.header)
    for (const l of h.lines) {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : l.type === 'context' ? ' ' : '\\'
      parts.push(prefix + l.content)
    }
  }
  return parts.join('\n')
}

function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false }
  return { text: text.slice(0, max) + `\n…（已截断，原文 ${text.length} 字符）`, clipped: true }
}

async function reviewFile(
  repo: string,
  scanId: number,
  scan: ScanRow,
  df: DiffFile,
  rules: Rule[],
  signal: AbortSignal,
  onProgress: (patch?: { issues: number; fileIssues: number }) => void
) {
  const { contextRules, hardHits } = matchRulesForFile(rules, df)
  const readRef = scan.type === 'workdir' ? null : scan.head_ref || 'HEAD'

  // ---- blame：新增行的作者 ----
  let blameMap = new Map<number, G.BlameInfo>()
  if (df.status !== 'deleted') {
    try {
      blameMap = await G.blame(repo, readRef, df.path)
    } catch {
      /* blame 失败不阻塞 */
    }
  }

  // ---- 触发器确定性命中 → rule_match issue ----
  const insertedHard = new Map<string, number>() // ruleId -> issueId
  for (const hit of hardHits) {
    if (hit.rule.type === 'good_case') continue // good_case 只做上下文，不生成问题
    const line = hit.lines[0] ?? null
    const b = line != null ? blameMap.get(line) : undefined
    const examples = hit.rule.examples?.bad
      ? `\n\nbad 示例：\n${hit.rule.examples.bad}${hit.rule.examples?.good ? `\n\ngood 示例：\n${hit.rule.examples.good}` : ''}`
      : ''
    const r = insIssue.run({
      scan_id: scanId,
      file_path: df.path,
      line_new: line,
      severity: hit.rule.severity,
      title: `[${hit.rule.type === 'bad_case' ? 'Bad Case 命中' : '规则命中'}] ${hit.rule.name}`,
      description:
        `${hit.reason}\n\n规则说明：${hit.rule.description || '（无描述）'}${examples}\n\n命中行：${hit.lines.join(', ')}`,
      suggestion: hit.rule.examples?.good
        ? `参考 good 示例：\n${hit.rule.examples.good}`
        : '参照规则说明调整代码。',
      rule_ids: JSON.stringify([hit.rule.id]),
      source: 'rule_match',
      author: b?.author ?? null,
      blame_date: b?.date ?? null,
      confidence: 'high'
    })
    insertedHard.set(hit.rule.id, Number(r.lastInsertRowid))
  }

  // ---- AI 评审 ----
  let aiIssues: AiIssue[] = []
  let aiError: string | null = null
  const providerReady = !!db.prepare('SELECT id FROM ai_providers LIMIT 1').get()
  if (providerReady && df.additions > 0) {
    try {
      aiIssues = await aiReview(repo, readRef, df, contextRules, blameMap, signal)
    } catch (e) {
      aiError = (e as Error).message
      if (isAbortError(e)) throw e // 取消要向上传播终止任务
    }
  }

  // ---- AI 结果落库（去重/合并） ----
  const existRows = db
    .prepare('SELECT id, file_path, line_new, rule_ids, title FROM issues WHERE scan_id = ?')
    .all(scanId) as { id: number; file_path: string; line_new: number | null; rule_ids: string | null; title: string }[]

  let added = 0
  const validSev = new Set(['bug', 'major', 'important', 'minor', 'style'])
  const ruleIds = new Set(rules.map((r) => r.id))
  const totalLines = df.hunks.reduce((s, h) => Math.max(s, h.newStart + h.newCount), 0)

  for (const it of aiIssues) {
    const sev = validSev.has(String(it.severity)) ? String(it.severity) : 'minor'
    let line = typeof it.line === 'number' && it.line > 0 ? Math.floor(it.line) : null
    if (line != null && line > totalLines + 50) line = null // 明显越界则不锚定
    const rids = (it.rule_ids ?? []).filter((r) => ruleIds.has(r))

    // 若与触发器命中的 issue 同规则，视为确认，跳过重复
    if (rids.some((r) => insertedHard.has(r))) continue

    // 简单去重：同文件同标题已存在
    if (existRows.some((x) => x.file_path === df.path && x.title === it.title)) continue

    const b = line != null ? blameMap.get(line) : undefined
    insIssue.run({
      scan_id: scanId,
      file_path: df.path,
      line_new: line,
      severity: sev,
      title: String(it.title ?? '未命名问题').slice(0, 300),
      description: String(it.description ?? ''),
      suggestion: it.suggestion ? String(it.suggestion) : null,
      rule_ids: rids.length ? JSON.stringify(rids) : null,
      source: 'ai_found',
      author: b?.author ?? null,
      blame_date: b?.date ?? null,
      confidence: ['high', 'medium', 'low'].includes(String(it.confidence)) ? String(it.confidence) : 'medium'
    })
    added++
  }

  const totalIssues = (db.prepare('SELECT COUNT(*) c FROM issues WHERE scan_id = ?').get(scanId) as { c: number }).c
  if (aiError) stats_pushAiError(scanId, `${df.path}: ${aiError.slice(0, 200)}`)
  onProgress({ issues: totalIssues, fileIssues: insertedHard.size + added })
  return added
}

/** AI 单文件评审失败信息附加进 stats.aiErrors（不覆盖其他并发文件的进度） */
function stats_pushAiError(scanId: number, msg: string) {
  const row = db.prepare('SELECT stats FROM scans WHERE id = ?').get(scanId) as { stats: string | null }
  try {
    const s = JSON.parse(row.stats ?? '{}') as { aiErrors?: string[] }
    s.aiErrors = [...(s.aiErrors ?? []), msg]
    setScan(scanId, { stats: JSON.stringify(s) })
  } catch {
    /* ignore */
  }
}

async function aiReview(
  repo: string,
  readRef: string | null,
  df: DiffFile,
  contextRules: Rule[],
  blameMap: Map<number, G.BlameInfo>,
  signal: AbortSignal
): Promise<AiIssue[]> {
  const newContent = df.status === 'deleted' ? '' : await G.readFileAt(repo, readRef, df.path)
  const diffText = clip(renderUnified(df), MAX_DIFF_CHARS)
  const fileClip = newContent ? clip(newContent, MAX_FILE_CHARS) : { text: '（文件已删除）', clipped: false }

  // 引用影响面
  let refsBlock = '（无）'
  if (newContent && df.status !== 'deleted') {
    const exports = extractExports(df.path, newContent)
    if (exports.length) {
      const refs = await findReferences(repo, readRef, exports, [df.path], 40)
      refsBlock =
        refs.hits.length === 0
          ? `导出符号：${exports.join(', ')}（全仓库未见外部引用）`
          : refs.hits
              .map((h) => `- \`${h.symbol}\` ← ${h.file}:${h.line} \`${h.snippet}\``)
              .join('\n') + (refs.truncated ? '\n…（引用过多已截断）' : '')
    }
  }

  // blame 摘要（仅新增行）
  const blameLines: string[] = []
  for (const h of df.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add' && l.newLine != null) {
        const b = blameMap.get(l.newLine)
        if (b) blameLines.push(`- L${l.newLine}: ${b.author} (${b.date?.slice(0, 10) ?? ''}) ${b.summary}`)
        if (blameLines.length >= 60) break
      }
    }
    if (blameLines.length >= 60) break
  }

  // 规则库分块
  const strong = contextRules.slice(0, 25)
  const strongBlock = strong.length
    ? strong
        .map((r) => {
          const ex: string[] = []
          if (r.examples?.bad) ex.push(`bad 示例:\n${r.examples.bad.trim()}`)
          if (r.examples?.good) ex.push(`good 示例:\n${r.examples.good.trim()}`)
          return `#### [${r.id}] ${r.type} | ${r.name} | 严重度 ${r.severity}\n${r.description}${ex.length ? '\n\n' + ex.join('\n\n') : ''}`
        })
        .join('\n\n')
    : '（无强相关规则）'
  const others = listRules(repo).filter((r) => !strong.includes(r))
  const othersBlock = others.length
    ? others.map((r) => `- [${r.id}] ${r.type}/${r.severity} ${r.name}: ${r.description.slice(0, 120)}`).join('\n')
    : '（无）'

  const system = `你是资深代码评审专家，基于项目的规则库（bad_case / good_case / rule）评审代码变更。

评审要点：
1. 变更是否触犯规则库中的 bad_case 或 rule —— 触犯时必须在 rule_ids 中引用对应规则 id
2. good_case 展示了项目推荐写法，偏离它的写法若有风险也应指出（rule_ids 留空）
3. 结合"变更影响面"（该文件被哪些地方引用）判断修改可能引发的连锁问题：调用方是否兼容、行为变更是否破坏其他路径
4. 规则库未覆盖、但依据代码本身确实存在的问题

严重程度定义：
- bug: 会直接导致运行错误、数据错误、崩溃、安全问题
- major: 主要问题——逻辑缺陷、明显性能问题、破坏性变更未同步调用方
- important: 重要问题——错误处理缺失、边界条件、潜在风险
- minor: 轻微问题——冗余、小坏味道
- style: 代码风格——命名、格式、注释

要求：
- 宁缺毋滥，只报告有真实依据的问题；没把握的降低 confidence
- line 使用变更后（新版本）文件的行号
- description 说明为什么是问题、影响是什么；suggestion 给出具体可操作的修改建议
- 触犯规则库的必须在 rule_ids 给出规则 id；与规则无关的问题 rule_ids 为 []
- 只输出 JSON，不要输出其他内容

输出格式：
{"issues": [{"file": "文件路径", "line": 12, "severity": "bug|major|important|minor|style", "title": "简短标题", "description": "详细说明", "suggestion": "修改建议", "rule_ids": [], "confidence": "high|medium|low"}]}
没有问题则输出 {"issues": []}`

  const user = `# 待评审文件：${df.path}（${df.status}，+${df.additions}/-${df.deletions}）

## 变更 diff
\`\`\`diff
${diffText.text}
\`\`\`
${diffText.clipped ? '（diff 过长已截断，重点评审展示部分）' : ''}

## 变更后文件内容
\`\`\`
${fileClip.text}
\`\`\`

## 新增行的 git blame（作者信息，用于区分新人引入 vs 历史遗留；修复建议不应苛责历史代码）
${blameLines.length ? blameLines.join('\n') : '（无）'}

## 变更影响面：该文件导出符号在全仓库的引用
${refsBlock}

## 项目规则库（强相关：触发器命中或同语言）
${strongBlock}

## 其他规则摘要
${othersBlock}

请评审以上变更，输出 JSON。`

  const raw = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    { json: true, temperature: 0.2, maxTokens: 8192, signal }
  )
  const parsed = extractJson<{ issues?: AiIssue[] }>(raw)
  const list = Array.isArray(parsed.issues) ? parsed.issues : []
  for (const it of list) it.file = df.path // 强制锚定到当前文件
  return list
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, shouldStop?: () => boolean) {
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      if (shouldStop?.()) return // 已取消：不再取新文件
      const i = idx++
      try {
        await fn(items[i])
      } catch {
        /* 单文件失败由调用方内部记录 */
      }
    }
  })
  await Promise.all(workers)
}
