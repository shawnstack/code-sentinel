import { spawn } from 'node:child_process'
import path from 'node:path'

export interface GitCommit {
  hash: string
  short: string
  author: string
  email: string
  date: string
  subject: string
}

export interface BlameInfo {
  hash: string
  author: string
  date: string
  summary: string
}

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

/** 执行 git 命令（统一 -C repo），失败抛 GitError */
export function git(
  repo: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...args], { timeout: opts.timeoutMs ?? 120_000 })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new GitError(`git ${args.join(' ')} 失败: ${err.trim().slice(0, 500)}`))
    })
    child.on('error', (e) => reject(new GitError(`git 启动失败: ${e.message}`)))
  })
}

/** 校验相对路径不逃逸仓库 */
export function safeRepoPath(repo: string, relPath: string): string {
  const abs = path.resolve(repo, relPath)
  if (abs !== path.resolve(repo) && !abs.startsWith(path.resolve(repo) + path.sep)) {
    throw new GitError(`非法路径: ${relPath}`)
  }
  return abs
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const r = await git(dir, ['rev-parse', '--is-inside-work-tree'])
    return r.trim() === 'true'
  } catch {
    return false
  }
}

export async function repoRoot(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

export async function revParse(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  } catch {
    return null
  }
}

export interface BranchInfo {
  name: string
  sha: string
  isCurrent: boolean
}

export async function listBranches(repo: string): Promise<BranchInfo[]> {
  const text = await git(repo, ['branch', '--format=%(HEAD)%00%(refname:short)%00%(objectname:short)'])
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [head, name, sha] = l.split('\0')
      return { name, sha, isCurrent: head === '*' }
    })
}

const LOG_FMT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s'

function parseLog(text: string): GitCommit[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [hash, short, author, email, date, subject] = l.split('\x1f')
      return { hash, short, author, email, date, subject }
    })
}

export async function log(repo: string, opts: { max?: number; ref?: string; file?: string } = {}): Promise<GitCommit[]> {
  const args = ['log', `--pretty=format:${LOG_FMT}`, `-n`, String(opts.max ?? 50)]
  if (opts.ref) args.push(opts.ref)
  if (opts.file) args.push('--', opts.file)
  return parseLog(await git(repo, args))
}

/** 列出 (from, to] 范围内的提交 */
export async function logRange(repo: string, from: string, to: string, max = 200): Promise<GitCommit[]> {
  const args = ['log', `--pretty=format:${LOG_FMT}`, '-n', String(max), `${from}..${to}`]
  return parseLog(await git(repo, args))
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return (await git(repo, ['merge-base', a, b])).trim()
}

/** unified diff 文本。mode: branch=三点(merge-base)；commits=两点；workdir=工作区 */
export async function diffText(
  repo: string,
  mode: 'branch' | 'commits' | 'workdir',
  refs: { base?: string; head?: string },
  opts: { contextLines?: number } = {}
): Promise<string> {
  const args = ['diff', '--no-color', '--no-ext-diff', '-M', `-U${opts.contextLines ?? 3}`]
  if (mode === 'branch') args.push(`${refs.base}...${refs.head}`)
  else if (mode === 'commits') args.push(`${refs.base}..${refs.head}`)
  else args.push('HEAD') // 工作区 vs HEAD（含已暂存）
  return git(repo, args)
}

export interface StatusEntry {
  path: string
  index: string
  workdir: string
}

export async function status(repo: string): Promise<StatusEntry[]> {
  const text = await git(repo, ['status', '--porcelain=v1', '-z'])
  const out: StatusEntry[] = []
  const parts = text.split('\0').filter((p) => p.length > 0)
  for (const p of parts) {
    const index = p.slice(0, 1)
    const workdir = p.slice(1, 2)
    let file = p.slice(3)
    out.push({ path: file, index, workdir })
  }
  return out
}

export async function isClean(repo: string): Promise<boolean> {
  return (await status(repo)).length === 0
}

/** 读取指定 ref（null=工作区）下的文件内容。文件不存在返回 null */
export async function readFileAt(repo: string, ref: string | null, file: string): Promise<string | null> {
  try {
    if (ref === null) {
      const { readFile } = await import('node:fs/promises')
      return await readFile(safeRepoPath(repo, file), 'utf8')
    }
    return await git(repo, ['show', `${ref}:${file}`], { timeoutMs: 30_000 })
  } catch {
    return null
  }
}

/** git blame（porcelain）。ref=null 时 blame 工作区版本；新文件失败返回空 Map */
export async function blame(
  repo: string,
  ref: string | null,
  file: string
): Promise<Map<number, BlameInfo>> {
  const args = ['blame', '--porcelain', '-w', '-M']
  if (ref) args.push(ref, '--')
  else args.push('--')
  args.push(file)
  let text: string
  try {
    text = await git(repo, args)
  } catch {
    return new Map()
  }
  const metaByHash = new Map<string, { author: string; date: string; summary: string }>()
  let current: { hash: string; final: number } | null = null
  const result = new Map<number, BlameInfo>()
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) {
      if (current) {
        const meta = metaByHash.get(current.hash)
        result.set(current.final, {
          hash: current.hash,
          author: meta?.author ?? 'unknown',
          date: meta?.date ?? '',
          summary: meta?.summary ?? ''
        })
        current = null
      }
      continue
    }
    const header = line.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/)
    if (header) {
      current = { hash: header[1], final: Number(header[3]) }
      continue
    }
    const am = line.match(/^author (.*)$/)
    if (am && current) {
      const meta = metaByHash.get(current.hash) ?? { author: '', date: '', summary: '' }
      meta.author = am[1]
      metaByHash.set(current.hash, meta)
      continue
    }
    const tm = line.match(/^author-time (\d+)$/)
    if (tm && current) {
      const meta = metaByHash.get(current.hash) ?? { author: '', date: '', summary: '' }
      meta.date = new Date(Number(tm[1]) * 1000).toISOString()
      metaByHash.set(current.hash, meta)
      continue
    }
    const sm = line.match(/^summary (.*)$/)
    if (sm && current) {
      const meta = metaByHash.get(current.hash) ?? { author: '', date: '', summary: '' }
      meta.summary = sm[1]
      metaByHash.set(current.hash, meta)
    }
  }
  return result
}

// ---- 分支 / 提交 / 合并（AI 修复用） ----

export async function createBranch(repo: string, name: string, fromRef?: string): Promise<void> {
  const args = ['checkout', '-b', name]
  if (fromRef) args.push(fromRef)
  await git(repo, args)
}

export async function checkout(repo: string, ref: string): Promise<void> {
  await git(repo, ['checkout', ref])
}

export async function commitFiles(repo: string, message: string): Promise<string> {
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', message, '--no-verify', '--allow-empty'])
  return (await git(repo, ['rev-parse', 'HEAD'])).trim()
}

/** 将 source 合并进当前所在分支 */
export async function mergeIntoCurrent(repo: string, source: string): Promise<void> {
  await git(repo, ['merge', '--no-edit', source])
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

export async function deleteBranch(repo: string, name: string, force = true): Promise<void> {
  await git(repo, ['branch', force ? '-D' : '-d', name])
}

/** 工作区撤销指定文件的修改（未 add 的改动） */
export async function discardFiles(repo: string, files: string[]): Promise<void> {
  for (const f of files) {
    try {
      await git(repo, ['checkout', '--', f])
    } catch {
      // 新增未跟踪文件 checkout 失败时直接删除
      try {
        const abs = safeRepoPath(repo, f)
        await import('node:fs/promises').then((m) => m.unlink(abs))
      } catch {
        /* ignore */
      }
    }
  }
}
