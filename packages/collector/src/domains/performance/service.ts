import type { Db } from '../../infra/db/client.js'
import { writeJson } from '../../infra/db/dialect.js'
import { parseUserAgent } from '../tenancy/user-agent.js'
import type { Percentiles, PerformanceEvent } from '@vigil/protocol'

/**
 * 性能域。
 *
 * 性能数据和错误数据是两种不同性质的东西：
 *   - 错误：少，但每条都重要 → 实时上报、按指纹聚成 Issue
 *   - 性能：多，绝大多数正常 → 采样上报、按时间桶算分位数
 *
 * 所以性能**不能**塞进错误表 —— 采样策略、保留周期、聚合方式全不同。
 */

export interface TransactionRow {
  id: number
  project_id: number
  environment_id: number | null
  release_id: number | null
  name: string
  type: string
  duration_ms: number
  fcp: number | null
  lcp: number | null
  cls: number | null
  inp: number | null
  ttfb: number | null
  tbt: number | null
  long_task_count: number
  resource_count: number
  transfer_size: number
  page_url: string | null
  browser: string | null
  os: string | null
  device: string | null
  session_id: string | null
  user_id: string | null
  release: string | null
  environment: string | null
  started_at: number
  received_at: number
}

export interface SpanRow {
  id: number
  transaction_id: number
  name: string
  type: string
  duration_ms: number
  status_code: number | null
  url: string | null
  size_bytes: number | null
}

export interface PerformanceQuery {
  projectId: number
  environment?: string
  release?: string
  name?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

export interface PerformanceSummary {
  transactions: number
  vitals: {
    fcp: Percentiles
    lcp: Percentiles
    cls: Percentiles
    inp: Percentiles
    ttfb: Percentiles
    duration: Percentiles
  }
  /** 按页面/路由分组 */
  byName: Array<{ name: string; transactions: number; lcp: Percentiles; duration: Percentiles }>
  /** 最慢的接口 */
  topSpans: Array<{
    name: string
    type: string
    count: number
    avg: number
    max: number
    p95: number
  }>
  /** 慢页面 */
  slowTransactions: Array<{
    id: number
    name: string
    duration_ms: number
    lcp: number | null
    page_url: string | null
  }>
}

export class PerformanceService {
  constructor(private readonly db: Db) {}

  /**
   * 摄入一个性能事务及其 span。
   */
  ingestTransaction(
    projectId: number,
    event: PerformanceEvent,
    context: { environmentId?: number; releaseId?: number } = {}
  ): { transactionId: number; spans: number } {
    const ua = parseUserAgent(event.userAgent ?? '')
    const receivedAt = Date.now()

    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO transactions
           (project_id, environment_id, release_id, name, type, duration_ms,
            fcp, lcp, cls, inp, ttfb, tbt, long_task_count,
            resource_count, transfer_size,
            page_url, referrer, user_agent, browser, os, device,
            session_id, user_id, release, environment,
            started_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          context.environmentId ?? null,
          context.releaseId ?? null,
          event.name,
          event.type,
          Math.round(event.durationMs),
          event.vitals.fcp ?? null,
          event.vitals.lcp ?? null,
          event.vitals.cls ?? null,
          event.vitals.inp ?? null,
          event.vitals.ttfb ?? null,
          event.vitals.tbt ?? null,
          event.vitals.longTaskCount ?? 0,
          event.resourceCount ?? 0,
          event.transferSize ?? 0,
          event.pageUrl ?? null,
          event.referrer ?? null,
          event.userAgent ?? null,
          ua.browser ?? null,
          ua.os ?? null,
          ua.device,
          event.sessionId ?? null,
          event.userId ?? null,
          event.release ?? null,
          event.environment ?? null,
          event.startedAt,
          receivedAt
        ]
      )

      const transactionId = Number(
        this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0
      )

      let spanCount = 0
      for (const span of event.spans ?? []) {
        this.db.run(
          `INSERT INTO spans
             (transaction_id, project_id, name, type, duration_ms, started_at,
              status_code, url, size_bytes, initiator_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transactionId,
            projectId,
            span.name,
            // 老客户端可能不发 type —— 兜底成 custom，别让它把整批事务弄挂
            span.type ?? 'custom',
            Math.round(span.durationMs),
            span.startedAt ?? null,
            span.statusCode ?? null,
            span.url ?? null,
            span.sizeBytes ?? null,
            span.initiatorType ?? null
          ]
        )
        spanCount++
      }

      return { transactionId, spans: spanCount }
    })
  }

  /** 事务列表 */
  listTransactions(query: PerformanceQuery): { total: number; transactions: TransactionRow[] } {
    const conditions = ['project_id = ?']
    const params: unknown[] = [query.projectId]

    if (query.environment) {
      conditions.push('environment = ?')
      params.push(query.environment)
    }
    if (query.release) {
      conditions.push('release = ?')
      params.push(query.release)
    }
    if (query.name) {
      conditions.push('name = ?')
      params.push(query.name)
    }
    if (query.since !== undefined) {
      conditions.push('started_at >= ?')
      params.push(query.since)
    }
    if (query.until !== undefined) {
      conditions.push('started_at < ?')
      params.push(query.until)
    }

    const where = conditions.join(' AND ')

    const total = (
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions WHERE ${where}`,
        params
      ) as {
        n: number
      }
    ).n

    const limit = query.limit ?? 50
    const offset = query.offset ?? 0

