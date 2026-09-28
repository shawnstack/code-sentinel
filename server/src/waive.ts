import crypto from 'node:crypto'
import { db } from './db.js'

/**
 * 问题豁免（waiver）：wont_fix 跨扫描持久化。
 * 指纹设计（不含行号，避免代码增删行后失配）：
 * - rule_match：r:<file>:<排序后的 rule_ids>
 * - ai_found：a:<file>:<title 规范化>
 */

export interface WaiverRow {
  id: number
  project_id: number
  fingerprint: string
  file_path: string
  title: string
  reason: string | null
  created_at: string
}

export function issueFingerprint(
  file: string,
  source: 'rule_match' | 'ai_found',
  ruleIds: string[] | null,
  title: string
): string {
  if (source === 'rule_match' && ruleIds?.length) {
    return `r:${file}:${[...ruleIds].sort().join(',')}`
  }
  return `a:${file}:${title.trim()}`
}

/** 该指纹是否已被豁免 */
export function isWaived(projectId: number, fingerprint: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM issue_waivers WHERE project_id = ? AND fingerprint = ?')
    .get(projectId, fingerprint)
}

/** 记录豁免（已存在则忽略） */
export function addWaiver(
  projectId: number,
  fingerprint: string,
  filePath: string,
  title: string,
  reason?: string | null
): void {
  db.prepare(
    `INSERT OR IGNORE INTO issue_waivers (project_id, fingerprint, file_path, title, reason)
     VALUES (?, ?, ?, ?, ?)`
  ).run(projectId, fingerprint, filePath, title, reason ?? null)
}

/** 撤销豁免（问题重新打开时） */
export function removeWaiver(projectId: number, fingerprint: string): void {
  db.prepare('DELETE FROM issue_waivers WHERE project_id = ? AND fingerprint = ?').run(projectId, fingerprint)
}

export function listWaivers(projectId: number): WaiverRow[] {
  return db
    .prepare('SELECT * FROM issue_waivers WHERE project_id = ? ORDER BY id DESC')
    .all(projectId) as WaiverRow[]
}

export function fingerprintOfRow(row: { file_path: string; source: string; rule_ids: string | null; title: string }): string {
  let ruleIds: string[] | null = null
  if (row.rule_ids) {
    try {
      ruleIds = JSON.parse(row.rule_ids) as string[]
    } catch {
      ruleIds = null
    }
  }
  return issueFingerprint(row.file_path, row.source === 'rule_match' ? 'rule_match' : 'ai_found', ruleIds, row.title)
}

/** 行内豁免注释标记（支持 // # -- ; 等任意注释风格的子串匹配） */
export const IGNORE_MARK = 'codescan-ignore'
export const IGNORE_RE = /codescan-ignore/

export function hashOf(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
}
