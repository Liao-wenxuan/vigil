import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { ErrorEvent } from '@vigil/protocol'
import { SourcemapResolver, type ResolvedFrame } from './sourcemap.js'
import { parseUserAgent } from './user-agent.js'

/**
 * 上报落库：聚合 + 明细。
 *
 * ## 聚合靠数据库约束，不靠应用层「先查再插」
 *
 * 错误做法：
 * ```ts
 * const existing = db.prepare('SELECT id FROM errors WHERE app_id=? AND fingerprint=?').get(...)
 * if (existing) db.prepare('UPDATE ...').run(...)
 * else db.prepare('INSERT ...').run(...)
 * ```
 * 这段代码在**单线程**下看着没问题，但两个请求同时进来时，
 * 两边都查不到 → 都走 INSERT → 要么重复行，要么撞唯一约束报错。
 * 正确做法是把判断交给数据库：UNIQUE 约束 + UPSERT，一行 SQL 搞定，
 * 并发下由 SQLite 的写锁串行化，不会重复。
 *
 * ## errors 表和 error_events 表的分工
 *
 * errors      —— 聚合结果：一条错误一行，带计数和最新现场
 * error_events —— 原始明细：每次发生都留一份，带完整 payload
 *
 * 只存聚合结果的话，排查时会丢掉「具体是哪个用户、哪个参数触发的」。
 * 只存明细的话，列表页要 GROUP BY 全表，很慢。
 * 两张表各司其职。
 */
export interface IngestResult {
  accepted: number
  /** 事件序号 → 服务端错误 id */
  ids: Record<string, number>
}

/** 每个错误保留多少条明细 */
const DEFAULT_MAX_EVENTS_PER_ERROR = 20

/** 合法指纹：16 位十六进制 */
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/

/**
 * 校验客户端给的指纹。
 *
 * 指纹是**聚合主键**。如果照单全收，一个空串就能让该应用的所有错误
 * 塌成一行 —— 表面上「有数据」，实际全是同一条错误，监控直接失去意义。
 *
 * 所以服务端必须兜一层：指纹缺失或格式不对时，自己算一个。
 */
function isValidFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}

/**
 * 服务端兜底指纹。
 *
 * 不复用客户端那套算法（跨包依赖不值得），但保证「不同的错误不会塌成一条」。
 * 带上首帧的函数名 —— 只用消息的话，用户 ID 之类的动态值会让分组不稳定。
 */
function fallbackFingerprint(event: ErrorEvent): string {
  const first = event.frames?.[0]
  const key = [event.category, event.kind, first?.functionName ?? '', event.message].join('|')

  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export class Ingestor {
  constructor(
    private readonly db: Database,
    private readonly resolver: SourcemapResolver
  ) {}

  ingest(appId: string, events: ErrorEvent[]): IngestResult {
    if (events.length === 0) return { accepted: 0, ids: {} }

    const result = this.db.transaction((batch: ErrorEvent[]) => {
      const ids: Record<string, number> = {}
      let accepted = 0

      for (const [index, event] of batch.entries()) {
        const errorId = this.persistEvent(appId, event)
        ids[String(index)] = errorId
        accepted++
      }

      return { accepted, ids }
    })(events)

    return result
  }

  /** 写一条事件：UPSERT 聚合行 + INSERT 明细行 + 裁剪旧明细 */
  private persistEvent(appId: string, event: ErrorEvent): number {
    const occurredAt = event.occurredAt ?? Date.now()
    const receivedAt = Date.now()
    const release = event.release

    // 指纹缺失或格式不对时服务端兜底，避免所有错误塌成一行
    const fingerprint = isValidFingerprint(event.fingerprint)
      ? event.fingerprint
      : fallbackFingerprint(event)

    const ua = parseUserAgent(event.userAgent ?? '')
    const resolvedFrames: ResolvedFrame[] = this.resolver.resolve(
      appId,
      release,
      event.frames ?? []
    )

    const upsert = this.db.prepare(
      `INSERT INTO errors (
         app_id, fingerprint, category, kind, name, message,
         url, url_path, referrer, user_agent, browser, os, device,
         environment, release, session_id, user_id,
         first_seen, last_seen, count,
         raw_stack, resolved_stack, http_json, resource_json
       ) VALUES (
         @appId, @fingerprint, @category, @kind, @name, @message,
         @url, @urlPath, @referrer, @userAgent, @browser, @os, @device,
         @environment, @release, @sessionId, @userId,
         @firstSeen, @lastSeen, 1,
         @rawStack, @resolvedStack, @httpJson, @resourceJson
       )
       ON CONFLICT(app_id, fingerprint) DO UPDATE SET
         last_seen      = excluded.last_seen,
         count          = errors.count + 1,
         raw_stack      = excluded.raw_stack,
         resolved_stack = excluded.resolved_stack,
         http_json      = excluded.http_json,
         resource_json  = excluded.resource_json
       RETURNING id`
    )

    const row = upsert.get({
      appId,
      fingerprint,
      category: event.category,
      kind: event.kind,
      name: event.name ?? null,
      message: event.message ?? '',
      url: event.url ?? null,
      urlPath: pathOnly(event.url),
      referrer: event.referrer ?? null,
      userAgent: event.userAgent ?? null,
      browser: ua.browser ?? null,
      os: ua.os ?? null,
      device: ua.device,
      environment: event.environment ?? null,
      release: release ?? null,
      sessionId: event.sessionId ?? null,
      userId: event.userId ?? null,
      firstSeen: occurredAt,
      lastSeen: occurredAt,
      rawStack: event.stack ?? null,
      resolvedStack: resolvedFrames.length > 0 ? JSON.stringify(resolvedFrames) : null,
      httpJson: event.http ? JSON.stringify(event.http) : null,
      resourceJson: event.resource ? JSON.stringify(event.resource) : null
    }) as { id: number }

    const errorId = row.id

    // 明细行：保留现场
    this.db
      .prepare(
        `INSERT INTO error_events
           (app_id, fingerprint, error_id, occurred_at, received_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(appId, fingerprint, errorId, occurredAt, receivedAt, JSON.stringify(event))

    this.pruneEvents(appId, fingerprint)

    return errorId
  }

  /**
   * 裁剪某个错误的历史明细。
   *
   * 不裁剪的话数据库会无限膨胀，而且「最近 20 条」才是排查时真正会看的。
   */
  private pruneEvents(appId: string, fingerprint: string): void {
    this.db
      .prepare(
        `DELETE FROM error_events
         WHERE app_id = ? AND fingerprint = ?
           AND id NOT IN (
             SELECT id FROM error_events
             WHERE app_id = ? AND fingerprint = ?
             ORDER BY occurred_at DESC, id DESC
             LIMIT ?
           )`
      )
      .run(appId, fingerprint, appId, fingerprint, DEFAULT_MAX_EVENTS_PER_ERROR)
  }
}

/** 取 URL 的路径部分 */
function pathOnly(url: string | undefined): string | null {
  if (!url) return null
  let s = url.split('?')[0].split('#')[0]
  const schemeEnd = s.indexOf('://')
  if (schemeEnd !== -1) {
    const slash = s.indexOf('/', schemeEnd + 3)
    s = slash === -1 ? '/' : s.slice(slash)
  }
  return s || '/'
}
