import type { Db } from '../../infra/db/client.js'
import { bucketExpr } from '../../infra/db/dialect.js'
import type { ErrorTrend, TrendBucket, TrendPoint } from '@vigil/protocol'

/**
 * 错误趋势（跨域读模型）。
 *
 * ## 为什么单独一个域
 *
 * 趋势要回答「错误涨了没有」。要回答这个，光有错误次数不够 ——
 * 得配上**分母**（页面访问数）才算得出错误率。
 *
 * 错误次数来自问题域，页面访问数来自性能域。
 * 这个视图横跨两个域，塞进任何一边都是把边界搞脏，
 * 所以它自己是一个**读模型**：只读两张表，不写任何东西。
 *
 * ## 为什么分桶要补齐空桶
 *
 * 查出来的是「有数据的桶」。直接画出来的话，
 * 2 月 3 日没数据 → 图上就少了一格 → 看起来像「那天没问题」。
 *
 * 实际上那天可能只是没流量。补齐成 0 才是诚实的。
 */

const HOUR = 3600_000
const DAY = 24 * HOUR

export interface TrendOptions {
  /** 窗口起点（epoch 毫秒，左闭） */
  since?: number
  /** 窗口终点（epoch 毫秒，右开） */
  until?: number
  /** 分桶粒度，默认按天 */
  bucket?: TrendBucket
  /** 时区偏移（分钟，UTC 以东为正），用来把「天」的边界对齐用户本地午夜 */
  tzOffsetMinutes?: number
}

export class TrendService {
  constructor(private readonly db: Db) {}

  /**
   * 错误趋势。
   *
   * 没有给窗口时按粒度给一个默认跨度：
   * 按小时看最近 24 小时，按天看最近 30 天。
   */
  async errorTrend(projectId: number, options: TrendOptions = {}): Promise<ErrorTrend> {
    const bucket = options.bucket ?? 'day'
    const bucketMs = bucket === 'hour' ? HOUR : DAY
    const tzOffset = options.tzOffsetMinutes ?? 0

    const until = options.until ?? Date.now()
    const since = options.since ?? until - (bucket === 'hour' ? 24 * HOUR : 30 * DAY)

    // ---- 错误桶 ----
    const errorRows = await this.db.all<{
      bucket: number
      occurrences: number
      users: number
      issues: number
    }>(
      `SELECT ${bucketExpr('occurred_at', bucketMs, tzOffset)} AS bucket,
              COUNT(*) AS occurrences,
              COUNT(DISTINCT user_id) AS users,
              COUNT(DISTINCT issue_id) AS issues
       FROM issue_events
       WHERE project_id = ? AND occurred_at >= ? AND occurred_at < ?
       GROUP BY bucket`,
      [projectId, since, until]
    )

    // ---- 新增问题桶 ----
    const newRows = await this.db.all<{ bucket: number; n: number }>(
      `SELECT ${bucketExpr('first_seen', bucketMs, tzOffset)} AS bucket, COUNT(*) AS n
       FROM issues
       WHERE project_id = ? AND first_seen >= ? AND first_seen < ?
       GROUP BY bucket`,
      [projectId, since, until]
    )

    // ---- 页面访问桶（错误率的分母）----
    const txRows = await this.db.all<{ bucket: number; n: number }>(
      `SELECT ${bucketExpr('started_at', bucketMs, tzOffset)} AS bucket, COUNT(*) AS n
       FROM transactions
       WHERE project_id = ? AND started_at >= ? AND started_at < ?
       GROUP BY bucket`,
      [projectId, since, until]
    )

    const errorMap = new Map(errorRows.map((row) => [row.bucket, row]))
    const newMap = new Map(newRows.map((row) => [row.bucket, row.n]))
    const txMap = new Map(txRows.map((row) => [row.bucket, row.n]))

    // ---- 补齐时间轴 ----
    const points: TrendPoint[] = []
    const startBucket = bucketStart(since, bucketMs, tzOffset)

    // 只画**起点落在窗口内**的桶。
    // 窗口右端如果正好落在桶边界上，那个桶属于窗口之外，不该画 ——
    // 否则图上会多一根永远为 0 的柱子。
    for (let t = startBucket; t < until; t += bucketMs) {
      const errors = errorMap.get(t)
      const occurrences = errors?.occurrences ?? 0
      const transactions = txMap.get(t) ?? 0

      points.push({
        timestamp: t,
        occurrences,
        users: errors?.users ?? 0,
        issues: errors?.issues ?? 0,
        newIssues: newMap.get(t) ?? 0,
        transactions,
        // 分母为 0 时是 null —— 「没访问过」和「真的没错」不是一回事
        errorRate: transactions > 0 ? occurrences / transactions : null
      })
    }

    return { bucket, points }
  }
}

/**
 * 某个时刻所在桶的**起点**。
 *
 * 桶起点要跟 SQL 里的分桶表达式**完全一致**，
 * 否则合并时会一个都对不上（差一个时区偏移就全错位）。
 */
function bucketStart(timestamp: number, bucketMs: number, tzOffsetMinutes: number): number {
  const offsetMs = Math.round(tzOffsetMinutes) * 60_000
  // 本地时间 = UTC + 偏移 → 本地第几天 = (t + offset) / bucketMs
  // 桶起点（epoch）= 本地第几天起点 - 偏移
  return Math.floor((timestamp + offsetMs) / bucketMs) * bucketMs - offsetMs
}
