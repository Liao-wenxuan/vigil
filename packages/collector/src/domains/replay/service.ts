import type { Db } from '../../infra/db/client.js'
import { bucketExpr, readJson, writeJson } from '../../infra/db/dialect.js'
import { parseUserAgent } from '../tenancy/user-agent.js'
import type {
  BehaviorEnvelope,
  BehaviorEvent,
  BehaviorSummary,
  ReplayEvent,
  ReplayPayload,
  SessionSummary
} from '@vigil/protocol'

/**
 * 会话回放与用户行为。
 *
 * ## 回放按会话存最新一份
 *
 * 客户端的缓冲区是**滚动窗口**：第 2 个错误带的上传窗口比第 1 个更长。
 * 每个错误都存一份 = 大量重复数据。
 *
 * 所以：**每个会话只保留最新的一份回放流**。
 * 代价是回放展示的是「最近一次快照」，不精确对应每个错误的时间点 ——
 * 这个限制写进了文档，不藏着。
 *
 * 好处是存储有界：一个会话一份流，不会随错误数线性膨胀。
 */
export interface ReplayServiceOptions {
  /** 保留多少天的行为数据 */
  retentionDays?: number
}

/** 一天（毫秒）—— 按天分桶用 */
const DAY_MS = 24 * 3600_000

/**
 * 桶起点 → 日期字符串（YYYY-MM-DD）。
 *
 * 按**本地时区**格式化：桶边界已经是用户本地午夜了，
 * 再用 `toISOString()` 会退回到 UTC，日期就差一天。
 */