    const transactions = this.db.all<TransactionRow>(
      `SELECT * FROM transactions WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    )

    return { total, transactions }
  }

  /**
   * 性能汇总：分位数 + 分页面 + 最慢接口。
   */
  summary(query: PerformanceQuery): PerformanceSummary {
    const conditions = ['project_id = ?']
    const params: unknown[] = [query.projectId]

    if (query.environment) {
      conditions.push('environment = ?')
      params.push(query.environment)
    }
    if (query.release) {
      conditions.push('release = ?')
      params.push(query.release)
    }
    if (query.since !== undefined) {
      conditions.push('started_at >= ?')
      params.push(query.since)
    }
    if (query.until !== undefined) {
      conditions.push('started_at < ?')
      params.push(query.until)
    }

    const where = conditions.join(' AND ')

    const rows = this.db.all<{
      fcp: number | null
      lcp: number | null
      cls: number | null
      inp: number | null
      ttfb: number | null
      duration_ms: number
      name: string
    }>(
      `SELECT fcp, lcp, cls, inp, ttfb, duration_ms, name FROM transactions WHERE ${where}`,
      params
    )

    const collect = (pick: (row: (typeof rows)[number]) => number | null): number[] =>
      rows.map(pick).filter((value): value is number => value !== null && Number.isFinite(value))

    // 按页面分组
    const byNameMap = new Map<string, number[]>()
    for (const row of rows) {
      const list = byNameMap.get(row.name) ?? []
      list.push(row.duration_ms)
      byNameMap.set(row.name, list)
    }

    const lcpByName = new Map<string, number[]>()
    for (const row of rows) {
      if (row.lcp === null) continue
      const list = lcpByName.get(row.name) ?? []
      list.push(row.lcp)
      lcpByName.set(row.name, list)
    }

    const byName = [...byNameMap.entries()]
      .map(([name, durations]) => ({
        name,
        transactions: durations.length,
        lcp: percentiles(lcpByName.get(name) ?? []),
        duration: percentiles(durations)
      }))
      .sort((a, b) => b.transactions - a.transactions)
      .slice(0, 20)

    // 最慢的接口：按 span 的 name 分组
    // 条件用**显式别名**，不做字符串替换 —— 替换会让列名和参数顺序错位
    const spanConditions = ['s.project_id = ?']
    const spanParams: unknown[] = [query.projectId]
    if (query.environment) {
      spanConditions.push('t.environment = ?')
      spanParams.push(query.environment)
    }
    if (query.release) {
      spanConditions.push('t.release = ?')
      spanParams.push(query.release)
    }

    const spanRows = this.db.all<{
      name: string
      type: string
      duration_ms: number
    }>(
      `SELECT s.name, s.type, s.duration_ms FROM spans s
       JOIN transactions t ON t.id = s.transaction_id
       WHERE ${spanConditions.join(' AND ')}`,
      spanParams
    )

    const spanGroups = new Map<string, number[]>()
    for (const row of spanRows) {
      const key = `${row.type}::${row.name}`
      const list = spanGroups.get(key) ?? []
      list.push(row.duration_ms)
      spanGroups.set(key, list)
    }

    const topSpans = [...spanGroups.entries()]
      .map(([key, durations]) => {
        const [type, name] = key.split('::')
        const p = percentiles(durations)
        return {
          name,
          type,
          count: durations.length,
          avg: p.avg,
          max: p.max,
          p95: p.p95
        }
      })
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, 15)

    const slowTransactions = this.db.all<{
      id: number
      name: string
      duration_ms: number
      lcp: number | null
      page_url: string | null
    }>(
      `SELECT id, name, duration_ms, lcp, page_url FROM transactions
       WHERE ${where} ORDER BY duration_ms DESC LIMIT 10`,
      params
    )

    return {
      transactions: rows.length,
      vitals: {
        fcp: percentiles(collect((r) => r.fcp)),
        lcp: percentiles(collect((r) => r.lcp)),
        cls: percentiles(collect((r) => r.cls)),
        inp: percentiles(collect((r) => r.inp)),
        ttfb: percentiles(collect((r) => r.ttfb)),
        duration: percentiles(collect((r) => r.duration_ms))
      },
      byName,
      topSpans,
      slowTransactions
    }
  }

  /**
   * 错误与性能关联的聚合视图：
   * 哪些错误发生时页面 LCP 明显更差。
   *
   * 这张表能回答「这个错误是不是拖慢了这页」。
   */
  errorPerformanceCorrelation(
    projectId: number,
    since?: number
  ): Array<{ fingerprint: string; title: string; count: number; avgLcp: number | null }> {
    const conditions = ['e.project_id = ?']
    const params: unknown[] = [projectId]

    if (since !== undefined) {
      conditions.push('e.occurred_at >= ?')
      params.push(since)
    }

    return this.db.all(
      `SELECT i.fingerprint,
              i.title,
              COUNT(*) AS count,
              AVG(CAST(json_extract(e.vitals_json, '$.lcp') AS INTEGER)) AS avgLcp
       FROM issue_events e
       JOIN issues i ON i.id = e.issue_id
       WHERE ${conditions.join(' AND ')} AND e.vitals_json IS NOT NULL
       GROUP BY i.fingerprint
       HAVING avgLcp IS NOT NULL
       ORDER BY count DESC
       LIMIT 20`,
      params
    )
  }
}

/**
 * 分位数。
 *
 * SQLite 没有 `percentile_disc`（PG 有），所以在应用层算。
 *
 * 用**最近秩法**（nearest-rank）：P95 = 排序后第 ceil(0.95 * n) 个值。
 * 相比线性插值，它保证返回值**一定是实际观测到的值** ——
 * 对监控场景更诚实（不会报出一个从未出现过的延迟）。
 */
export function percentiles(values: number[]): Percentiles {
  if (values.length === 0) {
    return { count: 0, p50: 0, p75: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
    return sorted[index]
  }

  const sum = sorted.reduce((acc, value) => acc + value, 0)

  return {
    count: sorted.length,
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    p99: at(0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round((sum / sorted.length) * 100) / 100
  }
}

export { writeJson }
