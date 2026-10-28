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

/**
 * 时长：45 秒 / 1 分 20 秒 / 2 小时 5 分
 *
 * 不写成「1.3 分钟」—— 那种数字在监控场景里没法一眼比大小。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** 字节：1.2 KB / 3.4 MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 分类 → 中文名 + Element Plus 标签类型 */ export const CATEGORY_LABELS: Record<
  string,
  { label: string; type: string }
> = {
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
