import { db } from './db.js'

/** OpenAI 兼容 Chat Completions 客户端（支持 openrouter / deepseek / ollama 等） */

export interface AiProvider {
  id: number
  name: string
  base_url: string
  api_key: string
  model: string
  is_active: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function getActiveProvider(): AiProvider | null {
  const rows = db
    .prepare('SELECT * FROM ai_providers ORDER BY is_active DESC, id ASC LIMIT 1')
    .get() as AiProvider | undefined
  return rows ?? null
}

export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number; temperature?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const p = getActiveProvider()
  if (!p) throw new Error('未配置 AI Provider，请先在「设置」页添加')

  const body: Record<string, unknown> = {
    model: p.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 8192
  }
  if (opts.json) body.response_format = { type: 'json_object' }

  // 组合超时与外部取消（扫描停止）
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? 300_000)]
  if (opts.signal) signals.push(opts.signal)

  const res = await fetch(`${p.base_url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.api_key}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return data.choices?.[0]?.message?.content ?? ''
}

/** 鲁棒 JSON 提取：剥 markdown 围栏、找第一个平衡的对象/数组 */
export function extractJson<T>(text: string): T {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.search(/[[{]/)
  if (start === -1) throw new Error('AI 输出中未找到 JSON')
  const open = t[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === '\\') {
      esc = true
      continue
    }
    if (c === '"') inStr = !inStr
    if (inStr) continue
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return JSON.parse(t.slice(start, i + 1)) as T
    }
  }
  throw new Error('AI 输出 JSON 不完整')
}
