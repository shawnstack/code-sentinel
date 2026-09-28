// 与 server 侧结构对齐的类型定义

export interface Project {
  id: number
  name: string
  path: string
  created_at: string
  scan_count?: number
  last_scan_at?: string | null
}

export interface BranchInfo {
  name: string
  sha: string
  isCurrent: boolean
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  email: string
  date: string
  subject: string
}

export type ScanType = 'branch' | 'commits' | 'workdir'
export type ScanStatus = 'pending' | 'running' | 'done' | 'error' | 'canceled'
export type Severity = 'bug' | 'major' | 'important' | 'minor' | 'style'
export type IssueSource = 'rule_match' | 'ai_found'
export type IssueStatus = 'open' | 'resolved' | 'wont_fix'

/** 逐文件实时进度（stats.progress 元素） */
export interface FileProgress {
  file: string
  state: 'running' | 'done' | 'error' | 'canceled' | 'exempt'
  ms?: number
  issues?: number
  note?: string
}

export interface ScanStats {
  total?: number
  done?: number
  files?: number
  additions?: number
  deletions?: number
  issues?: number
  aiErrors?: string[]
  rules?: number
  durationMs?: number
  progress?: FileProgress[]
  excluded?: number
  exempted?: number
  canceled?: boolean
}

export interface ScanConfig {
  include: string[]
  exclude: string[]
  allowlist: string[]
  maxFiles: number
}

export interface ScanListItem {
  id: number
  type: ScanType
  base_ref: string | null
  head_ref: string | null
  title: string
  status: ScanStatus
  stats: string | null
  error: string | null
  created_at: string
  finished_at: string | null
  issue_count: number
}

export interface Scan {
  id: number
  project_id: number
  type: ScanType
  base_ref: string | null
  head_ref: string | null
  title: string
  status: ScanStatus
  stats: string | null
  diff: string | null
  error: string | null
  created_at: string
  finished_at: string | null
}

export interface Issue {
  id: number
  scan_id: number
  file_path: string
  line_new: number | null
  line_old?: number | null
  severity: Severity
  title: string
  description: string
  suggestion: string | null
  rule_ids: string | null
  source: IssueSource
  author: string | null
  blame_date: string | null
  status: IssueStatus
  confidence: string | null
  created_at: string
}

export interface FixTask {
  id: number
  scan_id: number
  project_id: number
  branch: string | null
  base_branch: string | null
  issue_ids: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'merged' | 'discarded'
  commit_sha: string | null
  log: string | null
  result_diff: string | null
  created_at: string
  finished_at: string | null
}

// diff 结构（server parseUnifiedDiff 输出）
export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'meta'
  oldLine: number | null
  newLine: number | null
  content: string
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  hunks: DiffHunk[]
  additions: number
  deletions: number
  isBinary: boolean
  exempt?: boolean
  exemptReason?: string
}

export type RuleType = 'bad_case' | 'good_case' | 'rule'

export interface Rule {
  id: string
  type: RuleType
  name: string
  description: string
  severity: Severity
  enabled: boolean
  trigger: { paths?: string[]; symbols?: string[]; languages?: string[] }
  examples?: { bad?: string; good?: string }
}

export interface AiProvider {
  id: number
  name: string
  base_url: string
  api_key: string
  model: string
  is_active: number
}

export interface ProjectInfo {
  currentBranch: string
  branches: BranchInfo[]
  commits: GitCommit[]
  isClean: boolean
  rulesCount: number
}

export interface FileDetail {
  path: string
  content: string
  blame: { line: number; author: string; date: string; summary: string }[]
  exports: string[]
  refs: { exports: string[]; hits: { symbol: string; file: string; line: number; snippet: string }[]; truncated: boolean }
}
