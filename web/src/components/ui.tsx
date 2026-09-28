import type { ReactNode } from 'react'
import { SEVERITY_LABEL } from '../severity'

export function SeverityBadge({ severity, size = 'sm' }: { severity: string; size?: 'xs' | 'sm' }) {
  const cls: Record<string, string> = {
    bug: 'bg-red-100 text-red-700 border-red-200',
    major: 'bg-orange-100 text-orange-700 border-orange-200',
    important: 'bg-amber-100 text-amber-700 border-amber-200',
    minor: 'bg-sky-100 text-sky-700 border-sky-200',
    style: 'bg-zinc-100 text-zinc-600 border-zinc-200'
  }
  const dot: Record<string, string> = {
    bug: 'bg-red-500',
    major: 'bg-orange-500',
    important: 'bg-amber-500',
    minor: 'bg-sky-500',
    style: 'bg-zinc-400'
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-medium ${cls[severity] ?? cls.style} ${
        size === 'xs' ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot[severity] ?? dot.style}`} />
      {SEVERITY_LABEL[severity] ?? severity}
    </span>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-zinc-100 text-zinc-600 border-zinc-200',
    running: 'bg-blue-100 text-blue-700 border-blue-200',
    done: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    canceled: 'bg-amber-100 text-amber-700 border-amber-200',
    merged: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    discarded: 'bg-zinc-100 text-zinc-500 border-zinc-200',
    failed: 'bg-red-100 text-red-700 border-red-200',
    error: 'bg-red-100 text-red-700 border-red-200',
    open: 'bg-blue-50 text-blue-700 border-blue-200',
    resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    wont_fix: 'bg-zinc-100 text-zinc-500 border-zinc-200'
  }
  const label: Record<string, string> = {
    pending: '等待中',
    running: '执行中',
    done: '完成',
    canceled: '已取消',
    merged: '已合并',
    discarded: '已丢弃',
    failed: '失败',
    error: '出错',
    open: '待处理',
    resolved: '已解决',
    wont_fix: '不改'
  }
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${map[status] ?? map.pending}`}>
      {label[status] ?? status}
    </span>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 ${className}`}
    />
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-sm text-zinc-400">{children}</div>
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null
  return <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{children}</div>
}
