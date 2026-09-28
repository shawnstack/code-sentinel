import { parseJson } from './db.js'

/**
 * 项目级扫描配置：
 * - include：限定扫描范围（留空 = 全部）
 * - exclude：完全排除（不出现在扫描结果里）
 * - allowlist：白名单豁免（diff 中显示并标记，但不做规则触发、不调 AI、不产生问题）
 * - maxFiles：单次扫描参与 AI 评审的文件数上限（超出的文件保留 diff 但不评审）
 *
 * glob 语义（自研，无第三方依赖）：
 * - 不含 `/` 且含通配符（* ?）的模式匹配任意目录层级的文件名，如 `*.min.js`、`*.snap`
 * - 不含 `/` 且不含通配符的模式视为仓库根下的文件或目录前缀，如 `readme.md`、`src`
 * - 含 `/` 的模式从仓库根匹配，`**` 跨任意层级，`*` 单段内通配，`?` 单字符
 * - 目录前缀：`src` 或 `src/` 等价于 `src/**`（匹配其下所有文件）
 */

export interface NotifyConfig {
  enabled: boolean
  url: string      // ntfy 服务器地址
  topic: string    // 推送主题
}

export interface ScanConfig {
  include: string[]
  exclude: string[]
  allowlist: string[]
  maxFiles: number
  notify: NotifyConfig
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  include: [],
  exclude: [],
  allowlist: [],
  maxFiles: 40,
  notify: { enabled: false, url: 'http://localhost:8090', topic: 'code-sentinel' }
}

export type PathClass = 'excluded' | 'allowlisted' | 'scan'

/** 容错解析数据库中存的配置 JSON */
export function parseScanConfig(raw: string | null | undefined): ScanConfig {
  return normalizeScanConfig(parseJson<Partial<ScanConfig>>(raw, {}))
}

/** 校验并归一化外部输入（API PUT / 默认值兜底），支持 # 开头注释行 */
export function normalizeScanConfig(input: unknown): ScanConfig {
  const o = (input ?? {}) as Partial<ScanConfig>
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter((x) => x && !x.startsWith('#'))
      : []
  const maxFiles = Number(o.maxFiles)
  const n = (o.notify ?? {}) as Partial<NotifyConfig>
  return {
    include: arr(o.include),
    exclude: arr(o.exclude),
    allowlist: arr(o.allowlist),
    maxFiles: Number.isFinite(maxFiles) ? Math.min(200, Math.max(1, Math.floor(maxFiles))) : DEFAULT_SCAN_CONFIG.maxFiles,
    notify: {
      enabled: n.enabled === true,
      url: (n.url || DEFAULT_SCAN_CONFIG.notify.url).replace(/\/+$/, ''),
      topic: (n.topic || DEFAULT_SCAN_CONFIG.notify.topic).replace(/[^a-zA-Z0-9_-]/g, '-')
    }
  }
}

function segRegex(s: string): string {
  return s
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
}

export function globToRegex(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\/+/, '')
  if (!p) return /$^/ // 空模式永不匹配
  if (!p.includes('/')) {
    // 含通配符且不含 / → 匹配任意目录层级的文件名（basename）
    if (/[*?]/.test(p)) return new RegExp(`(?:^|/)${segRegex(p)}$`)
    // 无通配且不含 / → 仓库根下的文件或目录前缀
    return new RegExp(`^${segRegex(p)}(?:/.+)?$`)
  }
  if (p.endsWith('/')) p += '**'
  const segs = p.split('/')
  const last = segs[segs.length - 1]
  const lastIsGlob = /[*?]/.test(last)
  let re = '^'
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s === '**') {
      re += i === segs.length - 1 ? '.*' : '(?:[^/]+/)*'
      continue
    }
    if (i === segs.length - 1) {
      re += segRegex(s)
      // 目录前缀语义：`src` 同时匹配 `src` 与其下所有文件
      if (!lastIsGlob) re += '(?:/.+)?'
    } else {
      re += segRegex(s) + '/'
    }
  }
  return new RegExp(re + '$')
}

export function makeMatcher(patterns: string[]): (p: string) => boolean {
  const res = patterns.map(globToRegex)
  return (p) => res.some((r) => r.test(p))
}

/** 对单个文件路径应用配置，返回处置类别（优先级：include 圈定 → exclude → allowlist） */
export function classifyPath(config: ScanConfig, filePath: string): PathClass {
  if (config.include.length > 0 && !makeMatcher(config.include)(filePath)) return 'excluded'
  if (config.exclude.length > 0 && makeMatcher(config.exclude)(filePath)) return 'excluded'
  if (config.allowlist.length > 0 && makeMatcher(config.allowlist)(filePath)) return 'allowlisted'
  return 'scan'
}

/** 配置摘要（前端展示用） */
export function configSummary(c: ScanConfig): string {
  const parts: string[] = []
  parts.push(c.include.length ? `范围 ${c.include.join(', ')}` : '范围：全部文件')
  if (c.exclude.length) parts.push(`排除 ${c.exclude.length} 项`)
  if (c.allowlist.length) parts.push(`豁免 ${c.allowlist.length} 项`)
  parts.push(`上限 ${c.maxFiles} 文件`)
  return parts.join(' · ')
}
