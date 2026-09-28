import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { apiGet, apiPatch, apiPost, errMessage } from '../api'
import type { DiffFile, FixTask, Issue, Rule, Scan, ScanStats } from '../types'
import { SEVERITIES, SEVERITY_LABEL, timeAgo } from '../severity'
import { ErrorText, SeverityBadge, Spinner, StatusBadge } from '../components/ui'
import DiffView from '../components/DiffView'
import IssueCard from '../components/IssueCard'

interface ScanDetail {
  scan: Scan
  issues: Issue[]
  fixes: FixTask[]
}

export default function Review() {
  const { id, scanId } = useParams()
  const nav = useNavigate()
  const [detail, setDetail] = useState<ScanDetail | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [error, setError] = useState('')
  const [view, setView] = useState<'list' | 'diff' | null>(null)
  const [selSev, setSelSev] = useState<Set<string>>(new Set())
  const [selSource, setSelSource] = useState<'all' | 'rule_match' | 'ai_found'>('all')
  const [selStatus, setSelStatus] = useState<'open' | 'all'>('open')
  const [search, setSearch] = useState('')
  const [onlyIssueFiles, setOnlyIssueFiles] = useState(true)
  const [selectedFix, setSelectedFix] = useState<Set<number>>(new Set())
  const [fixBusy, setFixBusy] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [focus, setFocus] = useState<{ file: string; line: number | null; seq: number } | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const load = () =>
    apiGet<ScanDetail>(`/api/scans/${scanId}`)
      .then((d) => setDetail(d))
      .catch((e) => setError(errMessage(e)))

  useEffect(() => {
    load()
    apiGet<Rule[]>(`/api/projects/${id}/rules`).then(setRules).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId])

  const running = detail?.scan.status === 'running' || detail?.scan.status === 'pending'

  // 运行中 1s 轮询（实时进度）
  useEffect(() => {
    if (running) {
      const t = setTimeout(load, 1000)
      return () => clearTimeout(t)
    }
  }, [detail, running])

  const files: DiffFile[] = useMemo(() => {
    if (!detail?.scan.diff) return []
    try {
      return JSON.parse(detail.scan.diff) as DiffFile[]
    } catch {
      return []
    }
  }, [detail])

  const issues = detail?.issues ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return issues
      .filter((it) => {
        if (selStatus === 'open' && it.status !== 'open') return false
        if (selSev.size > 0 && !selSev.has(it.severity)) return false
        if (selSource !== 'all' && it.source !== selSource) return false
        if (q) {
          const hay = `${it.title} ${it.description} ${it.file_path} ${it.author ?? ''}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort(
        (a, b) =>
          SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
          a.file_path.localeCompare(b.file_path) ||
          (a.line_new ?? 0) - (b.line_new ?? 0)
      )
  }, [issues, selSev, selSource, selStatus, search])

  const sevCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of issues)
      if (it.status === 'open' && (!search.trim() || `${it.title}${it.file_path}`.toLowerCase().includes(search.trim().toLowerCase())))
        m[it.severity] = (m[it.severity] ?? 0) + 1
    return m
  }, [issues, search])

  const issueFiles = useMemo(() => new Set(filtered.map((i) => i.file_path)), [filtered])
  const shownFiles = onlyIssueFiles ? files.filter((f) => issueFiles.has(f.path)) : files
  const cleanFiles = files.length - shownFiles.length

  const stats: ScanStats | null = detail?.scan.stats ? safeParse(detail.scan.stats) : null

  const toggleSev = (s: string) => {
    const next = new Set(selSev)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setSelSev(next)
  }

  const toggleFixSel = (issueId: number) => {
    const next = new Set(selectedFix)
    if (next.has(issueId)) next.delete(issueId)
    else next.add(issueId)
    setSelectedFix(next)
  }

  const setIssueStatus = async (issueId: number, status: string) => {
    await apiPatch(`/api/issues/${issueId}`, { status }).catch((e) => alert(errMessage(e)))
    load()
  }

  const createFix = async () => {
    if (selectedFix.size === 0) return
    if (!confirm(`对选中的 ${selectedFix.size} 个问题创建 AI 修复任务？\n（分支模式将创建修复分支，完成后由你决定是否合并）`)) return
    setFixBusy(true)
    try {
      const r = await apiPost<{ id: number }>(`/api/scans/${scanId}/fixes`, { issue_ids: [...selectedFix] })
      nav(`/p/${id}/fixes?focus=${r.id}`)
    } catch (e) {
      alert(errMessage(e))
    } finally {
      setFixBusy(false)
    }
  }

  const stopScan = async () => {
    if (!confirm('停止扫描？已完成文件的问题会保留，未开始的文件不再评审。')) return
    setStopBusy(true)
    try {
      await apiPost(`/api/scans/${scanId}/cancel`)
      load()
    } catch (e) {
      alert(errMessage(e))
    } finally {
      setStopBusy(false)
    }
  }

  /** 从问题列表跳转到 diff 对应行 */
  const gotoDiff = (it: Issue) => {
    setView('diff')
    setFocus({ file: it.file_path, line: it.line_new, seq: Date.now() })
  }

  // 进度日志自动滚到底
  useEffect(() => {
    if (logRef.current && running) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [stats?.progress?.length, running])

  if (error) return <ErrorText>{error}</ErrorText>
  if (!detail) return <div className="py-24 text-center"><Spinner className="mx-auto" /></div>

  const { scan } = detail
  const curView: 'list' | 'diff' = view ?? (running ? 'list' : 'diff')
  const progress = stats?.progress ?? []
  const doneCount = stats?.done ?? 0
  const totalCount = stats?.total ?? 0
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0
  const canFix = scan.status === 'done' || scan.status === 'canceled'

  return (
    <div className="pb-20">
      {/* 顶部信息 */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to={`/p/${id}`} className="text-sm text-zinc-400 hover:text-zinc-700">← 扫描列表</Link>
        <h2 className="font-mono text-sm font-medium text-zinc-800">{scan.title}</h2>
        <StatusBadge status={scan.status} />
        <span className="text-xs text-zinc-400">{timeAgo(scan.created_at)}</span>
        {stats?.files != null && (
          <span className="text-xs text-zinc-500">
            {stats.files} 文件 · <span className="text-emerald-600">+{stats.additions ?? 0}</span>{' '}
            <span className="text-red-500">−{stats.deletions ?? 0}</span> · {stats.rules ?? 0} 条规则
            {stats.excluded ? ` · 已排除 ${stats.excluded}` : ''}
            {stats.exempted ? ` · 已豁免 ${stats.exempted}` : ''}
            {stats.durationMs ? ` · ${(stats.durationMs / 1000).toFixed(1)}s` : ''}
          </span>
        )}
        {running && (
          <button
            onClick={stopScan}
            disabled={stopBusy}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
          >
            {stopBusy ? '停止中…' : '■ 停止扫描'}
          </button>
        )}
      </div>

      {scan.status === 'error' && <ErrorText>扫描失败：{scan.error}</ErrorText>}
      {scan.status === 'canceled' && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          扫描已被手动停止：已完成文件的问题保留在下方，可直接浏览 / 创建修复。
        </div>
      )}

      {/* 实时进度面板（运行中展开，结束后收起为摘要） */}
      {(running || scan.status === 'canceled') && stats && (
        <div className="mb-4 overflow-hidden rounded-xl border border-blue-100 bg-white">
          <div className="flex items-center gap-3 border-b border-blue-50 bg-blue-50/40 px-4 py-2.5">
            {running ? (
              <>
                <Spinner className="h-3.5 w-3.5" />
                <span className="text-xs font-medium text-blue-700">
                  AI 评审中 {doneCount}/{totalCount || '?'} · 已发现 {stats.issues ?? 0} 个问题
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-blue-100">
                  <div className="h-full rounded-full bg-blue-500 transition-all duration-500" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs tabular-nums text-blue-500">{pct}%</span>
              </>
            ) : (
              <span className="text-xs text-zinc-500">
                {scan.status === 'canceled' ? '扫描已停止' : '扫描完成'} · 评审 {doneCount}/{totalCount} 文件 · {stats.issues ?? 0} 个问题
                {stats.durationMs ? ` · ${(stats.durationMs / 1000).toFixed(1)}s` : ''}
              </span>
            )}
          </div>
          {progress.length > 0 && (
            <details open={running}>
              <summary className="cursor-pointer select-none px-4 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-600">
                逐文件处理记录（{progress.length}）
              </summary>
              <div ref={logRef} className="max-h-56 overflow-y-auto border-t border-zinc-100 px-4 py-2 font-mono text-[11px] leading-6">
                {progress.map((p) => (
                  <div key={p.file} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-right">
                      {p.state === 'running' && <span className="text-blue-500">⟳ 评审中</span>}
                      {p.state === 'done' && <span className="text-emerald-600">✓ 完成</span>}
                      {p.state === 'error' && <span className="text-red-500">✗ 失败</span>}
                      {p.state === 'canceled' && <span className="text-amber-500">■ 已停止</span>}
                      {p.state === 'exempt' && <span className="text-zinc-400">🛡 豁免</span>}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-700" title={p.note ?? p.file}>{p.file}</span>
                    {p.ms != null && <span className="shrink-0 text-zinc-400">{(p.ms / 1000).toFixed(1)}s</span>}
                    {p.issues != null && p.issues > 0 && <span className="shrink-0 text-amber-600">+{p.issues} 问题</span>}
                    {p.note && p.state !== 'done' && p.state !== 'running' && (
                      <span className="max-w-[40%] shrink-0 truncate text-zinc-400" title={p.note}>{p.note}</span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {stats?.aiErrors?.length ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {stats.aiErrors.length} 个文件 AI 评审失败（已跳过）：
          <ul className="ml-4 list-disc">{stats.aiErrors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      ) : null}

      {/* 视图切换 */}
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white/95 px-4 py-2.5 backdrop-blur">
        <div className="flex gap-1 rounded-lg bg-zinc-100 p-0.5">
          <button
            onClick={() => setView('list')}
            className={`rounded-md px-3 py-1 text-xs transition ${
              curView === 'list' ? 'bg-white font-medium text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            问题列表（{filtered.length}）
          </button>
          <button
            onClick={() => setView('diff')}
            className={`rounded-md px-3 py-1 text-xs transition ${
              curView === 'diff' ? 'bg-white font-medium text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            Diff 视图
          </button>
        </div>

        <div className="flex items-center gap-1">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              onClick={() => toggleSev(s)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                selSev.size === 0 || selSev.has(s)
                  ? s === 'bug'
                    ? 'border-red-200 bg-red-50 text-red-700'
                    : s === 'major'
                      ? 'border-orange-200 bg-orange-50 text-orange-700'
                      : s === 'important'
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : s === 'minor'
                          ? 'border-sky-200 bg-sky-50 text-sky-700'
                          : 'border-zinc-200 bg-zinc-50 text-zinc-600'
                  : 'border-zinc-100 bg-white text-zinc-300'
              }`}
            >
              {SEVERITY_LABEL[s]} {sevCount[s] ?? 0}
            </button>
          ))}
          {selSev.size > 0 && (
            <button onClick={() => setSelSev(new Set())} className="ml-1 text-xs text-zinc-400 hover:text-zinc-700">
              重置
            </button>
          )}
        </div>

        <select value={selSource} onChange={(e) => setSelSource(e.target.value as never)} className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs">
          <option value="all">全部来源</option>
          <option value="rule_match">规则触发器命中</option>
          <option value="ai_found">AI 发现</option>
        </select>
        <select value={selStatus} onChange={(e) => setSelStatus(e.target.value as never)} className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs">
          <option value="open">待处理</option>
          <option value="all">全部状态</option>
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索标题 / 文件 / 作者…"
          className="w-44 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs outline-none focus:border-zinc-500"
        />

        {curView === 'diff' && (
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input type="checkbox" checked={onlyIssueFiles} onChange={(e) => setOnlyIssueFiles(e.target.checked)} className="accent-zinc-800" />
            只看有问题的文件
          </label>
        )}
        <span className="text-xs text-zinc-400">筛选后 {filtered.length} / {issues.length}</span>
      </div>

      {/* 主体：问题列表 / diff */}
      {curView === 'list' ? (
        <IssueList
          issues={filtered}
          rules={rules}
          selectedIds={selectedFix}
          expandedId={expanded}
          onExpand={setExpanded}
          onToggleSelect={toggleFixSel}
          onIssueStatus={setIssueStatus}
          onGotoDiff={gotoDiff}
          running={running}
          foundSoFar={stats?.issues ?? 0}
        />
      ) : files.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
          {running ? '正在收集变更文件…' : '本次扫描没有检测到文本文件变更'}
        </div>
      ) : (
        <>
          <DiffView
            files={shownFiles}
            issues={filtered}
            rules={rules}
            selectedIds={selectedFix}
            onToggleSelect={toggleFixSel}
            onIssueStatus={setIssueStatus}
            collapsed={false}
            focus={focus}
          />
          {cleanFiles > 0 && (
            <div className="mt-2 text-center text-xs text-zinc-400">
              {cleanFiles} 个无问题文件已隐藏（取消勾选「只看有问题的文件」查看完整 diff）
            </div>
          )}
        </>
      )}

      {/* 底部 AI 修复操作条 */}
      {canFix && issues.some((i) => i.status === 'open') && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/95 px-6 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-[1400px] items-center gap-4">
            <span className="text-sm text-zinc-600">
              已选 <b className="text-zinc-900">{selectedFix.size}</b> 个问题加入 AI 修复
            </span>
            <button
              onClick={() => {
                // 快捷：一键选中全部 open 且筛选后的问题
                if (selectedFix.size > 0) setSelectedFix(new Set())
                else setSelectedFix(new Set(filtered.filter((i) => i.status === 'open').map((i) => i.id)))
              }}
              className="text-xs text-zinc-500 underline hover:text-zinc-800"
            >
              {selectedFix.size > 0 ? '清空' : '全选当前筛选'}
            </button>
            <div className="ml-auto flex items-center gap-2">
              {detail.fixes.length > 0 && (
                <Link to={`/p/${id}/fixes`} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:border-zinc-400">
                  修复任务（{detail.fixes.length}）
                </Link>
              )}
              <button
                onClick={createFix}
                disabled={selectedFix.size === 0 || fixBusy}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
              >
                {fixBusy ? '创建中…' : `AI 修复（${selectedFix.size}）`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 问题列表视图：紧凑行 + 展开详情 */
function IssueList({
  issues,
  rules,
  selectedIds,
  expandedId,
  onExpand,
  onToggleSelect,
  onIssueStatus,
  onGotoDiff,
  running,
  foundSoFar
}: {
  issues: Issue[]
  rules: Rule[]
  selectedIds: Set<number>
  expandedId: number | null
  onExpand: (id: number | null) => void
  onToggleSelect: (id: number) => void
  onIssueStatus: (id: number, status: string) => void
  onGotoDiff: (it: Issue) => void
  running: boolean
  foundSoFar: number
}) {
  if (issues.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-400">
        {running ? (
          <span className="inline-flex items-center gap-2">
            <Spinner className="h-3.5 w-3.5" /> AI 评审进行中，已发现 {foundSoFar} 个问题…
          </span>
        ) : (
          '当前筛选条件下没有问题 🎉'
        )}
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      {issues.map((it, idx) => (
        <div key={it.id} className={idx > 0 ? 'border-t border-zinc-100' : ''}>
          <div
            className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-zinc-50 ${
              it.status !== 'open' ? 'opacity-55' : ''
            }`}
            onClick={() => onExpand(expandedId === it.id ? null : it.id)}
          >
            <input
              type="checkbox"
              checked={selectedIds.has(it.id)}
              onChange={() => onToggleSelect(it.id)}
              onClick={(e) => e.stopPropagation()}
              className="accent-zinc-800"
            />
            <SeverityBadge severity={it.severity} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">{it.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onGotoDiff(it)
              }}
              className="shrink-0 font-mono text-xs text-blue-600 hover:underline"
              title="在 diff 视图中定位"
            >
              {it.file_path.split('/').pop()}
              {it.line_new != null ? `:${it.line_new}` : ''}
            </button>
            <span
              className={`shrink-0 rounded border px-1.5 py-0 text-[11px] ${
                it.source === 'rule_match'
                  ? 'border-red-200 bg-red-50 text-red-600'
                  : 'border-violet-200 bg-violet-50 text-violet-600'
              }`}
            >
              {it.source === 'rule_match' ? '规则命中' : 'AI 发现'}
            </span>
            {it.author && <span className="hidden shrink-0 text-[11px] text-zinc-400 md:inline">{it.author}</span>}
            {it.status !== 'open' && (
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">
                {it.status === 'resolved' ? '已解决' : '不改'}
              </span>
            )}
          </div>
          {expandedId === it.id && (
            <div className="border-t border-zinc-100 bg-zinc-50/50 px-4 py-3">
              <div className="mb-2 font-mono text-xs text-zinc-500">{it.file_path}{it.line_new != null ? `:${it.line_new}` : ''}</div>
              <IssueCard
                issue={it}
                rules={rules}
                selected={selectedIds.has(it.id)}
                onToggleSelect={() => onToggleSelect(it.id)}
                onStatus={(s) => onIssueStatus(it.id, s)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function safeParse(s: string): ScanStats | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
