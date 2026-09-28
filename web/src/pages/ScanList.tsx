import { useEffect, useState } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router'
import { apiGet, apiPost, errMessage } from '../api'
import type { AiProvider, ScanConfig, ScanListItem, ScanStats, ScanType } from '../types'
import { timeAgo } from '../severity'
import { Empty, ErrorText, SeverityBadge, Spinner, StatusBadge } from '../components/ui'
import type { ProjectCtx } from './ProjectLayout'

const TYPE_LABEL: Record<ScanType, string> = {
  branch: '分支对比',
  commits: '提交范围',
  workdir: '工作区改动'
}

export default function ScanList() {
  const { id } = useParams()
  const { info } = useOutletContext<ProjectCtx>()
  const nav = useNavigate()

  const [scans, setScans] = useState<ScanListItem[] | null>(null)
  const [mode, setMode] = useState<ScanType>('branch')
  const [base, setBase] = useState('')
  const [head, setHead] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('HEAD')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiReady, setAiReady] = useState(true)
  const [config, setConfig] = useState<ScanConfig | null>(null)

  const load = () => apiGet<ScanListItem[]>(`/api/projects/${id}/scans`).then(setScans).catch((e) => setError(errMessage(e)))

  useEffect(() => {
    load()
    apiGet<AiProvider[]>('/api/ai/providers')
      .then((ps) => setAiReady(ps.length > 0))
      .catch(() => undefined)
    apiGet<ScanConfig>(`/api/projects/${id}/scan-config`).then(setConfig).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (!info || base || head) return
    const cur = info.branches.find((b) => b.isCurrent)?.name ?? 'HEAD'
    const main = info.branches.find((b) => ['main', 'master'].includes(b.name))?.name ?? 'main'
    setBase(main)
    setHead(cur)
    if (info.commits[0]) setFrom(info.commits[info.commits.length - 1 > 4 ? 4 : info.commits.length - 1]?.hash ?? info.commits[0].hash)
  }, [info])

  // 扫描进行中时轮询
  useEffect(() => {
    if (scans?.some((s) => s.status === 'running' || s.status === 'pending')) {
      const t = setInterval(load, 1500)
      return () => clearInterval(t)
    }
  }, [scans])

  const stopScan = async (scanId: number) => {
    try {
      await apiPost(`/api/scans/${scanId}/cancel`)
      load()
    } catch (e) {
      alert(errMessage(e))
    }
  }

  const parseStats = (s: ScanListItem): ScanStats | null => {
    try {
      return s.stats ? (JSON.parse(s.stats) as ScanStats) : null
    } catch {
      return null
    }
  }

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const body: Record<string, unknown> = { type: mode }
      if (mode === 'branch') {
        body.base = base
        body.head = head
      } else if (mode === 'commits') {
        body.base = from
        body.head = to
      }
      const r = await apiPost<{ id: number }>(`/api/projects/${id}/scans`, body)
      nav(`/p/${id}/scan/${r.id}`)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const branches = info?.branches ?? []
  const commits = info?.commits ?? []

  return (
    <div className="grid gap-6">
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-zinc-700">发起扫描</h2>
        {!aiReady && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            尚未配置 AI Provider：扫描仍会执行「规则触发器命中」检查，但不会有 AI 智能评审。{' '}
            <Link to="/settings" className="underline">去配置</Link>
          </div>
        )}
        <div className="mb-4 flex gap-1 rounded-lg bg-zinc-100 p-1">
          {(Object.keys(TYPE_LABEL) as ScanType[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition ${
                mode === m ? 'bg-white font-medium text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              {TYPE_LABEL[m]}
            </button>
          ))}
        </div>

        {mode === 'branch' && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex-1 text-xs text-zinc-500">
              基线分支（base）
              <select value={base} onChange={(e) => setBase(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm">
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>
            </label>
            <span className="pb-2.5 text-zinc-400">→</span>
            <label className="flex-1 text-xs text-zinc-500">
              待评审分支（head）
              <select value={head} onChange={(e) => setHead(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm">
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}{b.isCurrent ? '（当前）' : ''}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {mode === 'commits' && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex-1 text-xs text-zinc-500">
              起始（不含，from）
              <select value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm">
                {commits.map((c) => (
                  <option key={c.hash} value={c.hash}>{c.short} {c.subject.slice(0, 40)} — {c.author}</option>
                ))}
              </select>
            </label>
            <span className="pb-2.5 text-zinc-400">→</span>
            <label className="flex-1 text-xs text-zinc-500">
              结束（含，to）
              <select value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm">
                <option value="HEAD">HEAD</option>
                {commits.map((c) => (
                  <option key={c.hash} value={c.hash}>{c.short} {c.subject.slice(0, 40)}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {mode === 'workdir' && (
          <p className="text-xs text-zinc-500">
            扫描工作区未提交改动（含未跟踪的新文件）。适合提交前自查；此模式的 AI 修复将直接修改工作区文件。
          </p>
        )}

        {/* 生效的扫描配置摘要 */}
        {config && (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2 text-[11px] text-zinc-500">
            <span className="font-medium text-zinc-600">扫描配置：</span>
            <span>{config.include.length ? `范围 ${config.include.join(', ')}` : '范围：全部文件'}</span>
            {config.exclude.length > 0 && <span>· 排除 {config.exclude.map((e) => <code key={e} className="mx-0.5 rounded bg-white px-1">{e}</code>)}</span>}
            {config.allowlist.length > 0 && <span>· 豁免 {config.allowlist.length} 项</span>}
            <span>· 上限 {config.maxFiles} 文件</span>
            <Link to={`/p/${id}/config`} className="ml-auto text-blue-600 hover:underline">调整配置</Link>
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={start}
            disabled={busy || (mode === 'branch' && (!base || !head || base === head))}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {busy ? '启动中…' : '开始扫描'}
          </button>
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700">历史扫描</h2>
        {scans === null ? (
          <div className="py-12 text-center"><Spinner className="mx-auto" /></div>
        ) : scans.length === 0 ? (
          <Empty>还没有扫描记录</Empty>
        ) : (
          <div className="grid gap-2">
            {scans.map((s) => {
              const st = s.status === 'running' ? parseStats(s) : null
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 hover:border-zinc-300 hover:shadow-sm"
                >
                  <Link to={`/p/${id}/scan/${s.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="w-20 shrink-0 rounded bg-zinc-100 px-2 py-0.5 text-center text-xs text-zinc-600">{TYPE_LABEL[s.type]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm text-zinc-800">{s.title}</span>
                      <span className="text-xs text-zinc-400">
                        {timeAgo(s.created_at)} · #{s.id}
                        {st && st.total ? ` · 评审中 ${st.done ?? 0}/${st.total}${st.issues ? ` · 已发现 ${st.issues}` : ''}` : ''}
                      </span>
                    </span>
                  </Link>
                  {s.status === 'running' && <Spinner />}
                  {s.status === 'running' ? (
                    <button
                      onClick={() => stopScan(s.id)}
                      className="rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-500 hover:bg-red-50"
                      title="停止该扫描"
                    >
                      停止
                    </button>
                  ) : null}
                  <StatusBadge status={s.status} />
                  {s.status === 'done' && s.issue_count > 0 && (
                    <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
                      {s.issue_count} 个问题
                    </span>
                  )}
                  {(s.status === 'done' || s.status === 'canceled') && s.issue_count === 0 && (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs text-emerald-700">无问题</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
