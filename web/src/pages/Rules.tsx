import { useEffect, useState } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { apiDelete, apiGet, apiPut, errMessage } from '../api'
import type { Rule, RuleType, Severity } from '../types'
import { RULE_TYPE_LABEL, SEVERITIES, SEVERITY_LABEL } from '../severity'
import { Empty, ErrorText, Spinner } from '../components/ui'
import type { ProjectCtx } from './ProjectLayout'

const EMPTY_RULE: Rule = {
  id: '',
  type: 'bad_case',
  name: '',
  description: '',
  severity: 'major',
  enabled: true,
  trigger: { paths: [], symbols: [], languages: [] },
  examples: { bad: '', good: '' }
}

export default function Rules() {
  const { id } = useParams()
  const { refreshInfo } = useOutletContext<ProjectCtx>()
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [filter, setFilter] = useState<'all' | RuleType>('all')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const load = () => apiGet<Rule[]>(`/api/projects/${id}/rules`).then(setRules).catch((e) => setError(errMessage(e)))
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const save = async () => {
    if (!editing) return
    setError('')
    try {
      await apiPut(`/api/projects/${id}/rules`, editing)
      setSaved('已保存')
      setTimeout(() => setSaved(''), 1500)
      load()
      refreshInfo()
    } catch (e) {
      setError(errMessage(e))
    }
  }

  const del = async (r: Rule) => {
    if (!confirm(`删除规则 ${r.id}（${r.name}）？将删除项目内 .codescan/rules/ 下的对应文件`)) return
    await apiDelete(`/api/projects/${id}/rules?id=${encodeURIComponent(r.id)}`)
    if (editing?.id === r.id) setEditing(null)
    load()
    refreshInfo()
  }

  const shown = (rules ?? []).filter((r) => filter === 'all' || r.type === filter)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(320px,1fr)_minmax(400px,1.2fr)]">
      {/* 左：列表 */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-700">规则库</h2>
          <span className="text-xs text-zinc-400">存于项目 .codescan/rules/，随 git 版本化</span>
          <button
            onClick={() => setEditing({ ...EMPTY_RULE, trigger: { paths: [], symbols: [], languages: [] }, examples: { bad: '', good: '' } })}
            className="ml-auto rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
          >
            + 新建
          </button>
        </div>
        <div className="mb-3 flex gap-1 rounded-lg bg-zinc-100 p-1 text-xs">
          {(['all', 'bad_case', 'good_case', 'rule'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`flex-1 rounded-md px-2 py-1 ${filter === t ? 'bg-white font-medium text-zinc-900 shadow-sm' : 'text-zinc-500'}`}
            >
              {t === 'all' ? '全部' : RULE_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        {rules === null ? (
          <div className="py-12 text-center"><Spinner className="mx-auto" /></div>
        ) : shown.length === 0 ? (
          <Empty>
            {rules.length === 0
              ? '还没有规则。建议先从 AI 评审中总结 bad case，沉淀到规则库'
              : '此分类暂无规则'}
          </Empty>
        ) : (
          <div className="grid gap-2">
            {shown.map((r) => (
              <div
                key={r.id}
                onClick={() => setEditing(structuredClone(r))}
                className={`cursor-pointer rounded-lg border bg-white p-3 transition hover:border-zinc-300 ${
                  editing?.id === r.id ? 'border-zinc-900' : 'border-zinc-200'
                } ${!r.enabled ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-zinc-400">{r.id}</span>
                  <span className="text-sm font-medium text-zinc-800">{r.name}</span>
                  <span
                    className={`rounded px-1.5 py-0 text-[11px] ${
                      r.type === 'bad_case'
                        ? 'bg-red-50 text-red-600'
                        : r.type === 'good_case'
                          ? 'bg-emerald-50 text-emerald-600'
                          : 'bg-sky-50 text-sky-600'
                    }`}
                  >
                    {RULE_TYPE_LABEL[r.type]}
                  </span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0 text-[11px] text-zinc-500">
                    {SEVERITY_LABEL[r.severity]}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      del(r)
                    }}
                    className="ml-auto text-xs text-zinc-300 hover:text-red-500"
                  >
                    删除
                  </button>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{r.description || '（无描述）'}</p>
                {(r.trigger.symbols?.length || r.trigger.paths?.length) && (
                  <p className="mt-1 font-mono text-[11px] text-zinc-400">
                    {r.trigger.paths?.length ? `paths: ${r.trigger.paths.join(', ')} ` : ''}
                    {r.trigger.symbols?.length ? `symbols: ${r.trigger.symbols.join(', ')}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右：编辑器 */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        {!editing ? (
          <div className="py-16 text-center text-sm text-zinc-400">选择左侧规则编辑，或点「新建」</div>
        ) : (
          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-700">{editing.id ? `编辑 ${editing.id}` : '新建规则'}</h3>
              {saved && <span className="text-xs text-emerald-600">{saved}</span>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ID（唯一，英文）">
                <input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} className={inputCls} placeholder="no-moment" />
              </Field>
              <Field label="名称">
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={inputCls} placeholder="禁止使用 moment" />
              </Field>
              <Field label="类型">
                <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as RuleType })} className={inputCls}>
                  <option value="bad_case">bad_case（反例：出现即问题）</option>
                  <option value="good_case">good_case（正例：推荐写法）</option>
                  <option value="rule">rule（规则：需结合上下文判断）</option>
                </select>
              </Field>
              <Field label="默认严重度">
                <select value={editing.severity} onChange={(e) => setEditing({ ...editing, severity: e.target.value as Severity })} className={inputCls}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="描述（会完整注入 AI 评审上下文）">
              <textarea value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={3} className={inputCls} placeholder="moment 包体积 300KB+，新代码统一用 dayjs" />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="触发路径 glob（逗号分隔）">
                <input
                  value={editing.trigger.paths?.join(', ') ?? ''}
                  onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, paths: splitList(e.target.value) } })}
                  className={inputCls}
                  placeholder="**/*.ts, **/*.tsx"
                />
              </Field>
              <Field label="触发符号（逗号分隔）">
                <input
                  value={editing.trigger.symbols?.join(', ') ?? ''}
                  onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, symbols: splitList(e.target.value) } })}
                  className={inputCls}
                  placeholder="moment, lodash"
                />
              </Field>
              <Field label="语言（逗号分隔，可空）">
                <input
                  value={editing.trigger.languages?.join(', ') ?? ''}
                  onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, languages: splitList(e.target.value) } })}
                  className={inputCls}
                  placeholder="typescript, javascript"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="bad 示例（可选）">
                <textarea
                  value={editing.examples?.bad ?? ''}
                  onChange={(e) => setEditing({ ...editing, examples: { ...editing.examples, bad: e.target.value } })}
                  rows={4}
                  className={`${inputCls} font-mono text-xs`}
                  placeholder={'import moment from "moment"'}
                />
              </Field>
              <Field label="good 示例（可选）">
                <textarea
                  value={editing.examples?.good ?? ''}
                  onChange={(e) => setEditing({ ...editing, examples: { ...editing.examples, good: e.target.value } })}
                  rows={4}
                  className={`${inputCls} font-mono text-xs`}
                  placeholder={'import dayjs from "dayjs"'}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-600">
              <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} className="accent-zinc-800" />
              启用（关闭后不参与扫描）
            </label>
            <div className="flex items-center gap-2">
              <button onClick={save} disabled={!editing.id.trim()} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40">
                保存
              </button>
              <button onClick={() => setEditing(null)} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-600 hover:border-zinc-400">
                关闭
              </button>
              {error && <ErrorText>{error}</ErrorText>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-400'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

function splitList(s: string): string[] {
  return s
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
}
