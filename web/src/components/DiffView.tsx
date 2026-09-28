import { Fragment, useEffect, useState } from 'react'
import type { DiffFile, Issue } from '../types'
import IssueCard from './IssueCard'
import type { Rule } from '../types'

/** diff 视图：按文件渲染，问题行内嵌评论卡片 */

export interface DiffViewProps {
  files: DiffFile[]
  issues: Issue[]
  rules: Rule[]
  selectedIds: Set<number>
  onToggleSelect: (id: number) => void
  onIssueStatus: (id: number, status: string, reason?: string) => void
  collapsed: boolean
  /** 外部要求定位的文件+行（问题列表跳转用），传新对象触发一次定位 */
  focus?: { file: string; line: number | null; seq: number } | null
  /** 沉淀为规则入口（透传给 IssueCard） */
  onSaveRule?: (issue: Issue) => void
}

const STATUS_LABEL: Record<DiffFile['status'], { text: string; cls: string }> = {
  added: { text: '新增', cls: 'bg-emerald-100 text-emerald-700' },
  deleted: { text: '删除', cls: 'bg-red-100 text-red-700' },
  modified: { text: '修改', cls: 'bg-sky-100 text-sky-700' },
  renamed: { text: '重命名', cls: 'bg-zinc-100 text-zinc-600' }
}

function lineAnchorId(path: string, line: number): string {
  return `dl-${encodeURIComponent(path)}:${line}`
}

export default function DiffView(props: DiffViewProps) {
  return (
    <div className="grid gap-4">
      {props.files.map((f) => (
        <FileDiff key={f.path} file={f} {...props} />
      ))}
    </div>
  )
}

function FileDiff({
  file,
  issues,
  rules,
  selectedIds,
  onToggleSelect,
  onIssueStatus,
  collapsed,
  focus,
  onSaveRule
}: DiffViewProps & { file: DiffFile }) {
  const [open, setOpen] = useState(!collapsed)
  const [expandedLines, setExpandedLines] = useState<Set<string>>(() => {
    // 默认展开所有问题行
    const s = new Set<string>()
    for (const it of issues) {
      if (it.file_path !== file.path) continue
      if (it.status !== 'open') continue
      s.add(issueKey(it))
    }
    return s
  })

  // 外部定位（问题列表跳转）：展开文件与对应问题行，滚动到行
  useEffect(() => {
    if (!focus || focus.file !== file.path) return
    setOpen(true)
    if (focus.line != null) {
      setExpandedLines((prev) => new Set(prev).add(`${file.path}:${focus.line}`))
    }
    const t = setTimeout(() => {
      const el = focus.line != null ? document.getElementById(lineAnchorId(file.path, focus.line)) : null
      const target = el ?? document.getElementById(`df-${encodeURIComponent(file.path)}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    return () => clearTimeout(t)
  }, [focus, file.path])

  const fileIssues = issues.filter((i) => i.file_path === file.path)
  const byLine = new Map<string, Issue[]>()
  for (const it of fileIssues) {
    const k = issueKey(it)
    const arr = byLine.get(k) ?? []
    arr.push(it)
    byLine.set(k, arr)
  }
  const st = STATUS_LABEL[file.status] ?? { text: file.status, cls: 'bg-zinc-100' }
  const openCount = fileIssues.filter((i) => i.status === 'open').length

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white" id={`df-${encodeURIComponent(file.path)}`}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 border-b border-zinc-100 bg-zinc-50/60 px-4 py-2.5 text-left hover:bg-zinc-50"
      >
        <span className={`transition-transform text-zinc-400 ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="font-mono text-sm font-medium text-zinc-800">{file.path}</span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${st.cls}`}>{st.text}</span>
        <span className="text-xs">
          <span className="text-emerald-600">+{file.additions}</span>{' '}
          <span className="text-red-500">−{file.deletions}</span>
        </span>
        {openCount > 0 && (
          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
            {openCount} 个待处理问题
          </span>
        )}
        {file.exempt && (
          <span
            className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-500"
            title={file.exemptReason ?? '已豁免：不评审、不报问题'}
          >
            🛡 已豁免
          </span>
        )}
        {file.isBinary && <span className="text-xs text-zinc-400">二进制文件</span>}
      </button>

      {open && !file.isBinary && (
        <div className={`overflow-x-auto ${file.exempt ? 'opacity-60' : ''}`}>
          {file.hunks.map((h, hi) => (
            <div key={hi} className={hi > 0 ? 'border-t border-dashed border-zinc-200' : ''}>
              <div className="bg-sky-50/60 px-4 py-1 font-mono text-xs text-zinc-500">{h.header}</div>
              <table className="w-full border-collapse font-mono text-xs leading-5">
                <tbody>
                  {h.lines.map((l, li) => {
                    const key =
                      l.newLine != null ? `${file.path}:${l.newLine}` : `${file.path}:o${l.oldLine ?? li}`
                    const lineIssues = byLine.get(key) ?? []
                    const hasIssue = lineIssues.length > 0
                    const expanded = expandedLines.has(key)
                    return (
                      <Fragment key={`${hi}-${li}`}>
                        <tr
                          id={l.newLine != null ? lineAnchorId(file.path, l.newLine) : undefined}
                          onClick={() => hasIssue && toggleExpand(expandedLines, setExpandedLines, key)}
                          className={`${l.type === 'add' ? 'diff-add' : ''} ${l.type === 'del' ? 'diff-del' : ''} ${
                            hasIssue ? 'cursor-pointer' : ''
                          }`}
                        >
                          <td className="w-12 select-none border-r border-zinc-100 px-2 text-right text-zinc-300">
                            {l.oldLine ?? ''}
                          </td>
                          <td className="w-12 select-none border-r border-zinc-100 px-2 text-right text-zinc-300">
                            {l.newLine ?? ''}
                          </td>
                          <td className="w-5 select-none text-center">
                            {l.type === 'add' ? <span className="diff-add-marker">+</span> : l.type === 'del' ? <span className="diff-del-marker">−</span> : null}
                          </td>
                          <td className="whitespace-pre-wrap break-all px-3 text-zinc-800">
                            {l.type === 'meta' ? <span className="text-zinc-400 italic">{l.content}</span> : l.content || ' '}
                            {hasIssue && (
                              <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 align-middle font-sans text-[10px] font-medium text-amber-700">
                                ⚠ {lineIssues.filter((i) => i.status === 'open').length || lineIssues.length}
                              </span>
                            )}
                          </td>
                        </tr>
                        {expanded &&
                          lineIssues.map((it) => (
                            <tr key={`issue-${it.id}`} className="bg-white">
                              <td colSpan={4} className="border-y border-amber-200 bg-amber-50/50 px-4 py-3">
                                <IssueCard
                                  issue={it}
                                  rules={rules}
                                  selected={selectedIds.has(it.id)}
                                  onToggleSelect={() => onToggleSelect(it.id)}
                                  onStatus={(s, reason) => onIssueStatus(it.id, s, reason)}
                                  onSaveRule={onSaveRule}
                                />
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
          {file.hunks.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-zinc-400">
              {file.isBinary ? '二进制文件，无文本 diff' : '无变更内容'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function toggleExpand(cur: Set<string>, set: (s: Set<string>) => void, key: string) {
  const next = new Set(cur)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  set(next)
}

function issueKey(it: Issue): string {
  return it.line_new != null ? `${it.file_path}:${it.line_new}` : `${it.file_path}:o${it.line_old ?? '?'}`
}
