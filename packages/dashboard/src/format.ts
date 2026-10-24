/** 相对时间 + 绝对时间 + 分类标签映射 */

/** 相对时间：3 分钟前 / 2 小时前 / 5 天前 */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return formatDate(timestamp)
}

/** 绝对时间：2026-10-24 14:03 */
export function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 分类 → 中文名 + Element Plus 标签类型 */
export const CATEGORY_LABELS: Record<string, { label: string; type: string }> = {
  javascript: { label: 'JS 错误', type: 'danger' },
  resource: { label: '资源加载', type: 'warning' },
  http: { label: '接口错误', type: 'info' }
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category]?.label ?? category
}

export function categoryType(category: string): string {
  return CATEGORY_LABELS[category]?.type ?? 'info'
}
