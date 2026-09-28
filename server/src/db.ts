import Database from 'better-sqlite3'
import { DB_PATH, ensureDirs } from './config.js'

ensureDirs()

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,             -- branch | commits | workdir
  base_ref TEXT,
  head_ref TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error | canceled
  stats TEXT,
  diff TEXT,                       -- 扫描时点的 diff 文件结构 JSON（前端展示用，防止后续提交错位）
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  line_new INTEGER,
  line_old INTEGER,
  severity TEXT NOT NULL,         -- bug | major | important | minor | style
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggestion TEXT,
  rule_ids TEXT,                  -- JSON 数组：触犯的 case/rule id
  source TEXT NOT NULL,           -- rule_match | ai_found
  author TEXT,                    -- 该行最后修改作者（git blame）
  blame_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | resolved | wont_fix
  confidence TEXT,                -- AI 置信度 high | medium | low
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id);

CREATE TABLE IF NOT EXISTS fix_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch TEXT,
  base_branch TEXT,
  issue_ids TEXT NOT NULL,        -- JSON 数组
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed | merged | discarded
  commit_sha TEXT,
  log TEXT,                       -- 执行日志（前端展示）
  result_diff TEXT,               -- 修复 diff（fix 分支 vs base）
  snapshot TEXT,                  -- 修复前文件内容快照 JSON（可靠撤销）
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fixes_scan ON fix_tasks(scan_id);

-- 问题豁免记录（wont_fix 跨扫描持久化：指纹匹配的新问题自动带过）
CREATE TABLE IF NOT EXISTS issue_waivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,      -- r:<file>:<rule_ids> | a:<file>:<title>
  file_path TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(project_id, fingerprint)
);
`)

// migration：项目级扫描配置（include / exclude / allowlist / maxFiles）
try {
  db.exec('ALTER TABLE projects ADD COLUMN scan_config TEXT')
} catch {
  /* 列已存在 */
}

export const SEVERITIES = ['bug', 'major', 'important', 'minor', 'style'] as const
export type Severity = (typeof SEVERITIES)[number]

export const SEVERITY_LABEL: Record<string, string> = {
  bug: 'Bug',
  major: '主要',
  important: '重要',
  minor: '轻微',
  style: '代码风格'
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
