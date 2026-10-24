/** 管理 API 的返回结构（与 Collector 的 /api/v1 响应一致） */

export interface AppInfo {
  app_id: string
  name: string
  enabled: number
  created_at: number
  last_seen_at: number | null
}

export interface ErrorRow {
  id: number
  fingerprint: string
  category: 'javascript' | 'resource' | 'http'
  kind: string
  name: string | null
  message: string
  url: string | null
  url_path: string | null
  browser: string | null
  os: string | null
  device: string | null
  environment: string | null
  release: string | null
  first_seen: number
  last_seen: number
  count: number
}

export interface CategoryStat {
  category: string
  n: number
  occurrences: number
}

export interface EndpointStat {
  url_path: string
  n: number
  occurrences: number
}

export interface BrowserStat {
  browser: string
  n: number
}

export interface TopError {
  fingerprint: string
  message: string
  name: string | null
  count: number
  last_seen: number
}

export interface Stats {
  totals: { distinct_errors: number; occurrences: number }
  byCategory: CategoryStat[]
  topErrors: TopError[]
  topEndpoints: EndpointStat[]
  browsers: BrowserStat[]
}

export interface ResolvedFrame {
  filename: string
  lineno?: number
  colno?: number
  functionName?: string
  original?: {
    filename: string
    lineno: number
    colno: number
    functionName?: string
    source?: string
  }
}

export interface ErrorDetail {
  error: ErrorRow & {
    raw_stack: string | null
    resolved_stack: string | null
    http_json: string | null
    resource_json: string | null
    referrer: string | null
    user_agent: string | null
    session_id: string | null
    user_id: string | null
  }
  events: Array<{
    id: number
    occurred_at: number
    received_at: number
    payload_json: string
  }>
}
