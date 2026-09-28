import { useState } from 'react'
import type { Issue, Rule } from '../types'
import { SeverityBadge } from './ui'

/** 行内问题评论卡片：等级 + 触犯 case + AI 发现 + blame 作者 + 修复勾选 */
export default function IssueCard({
  issue,
  rules,
  selected,
  onToggleSelect,
  onStatus
}: {
  issue: Issue
  rules: Rule[]
  selected: boolean
  onToggleSelect: () => void
  onStatus: (status: string) => void
}) {
  const [showRule, setShowRule] = useState<string | null>(null)
  const ruleIds: string[] = issue.rule_ids ? JSON.parse(issue.rule_ids) : []
  const relatedRules = rules.filter((r) => ruleIds.includes(r.id))

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      {/* 头部 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SeverityBadge severity={issue.severity} />
        <span
          className={`rounded border px-1.5 py-0 text-[11px] ${
            issue.source === 'rule_match'
              ? 'border-red-200 bg-red-50 text-red-600'
              : 'border-violet-200 bg-violet-50 text-violet-600'
          }`}
        >
          {issue.source === 'rule_match' ? '规则触发器命中' : 'AI 发现'}
        </span>
        {issue.confidence && (
          <span className="text-[11px] text-zinc-400">
            置信度 {issue.confidence === 'high' ? '高' : issue.confidence === 'medium' ? '中' : '低'}
          </span>
        )}
        {issue.author && (
          <span className="text-[11px] text-zinc-400">
            最后修改：{issue.author}
            {issue.blame_date ? ` · ${issue.blame_date.slice(0, 10)}` : ''}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {issue.status === 'open' ? (
            <>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-zinc-600">
                <input type="checkbox" checked={selected} onChange={onToggleSelect} className="accent-zinc-800" />
                加入 AI 修复
              </label>
              <button onClick={() => onStatus('resolved')} className="rounded border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-500 hover:border-emerald-300 hover:text-emerald-600">
                已解决
              </button>
              <button onClick={() => onStatus('wont_fix')} className="rounded border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-500 hover:border-zinc-300 hover:text-zinc-700">
                不改
              </button>
            </>
          ) : (
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">
              {issue.status === 'resolved' ? '已解决' : '标记不改'}
              <button onClick={() => onStatus('open')} className="ml-2 text-zinc-400 underline hover:text-zinc-700">
                撤销
              </button>
            </span>
          )}
        </span>
      </div>

      {/* 标题与描述 */}
      <div className="text-sm font-medium text-zinc-900">{issue.title}</div>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600">{issue.description}</p>

      {/* 触犯的规则 */}
      {relatedRules.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-400">触犯规则：</span>
          {relatedRules.map((r) => (
            <span key={r.id}>
              <button
                onClick={() => setShowRule(showRule === r.id ? null : r.id)}
                className="rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[11px] text-zinc-600 hover:border-zinc-400"
              >
                {r.type === 'bad_case' ? '🚫' : r.type === 'good_case' ? '✅' : '📐'} {r.id}
              </button>
              {showRule === r.id && (
                <span className="mt-1 block w-full rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-600">
                  <span className="font-medium text-zinc-800">
                    {r.name}（{r.type}，严重度 {r.severity}）
                  </span>
                  <br />
                  {r.description}
                  {r.examples?.bad && (
                    <span className="mt-2 block">
                      <span className="text-red-500">bad:</span>
                      <pre className="mt-1 overflow-x-auto rounded bg-white p-2 font-mono text-[11px]">{r.examples.bad}</pre>
                    </span>
                  )}
                  {r.examples?.good && (
                    <span className="mt-2 block">
                      <span className="text-emerald-600">good:</span>
                      <pre className="mt-1 overflow-x-auto rounded bg-white p-2 font-mono text-[11px]">{r.examples.good}</pre>
                    </span>
                  )}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* 修改建议 */}
      {issue.suggestion && (
        <div className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-sm leading-relaxed text-emerald-800">
          <span className="font-medium">修改建议：</span>
          <span className="whitespace-pre-wrap">{issue.suggestion}</span>
        </div>
      )}
    </div>
  )
}
