import type { Db } from '../../infra/db/client.js'
import { readJson, writeJson } from '../../infra/db/dialect.js'
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

export class ReplayService {
  constructor(private readonly db: Db) {}

  /**
   * 摄入行为事件与会话汇总。
   */
  ingestBehavior(projectId: number, envelope: BehaviorEnvelope): { accepted: number } {
    const events = envelope.events ?? []
    if (events.length === 0 && !envelope.session) return { accepted: 0 }

    return this.db.transaction(() => {
      for (const event of events) {
        this.db.run(
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
        this.upsertSession(projectId, envelope.session)
      }

      return { accepted: events.length }
    })
  }

  /**
   * 写入回放事件流。
   *
   * 全量替换该会话已有的流 —— 客户端送来的永远是**更新更全**的窗口。
   */
  saveReplay(
    projectId: number,
    sessionId: string,
    payload: ReplayPayload,
    context: { userId?: string; occurredAt?: number } = {}
  ): { events: number; bytes: number } {
    const events = payload.events ?? []
    if (events.length === 0) return { events: 0, bytes: 0 }

    const now = Date.now()

    return this.db.transaction(() => {
      // 该会话的旧流作废（客户端送的是更新更全的窗口）
      this.db.run('DELETE FROM replay_events WHERE project_id = ? AND session_id = ?', [
        projectId,
        sessionId
      ])

      for (const [seq, event] of events.entries()) {
        this.db.run(
          `INSERT OR REPLACE INTO replay_events
             (project_id, session_id, seq, timestamp, event_type, data_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

      // 会话可能还没上报过（用户没触发任何行为事件），这里补一条
      this.db.run(
        `UPDATE replay_sessions
         SET replay_events = ?, replay_bytes = ?, replay_updated_at = ?, user_id = COALESCE(user_id, ?)
         WHERE project_id = ? AND session_id = ?`,
        [events.length, bytes, now, context.userId ?? null, projectId, sessionId]
      )

      return { events: events.length, bytes }
    })
  }

  /** 写入 / 更新会话汇总 */
  upsertSession(projectId: number, session: SessionSummary): void {
    const ua = parseUserAgent(session.userAgent ?? '')
    const now = Date.now()

    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM replay_sessions WHERE project_id = ? AND session_id = ?',
      [projectId, session.sessionId]
    )

    if (existing) {
      this.db.run(
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

    this.db.run(
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
  incrementSessionError(projectId: number, sessionId: string): void {
    this.db.run(
      'UPDATE replay_sessions SET error_count = error_count + 1 WHERE project_id = ? AND session_id = ?',
      [projectId, sessionId]
    )
  }

  // ==========================================================
  // 查询
  // ==========================================================

  /** 取某个会话的回放事件流（按 seq 排序，播放器需要连续） */
  getReplay(projectId: number, sessionId: string): ReplayEvent[] {
    const rows = this.db.all<{
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
  listSessions(
    projectId: number,
    options: { limit?: number; offset?: number; withReplay?: boolean } = {}
  ): { total: number; sessions: Array<Record<string, unknown>> } {
    const limit = options.limit ?? 50
    const offset = options.offset ?? 0

    const total = (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM replay_sessions WHERE project_id = ?', [
        projectId
      ]) as { n: number }
    ).n

    const rows = this.db.all<{
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
  summary(projectId: number, options: { since?: number; until?: number } = {}): BehaviorSummary {
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

    const totals = this.db.get<{
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
    )!

    const topPages = this.db.all<{
      name: string
      views: number
      avg_duration: number
    }>(
      `SELECT name, COUNT(*) AS views, COALESCE(AVG(duration_ms), 0) AS avg_duration
       FROM behavior_events WHERE ${where} AND type = 'pageview'
       GROUP BY name ORDER BY views DESC LIMIT 20`,
      params
    )

    const clicks = this.db.all<{ name: string; count: number }>(
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

    const entryPages = this.db.all<{ path: string; count: number }>(
      `SELECT entry_page AS path, COUNT(*) AS count
       FROM replay_sessions WHERE ${sessionWhere} AND entry_page IS NOT NULL
       GROUP BY entry_page ORDER BY count DESC LIMIT 10`,
      sessionParams
    )

    const exitPages = this.db.all<{ path: string; count: number }>(
      `SELECT exit_page AS path, COUNT(*) AS count
       FROM replay_sessions WHERE ${sessionWhere} AND exit_page IS NOT NULL
       GROUP BY exit_page ORDER BY count DESC LIMIT 10`,
      sessionParams
    )

    const trend = this.db.all<{ day: number; views: number; sessions: number }>(
      `SELECT CAST(timestamp / 86400000 AS INTEGER) AS day,
              COUNT(*) AS views,
              COUNT(DISTINCT session_id) AS sessions
       FROM behavior_events WHERE ${where}
       GROUP BY day ORDER BY day`,
      params
    )

    // 访问路径：从会话的 path_json 聚合
    const pathRows = this.db.all<{ path_json: string | null }>(
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
    const bounceRows = this.db.all<{ page_views: number }>(
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
        date: new Date(row.day * 86400000).toISOString().slice(0, 10),
        views: row.views,
        sessions: row.sessions
      }))
    }
  }

  /** 某个会话的行为明细（时间线） */
  listSessionEvents(projectId: number, sessionId: string): BehaviorEvent[] {
    const rows = this.db.all<{
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
