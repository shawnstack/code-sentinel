import fs from 'node:fs/promises'
import { db } from './db.js'
import * as G from './git.js'
import { chat } from './ai.js'
import { listRules } from './rules.js'
import { parseUnifiedDiff } from './diff.js'

/**
 * AI 修复流程：
 * - branch / commits 入口：从当前 HEAD 建 fix/scan-N 分支 → AI 逐问题生成 SEARCH/REPLACE 修复 → 打包 commit → 回到原分支，用户决定合并/丢弃
 * - workdir 入口：直接修改工作区文件（保留快照可撤销），不建分支
 */

interface FixRow {
  id: number
  scan_id: number
  project_id: number
  branch: string | null
  base_branch: string | null
  issue_ids: string
  status: string
}

interface IssueRow {
  id: number
  file_path: string
  line_new: number | null
  severity: string
  title: string
  description: string
  suggestion: string | null
  rule_ids: string | null
}

export interface ReplaceBlock {
  search: string
  replace: string
}

/** 解析 AI 输出的 SEARCH/REPLACE 块（宽容分隔符变体） */
export function parseReplaceBlocks(text: string): ReplaceBlock[] {
  const re = /<{4,9} ?SEARCH\r?\n([\s\S]*?)\r?\n={4,9}\r?\n([\s\S]*?)\r?\n>{4,9} ?REPLACE/g
  const blocks: ReplaceBlock[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    blocks.push({ search: m[1], replace: m[2] })
  }
  return blocks
}

/** 应用替换块；返回新内容与失败块 */
export function applyReplaceBlocks(
  content: string,
  blocks: ReplaceBlock[]
): { content: string; applied: number; failed: number } {
  let out = content
  let applied = 0
  let failed = 0
  for (const b of blocks) {
    const s = b.search
    const idx = out.indexOf(s)
    if (idx === -1) {
      failed++
      continue
    }
    out = out.slice(0, idx) + b.replace + out.slice(idx + s.length)
    applied++
  }
  return { content: out, applied, failed }
}