function formatBucketDate(bucketStart: number, tzOffsetMinutes: number): string {
  const shifted = new Date(bucketStart + Math.round(tzOffsetMinutes) * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

export class ReplayService {
  constructor(private readonly db: Db) {}

  /**
   * 摄入行为事件与会话汇总。
   */
  async ingestBehavior(
    projectId: number,
    envelope: BehaviorEnvelope
  ): Promise<{ accepted: number }> {
    const events = envelope.events ?? []
    if (events.length === 0 && !envelope.session) return { accepted: 0 }

    return await this.db.transaction(async () => {
      for (const event of events) {
        await this.db.run(
          `INSERT INTO behavior_events
             (project_id, session_id, user_id, type, name, url, timestamp, duration_ms, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            projectId,
            event.sessionId ?? envelope.session?.sessionId ?? 'unknown',
            event.userId ?? envelope.session?.userId ?? null,
            event.type,
            event.name,
            event.url ?? null,
            event.timestamp,
            event.durationMs ?? null,
            writeJson(event.data ?? null)
          ]
        )
      }

      if (envelope.session) {
        await this.upsertSession(projectId, envelope.session)
      }

      return { accepted: events.length }
    })
  }

  /**
   * 写入回放事件流。
   *
   * 全量替换该会话已有的流 —— 客户端送来的永远是**更新更全**的窗口。
   */
  async saveReplay(
    projectId: number,
    sessionId: string,
    payload: ReplayPayload,
    context: { userId?: string; occurredAt?: number } = {}
  ): Promise<{ events: number; bytes: number }> {
    const events = payload.events ?? []
    if (events.length === 0) return { events: 0, bytes: 0 }

    const now = Date.now()

    return await this.db.transaction(async () => {
      // 该会话的旧流作废（客户端送的是更新更全的窗口）
      await this.db.run('DELETE FROM replay_events WHERE project_id = ? AND session_id = ?', [
        projectId,
        sessionId
      ])

      for (const [seq, event] of events.entries()) {
        // `ON CONFLICT DO UPDATE` —— SQLite 3.24+ 与 PG 都支持。
        // ⚠️ 别用 `INSERT OR REPLACE` —— 那是 SQLite 独有的语法，PG 上直接报错。
        await this.db.run(
          `INSERT INTO replay_events
             (project_id, session_id, seq, timestamp, event_type, data_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, session_id, seq) DO UPDATE SET
             timestamp = excluded.timestamp,
             event_type = excluded.event_type,
             data_json = excluded.data_json,
             created_at = excluded.created_at`,
          [
            projectId,
            sessionId,
            seq,
            event.timestamp,
            event.type,
            writeJson(event.data ?? null),
            now
          ]
        )
      }

      const bytes = payload.bytes ?? 0

      // 会话行可能还不存在 —— **回放比行为汇总先到是常态**：
      // 错误是立即上报的，行为汇总要等攒批或页面卸载。
      // 只 UPDATE 的话，这一行永远建不出来，
      // 结果是「回放事件在库里，但会话列表里看不到它」。
      await this.ensureSessionRow(projectId, sessionId, context.userId, now, events)

      await this.db.run(
        `UPDATE replay_sessions
         SET replay_events = ?, replay_bytes = ?, replay_updated_at = ?, user_id = COALESCE(user_id, ?)
         WHERE project_id = ? AND session_id = ?`,
        [events.length, bytes, now, context.userId ?? null, projectId, sessionId]
      )

      return { events: events.length, bytes }
    })
  }

  /**
   * 保证会话行存在。
   *
   * 先由回放到达、行为汇总后到的顺序下，
   * 这一步是会话能出现在列表里的前提。
   */
  private async ensureSessionRow(
    projectId: number,
    sessionId: string,
    userId: string | undefined,
    now: number,
    events: ReplayEvent[]
  ): Promise<void> {
    const existing = await this.db.get<{ id: number }>(
      'SELECT id FROM replay_sessions WHERE project_id = ? AND session_id = ?',
      [projectId, sessionId]
    )
    if (existing) return

    // 起始时间取流的第一个事件 —— 比用「现在」更接近真实会话开始
    const startedAt = events[0]?.timestamp ?? now

    await this.db.run(
      `INSERT INTO replay_sessions
         (project_id, session_id, user_id, started_at, ended_at, duration_ms, page_views, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
      [projectId, sessionId, userId ?? null, startedAt, now, now]
    )
  }

  /** 写入 / 更新会话汇总 */
  async upsertSession(projectId: number, session: SessionSummary): Promise<void> {
    const ua = parseUserAgent(session.userAgent ?? '')
    const now = Date.now()

    const existing = await this.db.get<{ id: number }>(
      'SELECT id FROM replay_sessions WHERE project_id = ? AND session_id = ?',
      [projectId, session.sessionId]
    )

    if (existing) {
      await this.db.run(
        `UPDATE replay_sessions SET
           user_id = COALESCE(user_id, ?),
           ended_at = ?, duration_ms = ?, page_views = ?,
           entry_page = COALESCE(entry_page, ?), exit_page = ?,
           path_json = ?, user_agent = COALESCE(user_agent, ?),
           browser = COALESCE(browser, ?), os = COALESCE(os, ?), device = COALESCE(device, ?),
           referrer = COALESCE(referrer, ?)
         WHERE id = ?`,
        [
          session.userId ?? null,
          session.endedAt,
          session.durationMs,
          session.pageViews,
          session.entryPage ?? null,
          session.exitPage ?? null,
          writeJson(session.path ?? null),
          session.userAgent ?? null,
          ua.browser ?? null,
          ua.os ?? null,
          ua.device,
          session.referrer ?? null,
          existing.id
        ]
      )
      return
    }

    await this.db.run(
      `INSERT INTO replay_sessions
         (project_id, session_id, user_id, started_at, ended_at, duration_ms, page_views,
          entry_page, exit_page, path_json, user_agent, browser, os, device, referrer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        session.sessionId,
        session.userId ?? null,
        session.startedAt,
        session.endedAt,
        session.durationMs,
        session.pageViews,
        session.entryPage ?? null,
        session.exitPage ?? null,
        writeJson(session.path ?? null),
        session.userAgent ?? null,
        ua.browser ?? null,
        ua.os ?? null,
        ua.device,
        session.referrer ?? null,
        now
      ]
    )
  }

  /** 累加会话的错误数 */
  async incrementSessionError(projectId: number, sessionId: string): Promise<void> {
    await this.db.run(
      'UPDATE replay_sessions SET error_count = error_count + 1 WHERE project_id = ? AND session_id = ?',
      [projectId, sessionId]
    )
  }

  // ==========================================================
  // 查询
  // ==========================================================

  /** 取某个会话的回放事件流（按 seq 排序，播放器需要连续） */
  async getReplay(projectId: number, sessionId: string): Promise<ReplayEvent[]> {
    const rows = await this.db.all<{
      seq: number
      timestamp: number
      event_type: number
      data_json: string | null
    }>(
      `SELECT seq, timestamp, event_type, data_json FROM replay_events
       WHERE project_id = ? AND session_id = ? ORDER BY seq`,
      [projectId, sessionId]
    )

    return rows.map((row) => ({
      type: row.event_type,
      timestamp: row.timestamp,
      data: readJson<unknown>(row.data_json) ?? {}
    }))
  }

  /** 会话列表 */
  async listSessions(
    projectId: number,
    options: { limit?: number; offset?: number; withReplay?: boolean } = {}
  ): Promise<{ total: number; sessions: Array<Record<string, unknown>> }> {
    const limit = options.limit ?? 50
    const offset = options.offset ?? 0

    const total = (
      (await this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM replay_sessions WHERE project_id = ?',
        [projectId]
      )) as { n: number }
    ).n

    const rows = await this.db.all<{
      session_id: string
      user_id: string | null
      started_at: number
      ended_at: number
      duration_ms: number
      page_views: number
      entry_page: string | null
      exit_page: string | null
      path_json: string | null
      browser: string | null
      os: string | null
      device: string | null
      referrer: string | null
      error_count: number
      replay_events: number
      replay_bytes: number
      replay_updated_at: number | null
    }>(
      `SELECT session_id, user_id, started_at, ended_at, duration_ms, page_views,
              entry_page, exit_page, path_json, browser, os, device, referrer,
              error_count, replay_events, replay_bytes, replay_updated_at
       FROM replay_sessions WHERE project_id = ?
       ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      [projectId, limit, offset]
    )

    return {
      total,
      sessions: rows.map((row) => ({
        sessionId: row.session_id,
        userId: row.user_id ?? undefined,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: row.duration_ms,
        pageViews: row.page_views,
        entryPage: row.entry_page ?? undefined,
        exitPage: row.exit_page ?? undefined,
        path: readJson<string[]>(row.path_json) ?? [],
        browser: row.browser ?? undefined,
        os: row.os ?? undefined,
        device: row.device ?? undefined,
        referrer: row.referrer ?? undefined,
        errorCount: row.error_count,
        hasReplay: row.replay_events > 0,
        replayEvents: row.replay_events,
        replayBytes: row.replay_bytes,
        replayUpdatedAt: row.replay_updated_at ?? undefined
      }))
    }
  }

  /**
   * 行为汇总。
   *
   * 全部在 SQL 里聚合 —— 数据量大时把明细拉回 Node 再统计是自杀。
   */
  async summary(
    projectId: number,
    options: { since?: number; until?: number; tzOffsetMinutes?: number } = {}
  ): Promise<BehaviorSummary> {
    const conditions = ['project_id = ?']
    const params: unknown[] = [projectId]

    if (options.since !== undefined) {
      conditions.push('timestamp >= ?')
      params.push(options.since)
    }
    if (options.until !== undefined) {
      conditions.push('timestamp < ?')
      params.push(options.until)
    }
    const where = conditions.join(' AND ')

    const totals = (await this.db.get<{
      page_views: number
      sessions: number
      users: number
      avg_duration: number
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END), 0) AS page_views,
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(DISTINCT user_id) AS users,
         COALESCE(AVG(duration_ms), 0) AS avg_duration
       FROM behavior_events WHERE ${where}`,
      params
    ))!

    const topPages = await this.db.all<{
      name: string
      views: number
      avg_duration: number
    }>(
      `SELECT name, COUNT(*) AS views, COALESCE(AVG(duration_ms), 0) AS avg_duration
       FROM behavior_events WHERE ${where} AND type = 'pageview'
       GROUP BY name ORDER BY views DESC LIMIT 20`,
      params
    )

    const clicks = await this.db.all<{ name: string; count: number }>(
      `SELECT name, COUNT(*) AS count
       FROM behavior_events WHERE ${where} AND type = 'click'
       GROUP BY name ORDER BY count DESC LIMIT 20`,
      params
    )

    const sessionConditions = ['project_id = ?']
    const sessionParams: unknown[] = [projectId]
    if (options.since !== undefined) {
      sessionConditions.push('started_at >= ?')
      sessionParams.push(options.since)
    }
    const sessionWhere = sessionConditions.join(' AND ')

    const entryPages = await this.db.all<{ path: string; count: number }>(
      `SELECT entry_page AS path, COUNT(*) AS count
       FROM replay_sessions WHERE ${sessionWhere} AND entry_page IS NOT NULL
       GROUP BY entry_page ORDER BY count DESC LIMIT 10`,
      sessionParams
    )

    const exitPages = await this.db.all<{ path: string; count: number }>(
      `SELECT exit_page AS path, COUNT(*) AS count
       FROM replay_sessions WHERE ${sessionWhere} AND exit_page IS NOT NULL
       GROUP BY exit_page ORDER BY count DESC LIMIT 10`,
      sessionParams
    )

    const trend = await this.db.all<{ day: number; views: number; sessions: number }>(
      `SELECT ${bucketExpr('timestamp', DAY_MS, options.tzOffsetMinutes)} AS day,
              COUNT(*) AS views,
              COUNT(DISTINCT session_id) AS sessions
       FROM behavior_events WHERE ${where}
       GROUP BY day ORDER BY day`,
      params
    )

    // 访问路径：从会话的 path_json 聚合
    const pathRows = await this.db.all<{ path_json: string | null }>(
      `SELECT path_json FROM replay_sessions WHERE ${sessionWhere} AND path_json IS NOT NULL`,
      sessionParams
    )
    const pathCounts = new Map<string, number>()
    for (const row of pathRows) {
      const path = readJson<string[]>(row.path_json)
      if (!path || path.length === 0) continue
      const key = path.slice(0, 5).join(' → ')
      pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1)
    }
    const topPaths = [...pathCounts.entries()]
      .map(([path, count]) => ({ path: path.split(' → '), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    // 跳出率：只访问了一个页面的会话占比
    const bounceRows = await this.db.all<{ page_views: number }>(
      `SELECT page_views FROM replay_sessions WHERE ${sessionWhere}`,
      sessionParams
    )
    const bounced = bounceRows.filter((row) => row.page_views <= 1).length

    return {
      pageViews: totals.page_views,
      sessions: totals.sessions,
      users: totals.users,
      avgDurationMs: Math.round(totals.avg_duration),
      topPages: topPages.map((row) => ({
        path: row.name,
        views: row.views,
        avgDurationMs: Math.round(row.avg_duration),
        bounceRate: totals.sessions > 0 ? Math.round((bounced / totals.sessions) * 100) / 100 : 0
      })),
      entryPages,
      exitPages,
      topPaths,
      clicks,
      trend: trend.map((row) => ({
        date: formatBucketDate(row.day, options.tzOffsetMinutes ?? 0),
        views: row.views,
        sessions: row.sessions
      }))
    }
  }

  /** 某个会话的行为明细（时间线） */
  async listSessionEvents(projectId: number, sessionId: string): Promise<BehaviorEvent[]> {
    const rows = await this.db.all<{
      type: string
      name: string
      url: string | null
      timestamp: number
      duration_ms: number | null
      user_id: string | null
      session_id: string
      data_json: string | null
    }>(
      `SELECT type, name, url, timestamp, duration_ms, user_id, session_id, data_json
       FROM behavior_events WHERE project_id = ? AND session_id = ?
       ORDER BY timestamp`,
      [projectId, sessionId]
    )

    return rows.map((row) => ({
      type: row.type as BehaviorEvent['type'],
      name: row.name,
      url: row.url ?? '',
      timestamp: row.timestamp,
      durationMs: row.duration_ms ?? undefined,
      data: readJson<Record<string, unknown>>(row.data_json)
    }))
  }
}
