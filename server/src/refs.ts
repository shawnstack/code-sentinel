import { git } from './git.js'

/** 引用分析：找出变更文件导出的符号，以及全仓库对这些符号的引用位置 */

export interface RefHit {
  symbol: string
  file: string
  line: number
  snippet: string
}

export interface RefAnalysis {
  exports: string[]
  hits: RefHit[]
  truncated: boolean
}

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.codescan',
  '.trash'
])

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.m', '.mm',
  '.cs', '.swift', '.scala', '.sh', '.bash', '.zsh',
  '.vue', '.svelte', '.astro', '.html', '.css', '.scss', '.less',
  '.json', '.yaml', '.yml', '.toml', '.md', '.sql', '.graphql', '.prisma'
])

export function isTextFile(p: string): boolean {
  const dot = p.lastIndexOf('.')
  if (dot === -1) return false
  return TEXT_EXT.has(p.slice(dot).toLowerCase())
}

/** 遍历仓库文本文件（限制数量，防超大仓库） */
export async function listTextFiles(repo: string, max = 8000): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const path = await import('node:path')
  const out: string[] = []

  async function walk(dir: string) {
    if (out.length >= max) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= max) return
      if (e.name.startsWith('.') && e.name !== '.github') {
        if (e.name === '.github') {
          // 保留 .github
        } else continue
      }
      if (IGNORE_DIRS.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile() && isTextFile(e.name)) out.push(path.relative(repo, abs))
    }
  }
  await walk(repo)
  return out
}

/** 提取文件的导出符号（启发式，覆盖主流语言） */
export function extractExports(relPath: string, content: string): string[] {
  const syms = new Set<string>()
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase()

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext)) {
    const named = content.matchAll(
      /export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\s*\*?|class|type|interface|enum|declare\s+\w+)\s+([A-Za-z_$][\w$]*)/g
    )
    for (const m of named) syms.add(m[1])
    const braces = content.matchAll(/export\s*\{([^}]+)\}/g)
    for (const m of braces) {
      for (const part of m[1].split(',')) {
        const seg = part.trim()
        if (!seg) continue
        const name = seg.split(/\s+as\s+/).pop()!.trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) syms.add(name)
      }
    }
    const def = content.match(/export\s+default\s+(?:async\s+)?(?:function\s*?\*?\s+)?([A-Za-z_$][\w$]*)/)
    if (def) syms.add(def[1])
    const me = content.match(/module\.exports\s*=\s*(?:async\s+)?(?:function\s*?\*?\s+)?([A-Za-z_$][\w$]*)/)
    if (me) syms.add(me[1])
  } else if (ext === 'py') {
    for (const m of content.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) syms.add(m[1])
    for (const m of content.matchAll(/^class\s+([A-Za-z_]\w*)/gm)) syms.add(m[1])
  } else if (ext === 'go') {
    for (const m of content.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm)) syms.add(m[1])
    for (const m of content.matchAll(/^type\s+([A-Za-z_]\w*)/gm)) syms.add(m[1])
  } else if (ext === 'rs') {
    for (const m of content.matchAll(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm
    )) syms.add(m[1])
  }

  // 过滤太通用的名字，避免引用爆炸
  const GENERIC = new Set(['default', 'main', 'index', 'App', 'config', 'utils', 'types'])
  return [...syms].filter((s) => !GENERIC.has(s) && s.length > 2).slice(0, 30)
}

/** 在指定 ref（null=工作区）下搜索符号引用，排除定义文件自身 */
export async function findReferences(
  repo: string,
  ref: string | null,
  symbols: string[],
  excludeFiles: string[],
  limit = 60
): Promise<RefAnalysis> {
  const result: RefAnalysis = { exports: symbols, hits: [], truncated: false }
  if (symbols.length === 0) return result

  const args = ['-nI', '--max-count', '8']
  if (ref) args.push(ref)
  for (const s of symbols.slice(0, 12)) {
    // 词边界匹配，减少误报
    args.push('-e', `\\b${escapeRe(s)}\\b`)
  }
  try {
    const text = await git(repo, ['grep', ...args], { timeoutMs: 30_000 })
    const exclude = new Set(excludeFiles)
    for (const line of text.split('\n')) {
      if (result.hits.length >= limit) {
        result.truncated = true
        break
      }
      // 格式: [ref:]file:line:content（带 ref 时前缀 ref:）
      const m = line.match(/^(?:\S+?:)?(.+?):(\d+):(.*)$/)
      if (!m) continue
      const [, file, ln, content] = m
      if (exclude.has(file)) continue
      const matched = symbols.find((s) => new RegExp(`\\b${escapeRe(s)}\\b`).test(content))
      if (!matched) continue
      result.hits.push({ symbol: matched, file, line: Number(ln), snippet: content.trim().slice(0, 200) })
    }
  } catch {
    // git grep 无匹配时退出码为 1，忽略
  }
  return result
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
