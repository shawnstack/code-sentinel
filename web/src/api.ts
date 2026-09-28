async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `请求失败 ${res.status}`)
  }
  return data as T
}

export const apiGet = <T>(url: string) => req<T>('GET', url)
export const apiPost = <T>(url: string, body?: unknown) => req<T>('POST', url, body ?? {})
export const apiPut = <T>(url: string, body?: unknown) => req<T>('PUT', url, body ?? {})
export const apiPatch = <T>(url: string, body?: unknown) => req<T>('PATCH', url, body ?? {})
export const apiDelete = <T>(url: string) => req<T>('DELETE', url)

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
