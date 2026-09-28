import { useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router'
import { apiGet, apiPost, errMessage } from '../api'
import type { DiffFile, FixTask } from '../types'
import { timeAgo } from '../severity'
import { Empty, ErrorText, Spinner, StatusBadge } from '../components/ui'
import DiffView from '../components/DiffView'
import type { ProjectCtx } from './ProjectLayout'

interface FixRow extends FixTask {
  scan_title: string | null
}

export default function Fixes() {
  const { id } = useParams()
  const { refreshInfo } = useOutletContext<ProjectCtx>()
  const [params] = useSearchParams()
  const [rows, setRows] = useState<FixRow[] | null>(null)
  const [expanded, setExpanded] = useState<number | null>(() => {
    const f = params.get('focus')
    return f ? Number(f) : null
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => apiGet<FixRow[]>(`/api/projects/${id}/fixes`).then(setRows).catch((e) => setError(errMessage(e)))
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const running = rows?.some((r) => r.status === 'running' || r.status === 'pending')
  useEffect(() => {
    if (running) {
      const t = setInterval(load, 2000)
      return () => clearInterval(t)
    }
  }, [running])

  const act = async (fixId: number, action: 'merge' | 'discard') => {
    const r = rows?.find((x) => x.id === fixId)
    const msg =
      action === 'merge'
        ? `合并修复分支 ${r?.branch} 到 ${r?.base_branch}？`
        : `丢弃修复${r?.branch ? `（删除分支 ${r.branch}）` : '（从快照恢复工作区文件）'}？`
    if (!confirm(msg)) return
    setBusy(true)
    setError('')
    try {
      await apiPost(`/api/fixes/${fixId}/${action}`)
      await load()
      refreshInfo()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-zinc-700">修复任务</h2>
        <span className="text-xs text-zinc-400">AI 修复走独立 fix 分支，由你决定合并或丢弃</span>
      </div>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {rows === null ? (
        <div className="py-12 text-center"><Spinner className="mx-auto" /></div>
      ) : rows.length === 0 ? (
        <Empty>
          暂无修复任务。在 <Link to={`/p/${id}/scan/`.replace(/\/$/, '')} className="text-blue-600 underline">扫描评审</Link>{' '}
          页勾选问题后点「AI 修复」创建
        </Empty>
      ) : (
        <div className="grid gap-3">
          {rows.map((r) => (
            <FixItem
              key={r.id}
              row={r}
              expanded={expanded === r.id}
              onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
              busy={busy}
              onAct={act}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FixItem({
  row,
  expanded,
  onToggle,
  busy,
  onAct
}: {
  row: FixRow
  expanded: boolean
  onToggle: () => void
  busy: boolean
  onAct: (id: number, action: 'merge' | 'discard') => void
}) {
  const files: DiffFile[] = useMemo(() => {
    if (!row.result_diff) return []
    try {
      return JSON.parse(row.result_diff) as DiffFile[]
    } catch {
      return []
    }
  }, [row.result_diff])

  const issueIds: number[] = useMemo(() => {
    try {
      return JSON.parse(row.issue_ids)
    } catch {
      return []
    }
  }, [row.issue_ids])

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50">
        <span className={`text-zinc-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
        <span className="font-medium text-zinc-800">任务 #{row.id}</span>
        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{issueIds.length} 个问题</span>
        {(row.status === 'running' || row.status === 'pending') && <Spinner className="h-3.5 w-3.5" />}
        <StatusBadge status={row.status} />
        {row.branch && <span className="font-mono text-xs text-zinc-500">{row.branch}</span>}
        {row.scan_title && <span className="truncate font-mono text-xs text-zinc-400">扫描：{row.scan_title}</span>}
        <span className="ml-auto text-xs text-zinc-400">{timeAgo(row.created_at)}</span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-100 p-4">
          {/* 操作按钮 */}
          {row.status === 'done' && (
            <div className="mb-4 flex items-center gap-2">
              <button
                onClick={() => onAct(row.id, 'merge')}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                ✓ 合并到 {row.base_branch ?? '原分支'}
              </button>
              <button
                onClick={() => onAct(row.id, 'discard')}
                disabled={busy}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:border-red-300 hover:text-red-600 disabled:opacity-50"
              >
                丢弃
              </button>
              <span className="text-xs text-zinc-400">
                {row.commit_sha ? `修复提交 ${row.commit_sha.slice(0, 8)}` : '工作区直接修改'}
              </span>
            </div>
          )}

          {/* 日志 */}
          {row.log && (
            <pre className="mb-4 max-h-48 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-5 text-zinc-600">
              {row.log}
            </pre>
          )}

          {/* 修复 diff */}
          {files.length > 0 ? (
            <DiffView
              files={files}
              issues={[]}
              rules={[]}
              selectedIds={new Set()}
              onToggleSelect={() => undefined}
              onIssueStatus={() => undefined}
              collapsed
            />
          ) : (
            <div className="py-6 text-center text-xs text-zinc-400">
              {row.status === 'done' || row.status === 'failed' ? '没有产生任何修改' : '执行中…'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