function setFix(fixId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields)
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE fix_tasks SET ${sets} WHERE id = @id`).run({ ...fields, id: fixId })
}

export async function runFix(fixId: number): Promise<void> {
  const fix = db.prepare('SELECT * FROM fix_tasks WHERE id = ?').get(fixId) as FixRow | undefined
  if (!fix) return
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(fix.project_id) as { path: string } | undefined
  if (!project) return
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(fix.scan_id) as
    | { type: string }
    | undefined
  const repo = project.path
  const log: string[] = []
  const issueIds: number[] = JSON.parse(fix.issue_ids)
  const issues = issueIds
    .map((id) => db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as IssueRow | undefined)
    .filter((x): x is IssueRow => !!x)

  setFix(fixId, { status: 'running', log: null })
  log.push(`开始修复：${issues.length} 个问题，扫描类型 ${scan?.type}`)

  try {
    // ---- 前置检查 ----
    const clean = await G.isClean(repo)
    if (scan?.type !== 'workdir' && !clean) {
      throw new Error('工作区不干净（有未提交改动）。请先提交或暂存，再执行 AI 修复')
    }

    // ---- 分支策略 ----
    let branch: string | null = null
    let baseBranch: string | null = null
    if (scan?.type !== 'workdir') {
      baseBranch = await G.currentBranch(repo)
      branch = `fix/scan-${fix.scan_id}-${fix.id}`
      if (await G.branchExists(repo, branch)) {
        throw new Error(`分支 ${branch} 已存在，请先在「修复任务」中处理旧任务`)
      }
      await G.createBranch(repo, branch)
      log.push(`已创建修复分支 ${branch}（基于 ${baseBranch}@HEAD）`)
    }

    // ---- 修复前快照 ----
    const touchedFiles = [...new Set(issues.map((i) => i.file_path))]
    const snapshot: Record<string, string> = {}
    for (const f of touchedFiles) {
      const c = await G.readFileAt(repo, null, f)
      snapshot[f] = c ?? ''
    }
    setFix(fixId, { snapshot: JSON.stringify(snapshot) })

    // ---- 逐文件修复 ----
    const rules = listRules(repo)
    const byFile = new Map<string, IssueRow[]>()
    for (const it of issues) {
      const arr = byFile.get(it.file_path) ?? []
      arr.push(it)
      byFile.set(it.file_path, arr)
    }

    let allApplied = 0
    let allFailed = 0
    for (const [file, fileIssues] of byFile) {
      const content = snapshot[file]
      if (content == null || content === '') {
        log.push(`⚠️ 跳过 ${file}：无法读取内容`)
        continue
      }
      log.push(`修复 ${file}（${fileIssues.length} 个问题）…`)
      try {
        const patched = await aiFixFile(file, content, fileIssues, rules)
        if (patched.blocks.length === 0) {
          log.push(`  ⚠️ AI 未给出修复块：${patched.note}`)
          allFailed += fileIssues.length
          continue
        }
        const res = applyReplaceBlocks(content, patched.blocks)
        if (res.applied > 0) {
          await fs.writeFile(G.safeRepoPath(repo, file), res.content, 'utf8')
          log.push(`  ✅ 应用 ${res.applied} 个替换块${res.failed ? `，${res.failed} 个未匹配` : ''}`)
          allApplied += res.applied
          if (res.failed > 0) allFailed += res.failed
        } else {
          log.push(`  ❌ 所有替换块都未匹配到原文（AI 输出与文件内容不一致）`)
          allFailed += res.failed
        }
      } catch (e) {
        log.push(`  ❌ AI 修复失败：${(e as Error).message.slice(0, 200)}`)
        allFailed += fileIssues.length
      }
    }

    // ---- 提交（branch / commits 模式） ----
    let commitSha: string | null = null
    let resultDiff: string | null = null
    if (branch && baseBranch) {
      const msg =
        `fix(code-sentinel): 修复扫描 #${fix.scan_id} 的 ${issues.length} 个问题\n\n` +
        issues.map((i) => `- [${i.severity}] ${i.title} (${i.file_path}:${i.line_new ?? '-'})`).join('\n')
      commitSha = await G.commitFiles(repo, msg)
      log.push(`已提交 ${commitSha.slice(0, 8)} 到 ${branch}`)
      resultDiff = JSON.stringify(parseUnifiedDiff(await G.diffText(repo, 'commits', { base: baseBranch, head: branch })))
      await G.checkout(repo, baseBranch)
      log.push(`已切回 ${baseBranch}。请查看修复 diff 后在「修复任务」中选择合并或丢弃`)
    } else {
      resultDiff = JSON.stringify(parseUnifiedDiff(await G.diffText(repo, 'workdir', {})))
      log.push('工作区模式：修复已直接应用到工作区文件，可随时撤销')
    }

    setFix(fixId, {
      status: allApplied > 0 ? 'done' : 'failed',
      branch,
      base_branch: baseBranch,
      commit_sha: commitSha,
      result_diff: resultDiff,
      log: log.join('\n'),
      finished_at: new Date().toISOString()
    })
    if (allApplied === 0) {
      log.push('没有任何修复被成功应用')
      setFix(fixId, { log: log.join('\n') })
    }
  } catch (e) {
    log.push(`❌ 失败：${(e as Error).message}`)
    setFix(fixId, { status: 'failed', log: log.join('\n'), finished_at: new Date().toISOString() })
  }
}

