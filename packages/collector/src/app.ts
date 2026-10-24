import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { Database } from 'better-sqlite3'
import type { CollectEnvelope, ErrorEvent } from '@vigil/protocol'
import { authenticateAdmin, authenticateRuntime, authenticateUpload } from './auth.js'
import { createApp, listApps, setAppEnabled, touchApp } from './apps.js'
import { Ingestor } from './ingest.js'
import { TokenBucketLimiter } from './rate-limit.js'
import { saveSourcemap, SourcemapResolver } from './sourcemap.js'

export interface BuildAppOptions {
  db: Database
  /** 管理端 token：查询错误列表用 */
  adminToken: string
  /** 单个应用的限流配额 */
  rateLimit?: { capacity: number; refillPerSecond: number }
  logger?: boolean
}

/**
 * 采集服务。
 *
 * ## CORS 不是可选项
 *
 * SDK 的上报地址通常和业务页面**不同源**（页面在 app.example.com，
 * 采集在 collector.example.com）。而 SDK 的 fetch 请求带了
 * `Content-Type: application/json` 和自定义 header —— 这会触发**预检**。
 * 浏览器发出 OPTIONS，Collector 不回应 → 预检失败 → **整个上报被浏览器拦掉**，
 * 而且控制台只有一句 CORS 报错，很容易被忽略。
 *
 * sendBeacon 那条路是 no-cors，不发预检，但响应是 opaque 的。
 *
 * 所以两条路都要支持 CORS，OPTIONS 必须显式处理。
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { db, adminToken } = options

  const app = Fastify({
    logger: options.logger ?? false,
    // 关掉类型强制转换：上报数据里有大量字符串字段，
    // AJV 的 coerceTypes 会把看起来像数字的字符串悄悄改成数字
    // （比如 version "1.0" → 1），改的是用户的数据，不能这样。
    ajv: { customOptions: { coerceTypes: false } }
  })

  const resolver = new SourcemapResolver(db)
  const ingestor = new Ingestor(db, resolver)

  const limiter = new TokenBucketLimiter(
    options.rateLimit ?? { capacity: 120, refillPerSecond: 20 }
  )

  // ---- CORS（只对上报相关的跨域路径开放）----
  app.addHook('onRequest', async (request, reply) => {
    if (!isIngestPath(request.url)) return
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS')
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Vigil-App-Id, X-Vigil-Token, X-Vigil-Upload-Token'
    )
    reply.header('Access-Control-Max-Age', '86400')
  })

  app.options('/api/v1/collect', async (_request, reply) => reply.code(204).send())
  app.options('/api/v1/sourcemaps', async (_request, reply) => reply.code(204).send())

  // ---- 健康检查 ----
  app.get('/api/health', async () => ({ ok: true, service: 'vigil-collector' }))

  // ---- 上报入口 ----
  app.post(
    '/api/v1/collect',
    {
      schema: {
        body: {
          type: 'object',
          required: ['appId', 'events'],
          properties: {
            appId: { type: 'string', minLength: 1, maxLength: 64 },
            token: { type: 'string', maxLength: 256 },
            sdk: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 64 },
                version: { type: 'string', maxLength: 32 }
              }
            },
            events: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              // 事件内部结构完全交给 ingest 层处理，
              // 这里只保证「是个对象」—— 协议演进时不会因为校验过严把数据挡掉
              items: { type: 'object', additionalProperties: true }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const body = request.body as CollectEnvelope

      // header 优先：fetch 通道把 token 放 header，不进 body，
      // 也就不会出现在服务端的请求体日志里
      const appId = headerValue(request, 'x-vigil-app-id') ?? body.appId
      const token = headerValue(request, 'x-vigil-token') ?? body.token

      const auth = authenticateRuntime(db, appId, token)
      if (!auth.ok) {
        return reply.code(auth.status).send({ ok: false, error: auth.reason })
      }

      if (!limiter.take(appId)) {
        // 超限不是错误，是背压 —— 用 429 让 SDK 知道要退避
        return reply.code(429).send({ ok: false, error: '超出上报频率限制' })
      }

      const events = (body.events ?? []) as ErrorEvent[]
      const result = ingestor.ingest(appId, events)
      touchApp(db, appId)

      return reply.send({
        ok: true,
        accepted: result.accepted,
        ids: result.ids
      })
    }
  )

  // ---- sourcemap 上传 ----
  app.post(
    '/api/v1/sourcemaps',
    {
      // sourcemap 可能有几 MB，放宽 body 限制
      bodyLimit: 64 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['appId', 'release', 'files'],
          properties: {
            appId: { type: 'string', minLength: 1, maxLength: 64 },
            token: { type: 'string', maxLength: 256 },
            release: { type: 'string', minLength: 1, maxLength: 128 },
            files: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                type: 'object',
                required: ['fileName', 'sourceMap'],
                properties: {
                  fileName: { type: 'string', minLength: 1, maxLength: 512 },
                  sourceMap: { type: 'string', minLength: 1 }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const body = request.body as {
        appId: string
        token?: string
        release: string
        files: Array<{ fileName: string; sourceMap: string }>
      }

      const appId = headerValue(request, 'x-vigil-app-id') ?? body.appId
      const token = headerValue(request, 'x-vigil-upload-token') ?? body.token

      // 上传用**独立 token** —— 运行时 token 在前端代码里，
      // 谁拿到它都能上报垃圾数据；上传 token 只在 CI 里
      const auth = authenticateUpload(db, appId, token)
      if (!auth.ok) {
        return reply.code(auth.status).send({ ok: false, error: auth.reason })
      }

      const save = db.transaction(() => {
        for (const file of body.files) {
          saveSourcemap(db, appId, body.release, file.fileName, file.sourceMap)
        }
      })
      save()

      // 上传后必须清缓存，否则旧 map 继续生效
      resolver.invalidate(appId, body.release)

      return reply.send({ ok: true, uploaded: body.files.length })
    }
  )

  // ---- 管理接口 ----
  app.get('/api/v1/apps', async (request, reply) => {
    if (!requireAdmin(request, reply, adminToken)) return reply
    return reply.send({ ok: true, apps: listApps(db) })
  })

  app.post(
    '/api/v1/apps',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 128 } }
        }
      }
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply, adminToken)) return reply
      const body = request.body as { name: string }
      const created = createApp(db, body.name)
      // token 只在这里返回一次，之后数据库里只有哈希
      return reply.code(201).send({ ok: true, ...created })
    }
  )

  app.patch('/api/v1/apps/:appId', async (request, reply) => {
    if (!requireAdmin(request, reply, adminToken)) return reply
    const { appId } = request.params as { appId: string }
    const body = request.body as { enabled?: boolean }
    const changed = setAppEnabled(db, appId, body.enabled !== false)
    if (!changed) return reply.code(404).send({ ok: false, error: '应用不存在' })
    return reply.send({ ok: true, appId, enabled: body.enabled !== false })
  })

  app.get('/api/v1/apps/:appId/errors', async (request, reply) => {
    if (!requireAdmin(request, reply, adminToken)) return reply
    const { appId } = request.params as { appId: string }
    const query = request.query as {
      limit?: string
      offset?: string
      q?: string
      category?: string
    }

    const limit = clampInt(query.limit, 50, 1, 500)
    const offset = clampInt(query.offset, 0, 0, 1_000_000)

    const conditions = ['app_id = ?']
    const params: unknown[] = [appId]

    if (query.q) {
      conditions.push('(message LIKE ? OR url_path LIKE ?)')
      params.push(`%${query.q}%`, `%${query.q}%`)
    }
    if (query.category) {
      conditions.push('category = ?')
      params.push(query.category)
    }

    const where = conditions.join(' AND ')
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM errors WHERE ${where}`).get(...params) as { n: number }
    ).n

    const rows = db
      .prepare(
        `SELECT id, fingerprint, category, kind, name, message, url, url_path,
                browser, os, device, environment, release, first_seen, last_seen, count
         FROM errors
         WHERE ${where}
         ORDER BY last_seen DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)

    return reply.send({ ok: true, total, limit, offset, errors: rows })
  })

  app.get('/api/v1/apps/:appId/errors/:fingerprint', async (request, reply) => {
    if (!requireAdmin(request, reply, adminToken)) return reply
    const { appId, fingerprint } = request.params as { appId: string; fingerprint: string }

    const error = db
      .prepare('SELECT * FROM errors WHERE app_id = ? AND fingerprint = ?')
      .get(appId, fingerprint)
    if (!error) return reply.code(404).send({ ok: false, error: '错误不存在' })

    const events = db
      .prepare(
        `SELECT id, occurred_at, received_at, payload_json
         FROM error_events
         WHERE app_id = ? AND fingerprint = ?
         ORDER BY occurred_at DESC, id DESC
         LIMIT 20`
      )
      .all(appId, fingerprint)

    return reply.send({ ok: true, error, events })
  })

  app.get('/api/v1/apps/:appId/stats', async (request, reply) => {
    if (!requireAdmin(request, reply, adminToken)) return reply
    const { appId } = request.params as { appId: string }

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS distinct_errors, COALESCE(SUM(count), 0) AS occurrences
         FROM errors WHERE app_id = ?`
      )
      .get(appId) as { distinct_errors: number; occurrences: number }

    const byCategory = db
      .prepare(
        `SELECT category, COUNT(*) AS n, COALESCE(SUM(count), 0) AS occurrences
         FROM errors WHERE app_id = ? GROUP BY category ORDER BY occurrences DESC`
      )
      .all(appId)

    const topErrors = db
      .prepare(
        `SELECT fingerprint, message, name, count, last_seen
         FROM errors WHERE app_id = ?
         ORDER BY count DESC LIMIT 10`
      )
      .all(appId)

    const topEndpoints = db
      .prepare(
        `SELECT url_path, COUNT(*) AS n, COALESCE(SUM(count), 0) AS occurrences
         FROM errors WHERE app_id = ? AND category = 'http' AND url_path IS NOT NULL
         GROUP BY url_path ORDER BY occurrences DESC LIMIT 10`
      )
      .all(appId)

    const browsers = db
      .prepare(
        `SELECT browser, COUNT(*) AS n FROM errors WHERE app_id = ? AND browser IS NOT NULL
         GROUP BY browser ORDER BY n DESC`
      )
      .all(appId)

    return reply.send({
      ok: true,
      appId,
      totals,
      byCategory,
      topErrors,
      topEndpoints,
      browsers
    })
  })

  app.addHook('onClose', async () => {
    resolver.clear()
  })

  return app
}

/** 管理端鉴权：失败时直接回复并返回 false */
function requireAdmin(request: FastifyRequest, reply: FastifyReply, adminToken: string): boolean {
  const auth = authenticateAdmin(request, adminToken)
  if (auth.ok) return true
  void reply.code(auth.status).send({ ok: false, error: auth.reason })
  return false
}

/** 读 header，兼容 Fastify 的 string | string[] | undefined */
function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function isIngestPath(url: string): boolean {
  return url.startsWith('/api/v1/collect') || url.startsWith('/api/v1/sourcemaps')
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
