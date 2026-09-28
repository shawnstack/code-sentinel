export const SEVERITY_LABEL: Record<string, string> = {
  bug: 'Bug',
  major: '主要',
  important: '重要',
  minor: '轻微',
  style: '代码风格'
}

export const SEVERITY_ORDER: Record<string, number> = {
  bug: 0,
  major: 1,
  important: 2,
  minor: 3,
  style: 4
}

export const SEVERITIES = ['bug', 'major', 'important', 'minor', 'style']

export const RULE_TYPE_LABEL: Record<string, string> = {
  bad_case: 'Bad Case',
  good_case: 'Good Case',
  rule: 'Rule'
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : iso + 'Z')
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 2592000_000) return `${Math.floor(diff / 86400_000)} 天前`
  return d.toLocaleDateString('zh-CN')
}
