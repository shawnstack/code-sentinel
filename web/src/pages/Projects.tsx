import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { apiDelete, apiGet, apiPost, errMessage } from '../api'
import type { Project } from '../types'
import { timeAgo } from '../severity'
import { Empty, ErrorText, Spinner, StatusBadge } from '../components/ui'
import FolderPicker from '../components/FolderPicker'

interface PickResult {
  available: boolean
  ok?: boolean
  canceled?: boolean
  path?: string
  reason?: string
}

export default function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const nav = useNavigate()

  const load = () => apiGet<Project[]>('/api/projects').then(setProjects).catch((e) => setError(errMessage(e)))

  useEffect(() => {
    load()
  }, [])

  const add = async () => {
    if (!path.trim()) return
    setBusy(true)
    setError('')
    try {
      const r = await apiPost<{ id: number }>('/api/projects', { path, name })
      nav(`/p/${r.id}`)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  /** 目录选择：优先 macOS 原生对话框，不可用/失败时降级为网页目录浏览器 */
  const browse = async () => {
    setPicking(true)
    try {
      const r = await apiPost<PickResult>('/api/fs/pick-folder')
      if (r.canceled) return // 用户在系统对话框点了取消，静默结束
      if (r.ok && r.path) {
        setPath(r.path)
        return
      }
      setShowPicker(true) // 非 darwin / osascript 失败 → 网页选择器
    } catch {
      setShowPicker(true)
    } finally {
      setPicking(false)
    }
  }

  const remove = async (p: Project) => {
    if (!confirm(`移除项目「${p.name}」？（只从工具移除，不动仓库）`)) return
    await apiDelete(`/api/projects/${p.id}`)
    load()
  }

  return (
    <div className="min-h-full bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-white">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold">Code Sentinel</h1>
              <p className="text-xs text-zinc-500">AI 辅助代码扫描评审</p>
            </div>
          </div>
          <Link to="/settings" className="text-sm text-zinc-600 hover:text-zinc-900 hover:underline">
            AI 设置
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-8 rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-700">添加项目（git 仓库路径）</h2>
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="如 ~/projects/my-app 或 /absolute/path"
              className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-400"
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button
              onClick={browse}
              disabled={picking}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:border-zinc-500 hover:text-zinc-900 disabled:opacity-60"
              title={picking ? '系统目录选择对话框已弹出…' : '打开目录选择'}
            >
              {picking ? <Spinner className="h-3.5 w-3.5" /> : '📁'}
              {picking ? '系统对话框中…' : '浏览…'}
            </button>
            <button
              onClick={() => setShowPicker(true)}
              className="whitespace-nowrap rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-500 hover:border-zinc-500 hover:text-zinc-800"
              title="网页内浏览目录（系统对话框不可用时使用）"
            >
              网页浏览
            </button>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="别名（可选）"
              className="w-36 rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
            <button
              onClick={add}
              disabled={busy}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {busy ? <Spinner className="border-zinc-400 border-t-white" /> : '添加'}
            </button>
          </div>
          {picking && (
            <p className="mt-2 text-xs text-zinc-400">已在屏幕上弹出系统目录选择对话框，选择后会自动填入（取消可关闭）</p>
          )}
          {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
        </div>

        {projects === null ? (
          <div className="py-16 text-center"><Spinner className="mx-auto" /></div>
        ) : projects.length === 0 ? (
          <Empty>还没有项目，先添加一个 git 仓库</Empty>
        ) : (
          <div className="grid gap-3">
            {projects.map((p) => (
              <div
                key={p.id}
                className="group flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 hover:border-zinc-300 hover:shadow-sm"
              >
                <Link to={`/p/${p.id}`} className="flex-1">
                  <div className="font-medium text-zinc-900 group-hover:underline">{p.name}</div>
                  <div className="mt-0.5 font-mono text-xs text-zinc-500">{p.path}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                    {p.scan_count ? (
                      <>
                        <span>{p.scan_count} 次扫描 · 最近 {timeAgo(p.last_scan_at)}</span>
                        {p.last_scan_status && <StatusBadge status={p.last_scan_status} />}
                        {p.last_scan_status === 'done' &&
                          (p.open_issues ? (
                            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
                              {p.open_issues} 个待处理
                            </span>
                          ) : (
                            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">无待处理</span>
                          ))}
                        {!!p.waiver_count && (
                          <span className="text-[11px] text-zinc-400" title="历史 wont_fix 豁免记录数">
                            {p.waiver_count} 项豁免
                          </span>
                        )}
                      </>
                    ) : (
                      <span>尚未扫描</span>
                    )}
                  </div>
                </Link>
                <button
                  onClick={() => remove(p)}
                  className="ml-4 rounded-lg border border-transparent px-3 py-1.5 text-xs text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      <FolderPicker
        open={showPicker}
        onClose={() => setShowPicker(false)}
        onPick={(p) => {
          setPath(p)
          setShowPicker(false)
        }}
      />
    </div>
  )
}
