import type { AppInfo, ErrorDetail, ErrorRow, Stats } from './types'

/**
 * 管理 API 客户端。
 *
 * 管理 token **不在前端** —— Vite dev server 的代理层会注入它。
 * 所以这里不需要（也不应该）带任何鉴权头。
 */

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${response.status} ${text.slice(0, 200)}`)
  }

  const body = (await response.json()) as { ok: boolean; error?: string } & T
  if (body.ok === false) {
    throw new Error(body.error ?? '请求失败')
  }
  return body
}

export function fetchApps(): Promise<{ apps: AppInfo[] }> {
  return request('/api/v1/apps')
}

export function fetchErrors(
  appId: string,
  params: { limit?: number; offset?: number; q?: string; category?: string } = {}
): Promise<{ total: number; limit: number; offset: number; errors: ErrorRow[] }> {
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.offset) query.set('offset', String(params.offset))
  if (params.q) query.set('q', params.q)
  if (params.category) query.set('category', params.category)

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request(`/api/v1/apps/${appId}/errors${suffix}`)
}

export function fetchStats(appId: string): Promise<Stats> {
  return request(`/api/v1/apps/${appId}/stats`)
}

export function fetchErrorDetail(appId: string, fingerprint: string): Promise<ErrorDetail> {
  return request(`/api/v1/apps/${appId}/errors/${fingerprint}`)
}
