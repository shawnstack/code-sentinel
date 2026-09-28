import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router'
import { apiGet, errMessage } from '../api'
import type { Project, ProjectInfo } from '../types'
import { ErrorText, Spinner } from '../components/ui'

export interface ProjectCtx {
  project: Project
  info: ProjectInfo | null
  refreshInfo: () => void
}

export default function ProjectLayout() {
  const { id } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const list = await apiGet<Project[]>('/api/projects')
      const p = list.find((x) => x.id === Number(id))
      if (!p) throw new Error('项目不存在')
      setProject(p)
      const inf = await apiGet<ProjectInfo>(`/api/projects/${id}/info`)
      setInfo(inf)
    } catch (e) {
      setError(errMessage(e))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (error) return <div className="p-8"><ErrorText>{error}</ErrorText></div>
  if (!project) return <div className="py-24 text-center"><Spinner className="mx-auto" /></div>

  const tabs = [
    { to: `/p/${id}`, label: '扫描', end: true },
    { to: `/p/${id}/rules`, label: `规则库${info ? ` (${info.rulesCount})` : ''}` },
    { to: `/p/${id}/fixes`, label: '修复任务' },
    { to: `/p/${id}/files`, label: '代码浏览' },
    { to: `/p/${id}/config`, label: '扫描配置' }
  ]

  return (
    <div className="min-h-full">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-zinc-400 hover:text-zinc-700" title="返回项目列表">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Link>
            <h1 className="text-base font-semibold">{project.name}</h1>
            <span className="font-mono text-xs text-zinc-400">{project.path}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            {info && (
              <>
                <span className="rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono">{info.currentBranch}</span>
                <span className={info.isClean ? 'text-emerald-600' : 'text-amber-600'}>
                  {info.isClean ? '工作区干净' : '有未提交改动'}
                </span>
              </>
            )}
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1400px] gap-1 px-6">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `-mb-px border-b-2 px-3 py-2 text-sm ${
                  isActive ? 'border-zinc-900 font-medium text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-800'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        <Outlet context={{ project, info, refreshInfo: load } satisfies ProjectCtx} />
      </main>
    </div>
  )
}
