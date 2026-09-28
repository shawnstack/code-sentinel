import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { apiDelete, apiGet, apiPatch, apiPost, errMessage } from '../api'
import type { AiProvider } from '../types'
import { ErrorText, Spinner } from '../components/ui'

export default function Settings() {
  const [providers, setProviders] = useState<AiProvider[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', model: '' })

  const load = () => apiGet<AiProvider[]>('/api/ai/providers').then(setProviders).catch((e) => setError(errMessage(e)))
  useEffect(() => {
    load()
  }, [])

  const flash = (m: string) => {
    setNotice(m)
    setTimeout(() => setNotice(''), 2500)
  }

  const add = async () => {
    setBusy(true)
    setError('')
    try {
      await apiPost('/api/ai/providers', { ...form, is_active: (providers ?? []).length === 0 })
      setForm({ name: '', base_url: '', api_key: '', model: '' })
      load()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const activate = async (id: number) => {
    await apiPatch(`/api/ai/providers/${id}`, { is_active: true })
    load()
  }

  const del = async (id: number) => {
    if (!confirm('删除该 Provider？')) return
    await apiDelete(`/api/ai/providers/${id}`)
    load()
  }

  const test = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await apiPost<{ reply: string }>('/api/ai/test')
      flash(`连接正常，模型回复：${r.reply}`)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const importNoteFlow = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await apiPost<{ imported: number }>('/api/ai/import-noteflow')
      flash(`从 NoteFlow 导入了 ${r.imported} 个配置`)
      load()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link to="/" className="text-sm text-zinc-400 hover:text-zinc-700">← 返回</Link>
        <h1 className="text-lg font-semibold">AI 设置</h1>
        {notice && <span className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">{notice}</span>}
      </div>

      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-semibold text-zinc-700">Provider（OpenAI 兼容接口）</h2>
        <p className="mb-4 text-xs text-zinc-400">
          所有扫描/修复使用当前激活的 Provider。支持 openrouter、deepseek、moonshot、ollama 等任何 OpenAI 兼容服务。
        </p>
        {providers === null ? (
          <div className="py-8 text-center"><Spinner className="mx-auto" /></div>
        ) : providers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 py-8 text-center text-sm text-zinc-400">
            还没有配置，可从 NoteFlow 一键导入或手动添加
          </div>
        ) : (
          <div className="grid gap-2">
            {providers.map((p) => (
              <div key={p.id} className={`flex items-center gap-3 rounded-lg border p-3 ${p.is_active ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200'}`}>
                <input
                  type="radio"
                  checked={!!p.is_active}
                  onChange={() => activate(p.id)}
                  className="accent-zinc-800"
                  title="设为激活"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-800">{p.name}</span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0 font-mono text-[11px] text-zinc-600">{p.model}</span>
                    {p.is_active && <span className="rounded bg-zinc-900 px-1.5 py-0 text-[11px] text-white">使用中</span>}
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-400">{p.base_url}</div>
                </div>
                <button onClick={() => del(p.id)} className="text-xs text-zinc-300 hover:text-red-500">删除</button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button onClick={test} disabled={busy || !providers?.length} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:border-zinc-500 disabled:opacity-40">
            测试连接
          </button>
          <button onClick={importNoteFlow} disabled={busy} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:border-zinc-500 disabled:opacity-40">
            从 NoteFlow 导入
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-zinc-700">添加 Provider</h2>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-zinc-500">
              名称
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="openrouter" className={inputCls} />
            </label>
            <label className="text-xs text-zinc-500">
              模型
              <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="grok-4-fast" className={inputCls} />
            </label>
          </div>
          <label className="text-xs text-zinc-500">
            Base URL（/v1 结尾）
            <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://openrouter.ai/api/v1" className={inputCls} />
          </label>
          <label className="text-xs text-zinc-500">
            API Key
            <input value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} type="password" placeholder="sk-…" className={inputCls} />
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={add}
              disabled={busy || !form.name || !form.base_url || !form.model}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
            >
              添加
            </button>
            {error && <ErrorText>{error}</ErrorText>}
          </div>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  'mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-400'