async function aiFixFile(
  file: string,
  content: string,
  issues: IssueRow[],
  rules: { id: string; type: string; name: string; description: string; severity: string; examples?: { bad?: string; good?: string } }[]
): Promise<{ blocks: ReplaceBlock[]; note?: string }> {
  const maxChars = 60_000
  const clipped = content.length > maxChars
  const contentText = clipped ? content.slice(0, maxChars) + '\n…（已截断）' : content

  const issueBlocks = issues
    .map((i) => {
      const rids: string[] = JSON.parse(i.rule_ids ?? '[]')
      const related = rules.filter((r) => rids.includes(r.id))
      const ruleText = related
        .map((r) => `规则 [${r.id}] ${r.name}（${r.type}，严重度 ${r.severity}）：${r.description}${r.examples?.good ? `\ngood 示例:\n${r.examples.good}` : ''}`)
        .join('\n')
      return `### 问题 ${i.id}：[${i.severity}] ${i.title}（约第 ${i.line_new ?? '?'} 行）\n${i.description}\n修改建议：${i.suggestion ?? '无'}${ruleText ? `\n关联规则：\n${ruleText}` : ''}`
    })
    .join('\n\n')

  const system = `你是代码修复助手。根据代码评审问题和项目规则库，对给定文件生成最小化修复。

输出格式：若干个 SEARCH/REPLACE 块，格式严格如下（分隔符各占一行）：

<<<<<<< SEARCH
需要替换的原文（从原文件逐字符精确复制，含缩进；带 1-2 行上下文保证唯一定位）
=======
替换后的内容
>>>>>>> REPLACE

要求：
- SEARCH 必须与文件当前内容完全一致（空格、缩进、注释都不能改）
- 一个文件可以输出多个块，按顺序执行
- 只修改与问题相关的代码，不要顺手重构无关内容
- 优先满足规则库中的 good 示例
- 如果上下文不足以安全修复，不要强行修改
- 除这些块外不要输出任何其他文字${clipped ? '\n注意：文件内容已截断，仅修复展示范围内的问题' : ''}`

  const user = `# 文件：${file}

## 当前内容
\`\`\`
${contentText}
\`\`\`

## 待修复问题
${issueBlocks}

请输出 SEARCH/REPLACE 修复块。`

  const raw = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    { temperature: 0, maxTokens: 8192 }
  )
  const blocks = parseReplaceBlocks(raw)
  return { blocks, note: blocks.length ? undefined : raw.slice(0, 200) }
}

/** 合并 fix 分支回原分支 */
export async function mergeFix(fixId: number): Promise<void> {
  const fix = db.prepare('SELECT * FROM fix_tasks WHERE id = ?').get(fixId) as FixRow | undefined
  if (!fix) throw new Error('修复任务不存在')
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(fix.project_id) as { path: string }
  if (fix.status !== 'done' || !fix.branch || !fix.base_branch) throw new Error('任务状态不允许合并')
  const repo = project.path
  if (!(await G.isClean(repo))) throw new Error('工作区不干净，请先处理未提交改动')

  const cur = await G.currentBranch(repo)
  if (cur !== fix.base_branch) {
    await G.checkout(repo, fix.base_branch)
  }
  await G.mergeIntoCurrent(repo, fix.branch)
  await G.deleteBranch(repo, fix.branch)
  setFix(fixId, { status: 'merged', finished_at: new Date().toISOString() })
}

/** 丢弃修复：删分支 / 恢复快照 */
export async function discardFix(fixId: number): Promise<void> {
  const fix = db.prepare('SELECT * FROM fix_tasks WHERE id = ?').get(fixId) as (FixRow & { snapshot: string | null }) | undefined
  if (!fix) throw new Error('修复任务不存在')
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(fix.project_id) as { path: string }
  const repo = project.path

  if (fix.branch && fix.base_branch) {
    const cur = await G.currentBranch(repo)
    if (cur === fix.branch) await G.checkout(repo, fix.base_branch)
    else if (cur !== fix.base_branch) await G.checkout(repo, fix.base_branch)
    await G.deleteBranch(repo, fix.branch)
  } else {
    // workdir：从快照恢复
    const snap: Record<string, string> = JSON.parse(fix.snapshot ?? '{}')
    for (const [file, content] of Object.entries(snap)) {
      await fs.writeFile(G.safeRepoPath(repo, file), content, 'utf8')
    }
  }
  setFix(fixId, { status: 'discarded', finished_at: new Date().toISOString() })
}
