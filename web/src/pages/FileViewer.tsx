import { useEffect, useState } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { apiGet, errMessage } from '../api'
import type { FileDetail, GitCommit } from '../types'
import { timeAgo } from '../severity'
import { ErrorText, Spinner } from '../components/ui'
import type { ProjectCtx } from './ProjectLayout'

/** 代码浏览：文件内容 + 每行 blame 作者 + 文件提交历史 */
export default function FileViewer() {
  const { id } = useParams()
  const { info } = useOutletContext<ProjectCtx>()
  const [tree, setTree] = useState<string[] | null>(null)
  const [ref, setRef] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<FileDetail | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (info && !ref) setRef(info.currentBranch || 'HEAD')
  }, [info, ref])

  useEffect(() => {
    if (!ref) return
    apiGet<{ files: string[] }>(`/api/projects/${id}/tree?ref=${encodeURIComponent(ref)}`)
      .then((d) => setTree(d.files.slice(0, 5000)))
      .catch((e) => setError(errMessage(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ref])

  useEffect(() => {
    if (!selected || !ref) return
    setDetail(null)
    apiGet<FileDetail>(`/api/projects/${id}/file?path=${encodeURIComponent(selected)}&ref=${encodeURIComponent(ref)}`)
      .then(setDetail)
      .catch((e) => setError(errMessage(e)))
    apiGet<GitCommit[]>(`/api/projects/${id}/log?file=${encodeURIComponent(selected)}&ref=${encodeURIComponent(ref)}&max=15`)
      .then(setLog)
      .catch(() => setLog([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, selected, ref])

  const shown = (tree ?? []).filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase())).slice(0, 300)
  const blameByLine = new Map((detail?.blame ?? []).map((b) => [b.line, b]))

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      {/* 文件列表 */}
      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-100 p-3">
          <select value={ref} onChange={(e) => setRef(e.target.value)} className="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs">
            <option value="HEAD">HEAD（工作区）</option>
            {(info?.branches ?? []).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤文件路径…"
            className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-xs outline-none focus:border-zinc-500"
          />
        </div>
        <div className="max-h-[70vh] overflow-auto py-1">
          {tree === null ? (
            <div className="py-8 text-center"><Spinner /></div>
          ) : (
            shown.map((f) => (
              <button
                key={f}
                onClick={() => setSelected(f)}
                className={`block w-full truncate px-3 py-1 text-left font-mono text-[11px] hover:bg-zinc-50 ${
                  selected === f ? 'bg-zinc-100 font-medium text-zinc-900' : 'text-zinc-600'
                }`}
                title={f}
              >
                {f}
              </button>
            ))
          )}
        </div>
      </div>

      {/* 文件内容 + blame + log */}
      <div className="min-w-0">
        {!selected ? (
          <div className="rounded-xl border border-zinc-200 bg-white py-20 text-center text-sm text-zinc-400">
            选择左侧文件查看内容与作者信息
          </div>
        ) : !detail ? (
          <div className="rounded-xl border border-zinc-200 bg-white py-20 text-center">
            <Spinner className="mx-auto" />
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 bg-zinc-50/60 px-4 py-2">
                <span className="font-mono text-sm font-medium text-zinc-800">{detail.path}</span>
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500">{ref}</span>
                {detail.exports.length > 0 && (
                  <span className="text-[11px] text-zinc-400">导出：{detail.exports.slice(0, 8).join(', ')}{detail.exports.length > 8 ? '…' : ''}</span>
                )}
              </div>
              <div className="max-h-[55vh] overflow-auto">
                <table className="w-full border-collapse font-mono text-xs leading-5">
                  <tbody>
                    {detail.content.split('\n').map((line, i) => {
                      const b = blameByLine.get(i + 1)
                      return (
                        <tr key={i} className="hover:bg-zinc-50">
                          <td className="w-12 select-none border-r border-zinc-100 px-2 text-right align-top text-zinc-300">{i + 1}</td>
                          <td className="whitespace-pre-wrap break-all px-3 align-top text-zinc-800">{line || ' '}</td>
                          <td className="w-44 select-none whitespace-nowrap border-l border-zinc-100 px-2 text-right align-top text-[10px] text-zinc-400" title={b?.summary}>
                            {b ? `${b.author} · ${b.date?.slice(0, 10)}` : ''}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 引用分析 */}
            {detail.refs.hits.length > 0 && (
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-2 text-xs font-semibold text-zinc-600">
                  被引用（{detail.refs.hits.length}{detail.refs.truncated ? '+' : ''} 处）
                </h3>
                <div className="grid gap-1">
                  {detail.refs.hits.slice(0, 15).map((h, i) => (
                    <div key={i} className="font-mono text-[11px] text-zinc-500">
                      <span className="rounded bg-sky-50 px-1 text-sky-700">{h.symbol}</span> ← {h.file}:{h.line}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 文件提交历史 */}
            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <h3 className="mb-2 text-xs font-semibold text-zinc-600">提交历史</h3>
              {log.length === 0 ? (
                <div className="text-xs text-zinc-400">无记录</div>
              ) : (
                <div className="grid gap-1.5">
                  {log.map((c) => (
                    <div key={c.hash} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-zinc-400">{c.short}</span>
                      <span className="truncate text-zinc-700">{c.subject}</span>
                      <span className="ml-auto whitespace-nowrap text-zinc-400">{c.author} · {timeAgo(c.date)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
      </div>
    </div>
  )
}
