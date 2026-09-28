import { useEffect, useRef, useState } from 'react'
import { apiGet, errMessage } from '../api'
import { Spinner } from './ui'

interface FsList {
  path: string
  parent: string | null
  dirs: string[]
  isGitRepo: boolean
  places: { name: string; path: string }[]
  error?: string
}

/** 网页版目录选择器（系统对话框不可用时的兜底，也显示 git 仓库状态） */
export default function FolderPicker({
  open,
  onClose,
  onPick
}: {
  open: boolean
  onClose: () => void
  onPick: (path: string) => void
}) {
  const [path, setPath] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [isGit, setIsGit] = useState(false)
  const [places, setPlaces] = useState<{ name: string; path: string }[]>([])
  const [manual, setManual] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const load = (dir: string, pushHistory = true) => {
    setLoading(true)
    setError('')
    apiGet<FsList>(`/api/fs/list?dir=${encodeURIComponent(dir)}`)
      .then((d) => {
        if (pushHistory && path && path !== d.path) setHistory((h) => [...h, path])
        setPath(d.path)
        setParent(d.parent)
        setDirs(d.dirs)
        setIsGit(d.isGitRepo)
        setPlaces(d.places)
        setManual(d.path)
        if (d.error) setError(d.error)
      })
      .catch((e) => setError(errMessage(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (open && !path) load('', false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const goBack = () => {
    const prev = history[history.length - 1]
    if (!prev) return
    setHistory((h) => h.slice(0, -1))
    load(prev, false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[80vh] w-[600px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-zinc-800">选择 git 仓库目录</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" title="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 快捷位置 */}
        <div className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-5 py-2.5">
          {places.map((p) => (
            <button
              key={p.path}
              onClick={() => load(p.path)}
              className={`rounded-full border px-2.5 py-1 text-xs transition ${
                p.path === path
                  ? 'border-zinc-800 bg-zinc-900 text-white'
                  : 'border-zinc-200 text-zinc-600 hover:border-zinc-400'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        {/* 路径导航 */}
        <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5">
          <button
            onClick={goBack}
            disabled={history.length === 0}
            className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-30"
            title="后退"
          >
            ←
          </button>
          <button
            onClick={() => parent && load(parent)}
            disabled={!parent}
            className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-30"
            title="上一级"
          >
            ⬆
          </button>
          <input
            ref={inputRef}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manual.trim()) load(manual.trim())
            }}
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-xs outline-none focus:border-zinc-500"
            placeholder="输入绝对路径后回车…"
            spellCheck={false}
          />
        </div>

        {/* 目录列表 */}
        <div className="min-h-[240px] flex-1 overflow-auto px-2 py-1.5">
          {loading ? (
            <div className="flex h-full items-center justify-center py-16">
              <Spinner />
            </div>
          ) : error && dirs.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-red-500">{error}</div>
          ) : dirs.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-zinc-400">没有子目录</div>
          ) : (
            dirs.map((d) => (
              <button
                key={d}
                onDoubleClick={() => load(`${path}/${d}`)}
                onClick={() => inputRef.current?.blur()}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left font-mono text-xs text-zinc-700 hover:bg-zinc-100"
                title="双击进入"
              >
                <span className="text-amber-500">📁</span>
                {d}
              </button>
            ))
          )}
        </div>

        {/* 底部：当前目录状态与确认 */}
        <div className="flex items-center gap-3 border-t border-zinc-100 bg-zinc-50 px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-xs text-zinc-600" title={path}>
              {path}
            </div>
            <div className={`text-[11px] ${isGit ? 'text-emerald-600' : 'text-amber-600'}`}>
              {isGit ? '✓ 是 git 仓库' : '不是 git 仓库（请选择仓库根目录）'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 hover:border-zinc-400"
          >
            取消
          </button>
          <button
            onClick={() => onPick(path)}
            disabled={!isGit}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
          >
            选择此目录
          </button>
        </div>
      </div>
    </div>
  )
}
