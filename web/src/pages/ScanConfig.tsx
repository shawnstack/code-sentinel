import { useEffect, useState } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { apiGet, apiPut, errMessage } from '../api'
import type { ScanConfig } from '../types'
import { ErrorText, Spinner } from '../components/ui'
import type { ProjectCtx } from './ProjectLayout'

/** 项目扫描配置：范围限定 / 排除 / 白名单豁免 / 评审文件数上限 */

const HINTS: Record<keyof Omit<ScanConfig, 'maxFiles'>, { title: string; desc: string; placeholder: string }> = {
  include: {
    title: '扫描范围（include）',
    desc: '留空 = 扫描全部变更文件。填写后只有匹配的文件参与扫描，其余视为排除。',
    placeholder: 'src/**\npackages/*/src/**'
  },
  exclude: {
    title: '排除（exclude）',
    desc: '完全排除：不出现在扫描结果里（也不显示 diff）。规则目录 .codescan/ 始终自动排除。',
    placeholder: 'dist/**\n*.min.js\n*.snap\ncoverage'
  },
  allowlist: {
    title: '白名单豁免（allowlist）',
    desc: '豁免的文件仍显示在 diff 中（标 🛡 已豁免），但不做规则触发、不调 AI 评审、不产生问题。仅对扫描范围内的文件生效。',
    placeholder: 'vendor/**\n**/*.generated.ts\nmigrations/**'
  }
}

export default function ScanConfigPage() {
  const { id } = useParams()
  const { project } = useOutletContext<ProjectCtx>()
  const [config, setConfig] = useState<ScanConfig | null>(null)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [allowlist, setAllowlist] = useState('')
  const [maxFiles, setMaxFiles] = useState(40)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet<ScanConfig>(`/api/projects/${id}/scan-config`)
      .then((c) => {
        setConfig(c)
        setInclude(c.include.join('\n'))
        setExclude(c.exclude.join('\n'))
        setAllowlist(c.allowlist.join('\n'))
        setMaxFiles(c.maxFiles)
      })
      .catch((e) => setError(errMessage(e)))
  }, [id])

  const toArr = (s: string) =>
    s
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith('#'))

  const save = async () => {
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const c = await apiPut<ScanConfig>(`/api/projects/${id}/scan-config`, {
        include: toArr(include),
        exclude: toArr(exclude),
        allowlist: toArr(allowlist),
        maxFiles: Number(maxFiles) || 40
      })
      setConfig(c)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (error && !config) return <ErrorText>{error}</ErrorText>
  if (!config) return <div className="py-24 text-center"><Spinner className="mx-auto" /></div>

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5">
        <h2 className="text-sm font-semibold text-zinc-700">扫描配置</h2>
        <p className="mt-1 text-xs text-zinc-400">
          应用于项目 <span className="font-mono">{project?.path}</span> 的所有新扫描（进行中的扫描不受影响）。
        </p>
      </div>

      <div className="grid gap-4">
        {(Object.keys(HINTS) as (keyof typeof HINTS)[]).map((key) => (
          <div key={key} className="rounded-xl border border-zinc-200 bg-white p-4">
            <div className="mb-1 text-sm font-medium text-zinc-700">{HINTS[key].title}</div>
            <div className="mb-2.5 text-xs leading-relaxed text-zinc-400">{HINTS[key].desc}</div>
            <textarea
              value={key === 'include' ? include : key === 'exclude' ? exclude : allowlist}
              onChange={(e) =>
                key === 'include' ? setInclude(e.target.value) : key === 'exclude' ? setExclude(e.target.value) : setAllowlist(e.target.value)
              }
              placeholder={HINTS[key].placeholder}
              rows={Math.max(3, (key === 'include' ? include : key === 'exclude' ? exclude : allowlist).split('\n').length)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs leading-6 outline-none focus:border-zinc-500"
            />
          </div>
        ))}

        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <div className="mb-1 text-sm font-medium text-zinc-700">单次评审文件数上限</div>
          <div className="mb-2.5 text-xs leading-relaxed text-zinc-400">
            超出上限时按变更量优先保留，其余文件保留 diff 展示但跳过评审（1-200）。
          </div>
          <input
            type="number"
            min={1}
            max={200}
            value={maxFiles}
            onChange={(e) => setMaxFiles(Number(e.target.value))}
            className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
        </div>

        <div className="rounded-xl border border-zinc-100 bg-zinc-50/60 p-4 text-xs leading-relaxed text-zinc-500">
          <span className="font-medium text-zinc-600">glob 语法：</span>
          每行一个模式，<code className="rounded bg-white px-1">src</code> 或{' '}
          <code className="rounded bg-white px-1">src/**</code> 匹配 src 下所有文件；{' '}
          <code className="rounded bg-white px-1">**/*.test.ts</code> 匹配任意层级；{' '}
          <code className="rounded bg-white px-1">*.min.js</code>（不含 / 时）匹配任意层级的文件名；{' '}
          <code className="rounded bg-white px-1">?</code> 单字符。以 <code className="rounded bg-white px-1">#</code> 开头的行是注释。
          <br />
          <span className="font-medium text-zinc-600">优先级：</span>
          先按 include 圈定范围，再 exclude 排除，最后 allowlist 豁免。
        </div>

        {error && <ErrorText>{error}</ErrorText>}

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {busy ? '保存中…' : '保存配置'}
          </button>
          {saved && <span className="text-xs text-emerald-600">✓ 已保存</span>}
        </div>
      </div>
    </div>
  )
}
