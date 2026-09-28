import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { RULES_DIR } from './config.js'
import { parseUnifiedDiff, addedLinesOf, type DiffFile } from './diff.js'

/** 规则 / Case 引擎：读写目标项目 .codescan/rules/*.yaml，触发器匹配 */

export type RuleType = 'bad_case' | 'good_case' | 'rule'

export interface Rule {
  id: string
  type: RuleType
  name: string
  description: string
  severity: 'bug' | 'major' | 'important' | 'minor' | 'style'
  enabled: boolean
  trigger: {
    paths?: string[]
    symbols?: string[]
    languages?: string[]
  }
  examples?: { bad?: string; good?: string }
}

export interface RuleMatch {
  rule: Rule
  reason: string
  lines: number[] // 命中的新增行号
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp',
  swift: 'swift', vue: 'vue', svelte: 'svelte', sh: 'shell'
}

export function langOf(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  return EXT_LANG[ext] ?? ''
}

export function globToRegex(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(re + '$')
}

function rulesDir(projectPath: string): string {
  return path.join(projectPath, RULES_DIR)
}

export function listRules(projectPath: string): Rule[] {
  const dir = rulesDir(projectPath)
  if (!fs.existsSync(dir)) return []
  const out: Rule[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue
    try {
      const raw = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as Partial<Rule> | undefined
      if (!raw?.id) continue
      out.push(normalizeRule(raw))
    } catch {
      // 单个文件损坏不影响整体
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function normalizeRule(raw: Partial<Rule>): Rule {
  const type: RuleType = (['bad_case', 'good_case', 'rule'] as const).includes(raw.type as RuleType)
    ? (raw.type as RuleType)
    : 'rule'
  const severity = (['bug', 'major', 'important', 'minor', 'style'] as const).includes(raw.severity as never)
    ? (raw.severity as Rule['severity'])
    : 'minor'
  return {
    id: String(raw.id),
    type,
    name: raw.name ?? String(raw.id),
    description: raw.description ?? '',
    severity,
    enabled: raw.enabled !== false,
    trigger: {
      paths: raw.trigger?.paths ?? [],
      symbols: raw.trigger?.symbols ?? [],
      languages: raw.trigger?.languages ?? []
    },
    examples: raw.examples ?? {}
  }
}

function slugId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function saveRule(projectPath: string, rule: Rule): string {
  const dir = rulesDir(projectPath)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${slugId(rule.id)}.yaml`)
  const content = yaml.dump(
    {
      id: rule.id,
      type: rule.type,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      enabled: rule.enabled,
      trigger: rule.trigger,
      ...(rule.examples && (rule.examples.bad || rule.examples.good) ? { examples: rule.examples } : {})
    },
    { lineWidth: 120, noRefs: true }
  )
  fs.writeFileSync(file, content, 'utf8')
  return path.join(RULES_DIR, path.basename(file))
}

export function deleteRule(projectPath: string, id: string): boolean {
  const file = path.join(rulesDir(projectPath), `${slugId(id)}.yaml`)
  if (fs.existsSync(file)) {
    fs.unlinkSync(file)
    return true
  }
  return false
}

/** 触发器匹配：返回 (a) 注入 AI 上下文的规则，与 确定性命中（symbols 出现在新增行） */
export function matchRulesForFile(rules: Rule[], df: DiffFile): { contextRules: Rule[]; hardHits: RuleMatch[] } {
  const lang = langOf(df.path)
  const pathMatchers = (r: Rule) => (r.trigger.paths ?? []).map(globToRegex)
  const added = addedLinesOf(df)
  const contextRules: Rule[] = []
  const hardHits: RuleMatch[] = []

  for (const r of rules) {
    if (!r.enabled) continue
    const pathMatched = (r.trigger.paths ?? []).some((g) => globToRegex(g).test(df.path))
    const langMatched = (r.trigger.languages ?? []).some((l) => l === lang)
    const hasTrigger = (r.trigger.paths?.length ?? 0) + (r.trigger.languages?.length ?? 0) + (r.trigger.symbols?.length ?? 0) > 0

    // symbols 确定性命中
    const symLines: number[] = []
    for (const sym of r.trigger.symbols ?? []) {
      const re = new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      for (const al of added) {
        if (re.test(al.content)) symLines.push(al.line)
      }
    }
    if (symLines.length > 0) {
      hardHits.push({
        rule: r,
        reason: `新增代码命中触发器符号 ${JSON.stringify(r.trigger.symbols)}（bad_case 必须修 / 规则需确认）`,
        lines: [...new Set(symLines)]
      })
      contextRules.push(r)
      continue
    }

    // path/language 匹配 → 作为该文件的强相关上下文；无任何 trigger 的规则作为通用规则
    if (pathMatched || langMatched || !hasTrigger) {
      contextRules.push(r)
    }
  }
  return { contextRules: [...new Set(contextRules)], hardHits }
}

/** 解析一段 diff 文本用于规则匹配（修复 diff 也走同一套） */
export function filesFromDiffText(text: string): DiffFile[] {
  return parseUnifiedDiff(text)
}
