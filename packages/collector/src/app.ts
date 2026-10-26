import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import { openDb, type Db } from './infra/db/client.js'
import { TokenBucketLimiter } from './infra/ratelimit.js'
import { TenancyService, type ProjectRow } from './domains/tenancy/service.js'
import { IssueService } from './domains/issues/service.js'
import { PerformanceService } from './domains/performance/service.js'
import { ArtifactService } from './domains/artifacts/service.js'
import { AlertingService } from './domains/alerting/service.js'
import { AlertEvaluator } from './domains/alerting/evaluator.js'
import { IngestionPipeline } from './domains/ingestion/pipeline.js'
import { AppError } from './shared/errors.js'
import type { CollectEnvelope, PerformanceEnvelope } from '@vigil/protocol'

/**
 * 采集服务（模块化单体）。
 *
 * ## 为什么是模块化单体而不是微服务
 *
 * 三个域（问题 / 性能 / 告警）要**紧耦合**：
 * 告警要读问题的状态，性能要关联错误的上下文。
 * 拆成进程就要处理跨进程查询、事务边界、最终一致性 ——
 * 而这些复杂度换来的收益（独立扩缩容）在这个量级根本用不上。
 *
 * 过度微服务化是反模式：它把「代码内的一个函数调用」换成了
 * 「网络请求 + 重试 + 超时 + 监控」。
 *
 * 所以：**代码按域分层，进程只有一个**。
 * 以后真要拆，域的边界已经是现成的切缝。
 */
export interface BuildAppOptions {
  db: Db
  /** 管理端 token：查询与操作接口用 */
  adminToken: string
  /** 单个项目的限流配额 */
  rateLimit?: { capacity: number; refillPerSecond: number }
  logger?: boolean
}

export interface BuiltApp {
  app: FastifyInstance
  tenancy: TenancyService
  issues: IssueService
  performance: PerformanceService
  artifacts: ArtifactService
  alerting: AlertingService
  evaluator: AlertEvaluator
  ingestion: IngestionPipeline
}

export function buildApp(options: BuildAppOptions): BuiltApp {
  const { db, adminToken } = options

  const app = Fastify({
    logger: options.logger ?? false,
    // 关掉类型强制转换：上报数据里有大量字符串字段，
    // AJV 的 coerceTypes 会把看起来像数字的字符串悄悄改成数字
    // （比如 version "1.0" → 1），改的是用户的数据，不能这样。
    ajv: { customOptions: { coerceTypes: false } }
  })

  const tenancy = new TenancyService(db)
  const artifacts = new ArtifactService(db)
  const issues = new IssueService(db, artifacts.sourcemapResolver)
  const performance = new PerformanceService(db)
  const alerting = new AlertingService(db)
  const evaluator = new AlertEvaluator(db, alerting)
  const ingestion = new IngestionPipeline(db, issues, performance, artifacts)

  const limiter = new TokenBucketLimiter(
    options.rateLimit ?? { capacity: 240, refillPerSecond: 40 }
  )

  // ---- CORS（只对上报相关的跨域路径开放）----
  // SDK 的上报地址通常和业务页面不同源，而带 Content-Type: application/json
  // 和自定义 header 的请求会触发预检。浏览器发 OPTIONS，
  // 不回应就整条链路被拦掉，控制台只有一句 CORS 报错，极易被忽略。
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
  app.options('/api/v1/performance', async (_request, reply) => reply.code(204).send())
  app.options('/api/v1/sourcemaps', async (_request, reply) => reply.code(204).send())

  // ---- 错误处理 ----
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ ok: false, error: error.message, code: error.code })
    }
    app.log.error(error)
    return reply.code(500).send({ ok: false, error: '内部错误' })
  })

  // ==========================================================
  // 健康检查
  // ==========================================================
  app.get('/api/health', async () => ({ ok: true, service: 'vigil-collector' }))

  // ==========================================================
  // 摄入接口（SDK 用，项目密钥鉴权）
  // ==========================================================

  app.post(
    '/api/v1/collect',
    {
      schema: {
        body: {
          type: 'object',
          required: ['appId', 'events'],
          properties: {
            appId: { type: 'string', maxLength: 64 },
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
              // 事件内部结构交给摄入层处理，
              // 这里只保证「是个对象」—— 协议演进时不会因为校验过严把数据挡掉
              items: { type: 'object', additionalProperties: true }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const body = request.body as CollectEnvelope
      const { project } = authenticateProject(request, body.token)
      enforceRateLimit(limiter, project.id)

      const result = ingestion.ingestErrors(project, body)
      return reply.send({
        ok: true,
        accepted: result.accepted,
        dropped: result.dropped,
        ids: result.ids
      })
    }
  )

  app.post(
    '/api/v1/performance',
    {
      schema: {
        body: {
          type: 'object',
          required: ['appId', 'transactions'],
          properties: {
            appId: { type: 'string', maxLength: 64 },
            token: { type: 'string', maxLength: 256 },
            sdk: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 64 },
                version: { type: 'string', maxLength: 32 }
              }
            },
            transactions: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: { type: 'object', additionalProperties: true }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const body = request.body as PerformanceEnvelope
      const { project } = authenticateProject(request, body.token)
      enforceRateLimit(limiter, project.id)

      const result = ingestion.ingestPerformance(project, body)
      return reply.send({ ok: true, accepted: result.accepted, dropped: result.dropped })
    }
  )

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
            appId: { type: 'string', maxLength: 64 },
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

      // 上传用**独立密钥** —— 运行时密钥在前端代码里，
      // 谁拿到它都能上报垃圾数据；上传密钥只在 CI 里
      const token =
        headerValue(request, 'x-vigil-upload-token') ??
        headerValue(request, 'x-vigil-token') ??
        body.token
      const found = tenancy.findProjectByKey(token ?? '')
      if (!found) throw AppError.unauthorized('上传密钥无效')
      // 密钥存在但类型不对 → 403（是有效密钥，只是用错了地方）
      if (found.keyKind !== 'upload') throw AppError.forbidden('需要上传密钥')

      const result = ingestion.uploadSourcemaps(found.project, {
        release: body.release,
        files: body.files
      })
      return reply.send({ ok: true, uploaded: result.uploaded })
    }
  )

  // ==========================================================
  // 管理接口（admin token）
  // ==========================================================

  const admin = { preHandler: adminGuard(adminToken) }

  // ---- 组织与项目 ----

  app.get('/api/v1/organizations', admin, async () => ({
    ok: true,
    organizations: tenancy.listOrganizations()
  }))

  app.post(
    '/api/v1/organizations',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 128 } }
        }
      }
    },
    async (request, reply) => {
      const body = request.body as { name: string }
      const organization = tenancy.createOrganization(body.name)
      return reply.code(201).send({ ok: true, organization })
    }
  )

  app.get('/api/v1/organizations/:organizationId/projects', admin, async (request) => {
    const { organizationId } = request.params as { organizationId: string }
    return {
      ok: true,
      projects: tenancy.listProjects(Number(organizationId))
    }
  })

  app.post(
    '/api/v1/organizations/:organizationId/projects',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            slug: { type: 'string', maxLength: 64 },
            teamId: { type: 'integer' },
            platform: { type: 'string', maxLength: 32 },
            retentionDays: { type: 'integer' },
            eventQuota: { type: 'integer' }
          }
        }
      }
    },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string }
      const body = request.body as {
        name: string
        slug?: string
        teamId?: number
        platform?: string
        retentionDays?: number
        eventQuota?: number
      }

      const created = tenancy.createProject({
        organizationId: Number(organizationId),
        teamId: body.teamId,
        name: body.name,
        slug: body.slug,
        platform: body.platform,
        retentionDays: body.retentionDays,
        eventQuota: body.eventQuota
      })

      // 两把密钥只在这里返回一次
      return reply.code(201).send({
        ok: true,
        project: created.project,
        runtimeKey: created.runtimeKey,
        uploadKey: created.uploadKey
      })
    }
  )

  app.get('/api/v1/projects/:projectId', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    return {
      ok: true,
      project: tenancy.getProject(Number(projectId)),
      environments: tenancy.listEnvironments(Number(projectId)),
      releases: tenancy.listReleases(Number(projectId))
    }
  })

  app.post(
    '/api/v1/projects/:projectId/keys/rotate',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string', enum: ['runtime', 'upload'] } }
        }
      }
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string }
      const body = request.body as { kind: 'runtime' | 'upload' }
      const key = tenancy.rotateKey(Number(projectId), body.kind)
      return { ok: true, kind: body.kind, key }
    }
  )

  // ---- 环境与版本 ----

  app.get('/api/v1/projects/:projectId/environments', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    return { ok: true, environments: tenancy.listEnvironments(Number(projectId)) }
  })

  app.post(
    '/api/v1/projects/:projectId/environments',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['slug', 'name'],
          properties: {
            slug: { type: 'string', minLength: 1, maxLength: 64 },
            name: { type: 'string', minLength: 1, maxLength: 128 },
            isProduction: { type: 'boolean' }
          }
        }
      }
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string }
      const body = request.body as { slug: string; name: string; isProduction?: boolean }
      const environment = tenancy.createEnvironment(
        Number(projectId),
        body.slug,
        body.name,
        body.isProduction ?? false
      )
      return reply.code(201).send({ ok: true, environment })
    }
  )

  app.get('/api/v1/projects/:projectId/releases', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    return { ok: true, releases: tenancy.listReleases(Number(projectId)) }
  })

  app.post(
    '/api/v1/projects/:projectId/releases',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['version'],
          properties: {
            version: { type: 'string', minLength: 1, maxLength: 64 },
            commitSha: { type: 'string', maxLength: 64 }
          }
        }
      }
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string }
      const body = request.body as { version: string; commitSha?: string }
      const release = tenancy.createRelease(Number(projectId), body.version, body.commitSha)
      return reply.code(201).send({ ok: true, release })
    }
  )

  // ---- 问题 ----

  app.get('/api/v1/projects/:projectId/issues', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as Record<string, string | undefined>

    const result = issues.listIssues({
      projectId: Number(projectId),
      status: query.status as never,
      substatus: query.substatus as never,
      category: query.category,
      level: query.level as never,
      environment: query.environment,
      release: query.release,
      query: query.q,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      sort: query.sort as never
    })

    return { ok: true, total: result.total, issues: result.issues }
  })

  app.get('/api/v1/projects/:projectId/issues/:issueId', admin, async (request) => {
    const { projectId, issueId } = request.params as { projectId: string; issueId: string }
    return { ok: true, issue: issues.getIssue(Number(projectId), Number(issueId)) }
  })

  const issueAction = (_action: string) => ({
    ...admin,
    schema: {
      body: {
        type: 'object',
        properties: {
          release: { type: 'string', maxLength: 64 },
          reason: { type: 'string', maxLength: 500 },
          actorId: { type: 'integer' },
          strategy: {
            type: 'string',
            enum: ['forever', 'until_escalating', 'until_count', 'until_user_count']
          },
          untilCount: { type: 'integer' },
          untilUserCount: { type: 'integer' },
          memberId: { type: 'integer' },
          body: { type: 'string', maxLength: 5000 },
          bookmarked: { type: 'boolean' }
        }
      }
    }
  })

  app.post(
    '/api/v1/projects/:projectId/issues/:issueId/resolve',
    issueAction('resolve'),
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string }
      const body = request.body as { release?: string; reason?: string; actorId?: number }
      return {
        ok: true,
        issue: issues.resolve(Number(projectId), Number(issueId), body)
      }
    }
  )

  app.post(
    '/api/v1/projects/:projectId/issues/:issueId/archive',
    issueAction('archive'),
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string }
      const body = request.body as {
        strategy?: 'forever' | 'until_escalating' | 'until_count' | 'until_user_count'
        untilCount?: number
        untilUserCount?: number
        reason?: string
        actorId?: number
      }
      return {
        ok: true,
        issue: issues.archive(Number(projectId), Number(issueId), {
          strategy: body.strategy ?? 'forever',
          untilCount: body.untilCount,
          untilUserCount: body.untilUserCount,
          reason: body.reason,
          actorId: body.actorId
        })
      }
    }
  )

  app.post(
    '/api/v1/projects/:projectId/issues/:issueId/unarchive',
    issueAction('unarchive'),
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string }
      const body = request.body as { reason?: string; actorId?: number }
      return {
        ok: true,
        issue: issues.unarchive(Number(projectId), Number(issueId), body)
      }
    }
  )

  app.post(
    '/api/v1/projects/:projectId/issues/:issueId/seen',
    issueAction('seen'),
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string }
      const body = request.body as { reason?: string; actorId?: number }
      return {
        ok: true,
        issue: issues.markSeen(Number(projectId), Number(issueId), body)
      }
    }
  )

  app.post(
    '/api/v1/projects/:projectId/issues/:issueId/assign',
    issueAction('assign'),
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string }
      const body = request.body as { memberId?: number; reason?: string; actorId?: number }
      return {
        ok: true,
        issue: issues.assign(Number(projectId), Number(issueId), body.memberId ?? null, body)
      }
    }
  )

  app.post(
    '/api/v1/projects/:projectId/issues/:issueId/comments',
    issueAction('comment'),
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string }
      const body = request.body as { body: string; actorId?: number }
      if (!body.body) throw AppError.badRequest('缺少评论内容')
      return {
        ok: true,
        issue: issues.comment(Number(projectId), Number(issueId), body.actorId, body.body)
      }
    }
  )

  app.post(
    '/api/v1/projects/:projectId/issues/:issueId/bookmark',
    issueAction('bookmark'),
    async (request) => {
      const { projectId, issueId } = request.params as { projectId: string; issueId: string }
      const body = request.body as { bookmarked?: boolean }
      return {
        ok: true,
        issue: issues.setBookmarked(Number(projectId), Number(issueId), body.bookmarked !== false)
      }
    }
  )

  app.post(
    '/api/v1/projects/:projectId/issues/bulk',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['issueIds', 'action'],
          properties: {
            issueIds: { type: 'array', items: { type: 'integer' } },
            action: {
              type: 'string',
              enum: ['resolve', 'archive', 'unarchive', 'bookmark', 'unbookmark', 'mark_seen']
            },
            archiveStrategy: { type: 'string' },
            archiveUntilCount: { type: 'integer' },
            archiveUntilUserCount: { type: 'integer' },
            release: { type: 'string' },
            reason: { type: 'string' },
            actorId: { type: 'integer' }
          }
        }
      }
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string }
      const body = request.body as {
        issueIds: number[]
        action: 'resolve' | 'archive' | 'unarchive' | 'bookmark' | 'unbookmark' | 'mark_seen'
        archiveStrategy?: 'forever' | 'until_escalating' | 'until_count' | 'until_user_count'
        archiveUntilCount?: number
        archiveUntilUserCount?: number
        release?: string
        reason?: string
        actorId?: number
      }

      const affected = issues.bulkAction(Number(projectId), {
        issueIds: body.issueIds,
        action: body.action,
        archiveStrategy: body.archiveStrategy,
        archiveUntilCount: body.archiveUntilCount,
        archiveUntilUserCount: body.archiveUntilUserCount,
        release: body.release,
        reason: body.reason,
        actorId: body.actorId
      })

      return { ok: true, affected }
    }
  )

  app.get('/api/v1/projects/:projectId/stats', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    return { ok: true, stats: issues.stats(Number(projectId)) }
  })

  // ---- 性能 ----

  app.get('/api/v1/projects/:projectId/performance', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as Record<string, string | undefined>
    return {
      ok: true,
      summary: performance.summary({
        projectId: Number(projectId),
        environment: query.environment,
        release: query.release,
        since: query.since ? Number(query.since) : undefined,
        until: query.until ? Number(query.until) : undefined
      })
    }
  })

  app.get('/api/v1/projects/:projectId/transactions', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as Record<string, string | undefined>
    return {
      ok: true,
      ...performance.listTransactions({
        projectId: Number(projectId),
        environment: query.environment,
        release: query.release,
        name: query.name,
        since: query.since ? Number(query.since) : undefined,
        until: query.until ? Number(query.until) : undefined,
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined
      })
    }
  })

  app.get('/api/v1/projects/:projectId/error-performance', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    const query = request.query as Record<string, string | undefined>
    return {
      ok: true,
      rows: performance.errorPerformanceCorrelation(
        Number(projectId),
        query.since ? Number(query.since) : undefined
      )
    }
  })

  // ---- 告警 ----

  app.get('/api/v1/projects/:projectId/alert-rules', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    return { ok: true, rules: alerting.listRules(Number(projectId)) }
  })

  app.post(
    '/api/v1/projects/:projectId/alert-rules',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            type: {
              type: 'string',
              enum: [
                'issue.new',
                'issue.count',
                'issue.spike',
                'metric.error_count',
                'metric.error_rate',
                'metric.lcp_p95'
              ]
            },
            conditions: { type: 'object', additionalProperties: true },
            threshold: { type: 'number' },
            windowSeconds: { type: 'integer' },
            channelIds: { type: 'array', items: { type: 'integer' } }
          }
        }
      }
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string }
      const body = request.body as {
        name: string
        type: 'issue.new'
        conditions?: never
        threshold?: number
        windowSeconds?: number
        channelIds?: number[]
      }
      const rule = alerting.createRule({ projectId: Number(projectId), ...body })
      return reply.code(201).send({ ok: true, rule })
    }
  )

  app.patch('/api/v1/alert-rules/:ruleId', admin, async (request) => {
    const { ruleId } = request.params as { ruleId: string }
    const body = request.body as Record<string, never>
    return { ok: true, rule: alerting.updateRule(Number(ruleId), body) }
  })

  app.delete('/api/v1/alert-rules/:ruleId', admin, async (request) => {
    const { ruleId } = request.params as { ruleId: string }
    alerting.deleteRule(Number(ruleId))
    return { ok: true }
  })

  app.get('/api/v1/projects/:projectId/channels', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    return { ok: true, channels: alerting.listChannels(Number(projectId)) }
  })

  app.post(
    '/api/v1/projects/:projectId/channels',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            type: { type: 'string', enum: ['webhook', 'feishu', 'dingtalk', 'email', 'slack'] },
            config: { type: 'object', additionalProperties: true }
          }
        }
      }
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string }
      const body = request.body as {
        name: string
        type: 'webhook' | 'feishu' | 'dingtalk' | 'email' | 'slack'
        config: Record<string, unknown>
      }
      const channel = alerting.createChannel({ projectId: Number(projectId), ...body })
      return reply.code(201).send({ ok: true, channel })
    }
  )

  app.get('/api/v1/projects/:projectId/alert-incidents', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    return { ok: true, incidents: alerting.listIncidents(Number(projectId)) }
  })

  app.post('/api/v1/projects/:projectId/alerts/evaluate', admin, async (request) => {
    const { projectId } = request.params as { projectId: string }
    const result = await evaluator.evaluateProject(Number(projectId))
    return { ok: true, result }
  })

  // ==========================================================
  // 内部
  // ==========================================================

  /** 项目密钥鉴权 */
  function authenticateProject(
    request: FastifyRequest,
    bodyToken: string | undefined
  ): { project: ProjectRow } {
    const token = headerValue(request, 'x-vigil-token') ?? bodyToken
    if (!token) throw AppError.unauthorized('缺少项目密钥')

    const found = tenancy.findProjectByKey(token)
    if (!found) throw AppError.unauthorized('项目密钥无效')
    if (found.keyKind !== 'runtime') throw AppError.forbidden('该密钥不能用于上报')

    return { project: found.project }
  }

  function enforceRateLimit(limiter: TokenBucketLimiter, projectId: number): void {
    if (!limiter.take(String(projectId))) {
      throw AppError.tooManyRequests('超出上报频率限制')
    }
  }

  return { app, tenancy, issues, performance, artifacts, alerting, evaluator, ingestion }
}

/** 管理端鉴权 */
function adminGuard(adminToken: string) {
  const expected = crypto.createHash('sha256').update(adminToken, 'utf8').digest('hex')

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers['x-vigil-admin-token']
    const authorization = request.headers.authorization

    let provided: string | undefined
    if (typeof header === 'string') {
      provided = header
    } else if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      provided = authorization.slice('Bearer '.length)
    }

    if (!provided) throw AppError.unauthorized('缺少管理 token')

    const actual = crypto.createHash('sha256').update(provided, 'utf8').digest('hex')
    // 常量时间比较：逐字节比较的时间差可以泄漏 token 前缀
    if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      throw AppError.forbidden('管理 token 不匹配')
    }
  }
}

/** 读 header，兼容 Fastify 的 string | string[] | undefined */
function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function isIngestPath(url: string): boolean {
  return (
    url.startsWith('/api/v1/collect') ||
    url.startsWith('/api/v1/performance') ||
    url.startsWith('/api/v1/sourcemaps')
  )
}

/** 从环境变量组装服务 */
export function createAppFromEnv(): BuiltApp & { db: Db } {
  const db = openDb(process.env.VIGIL_DB_PATH ?? './data/vigil.db')
  const adminToken = process.env.VIGIL_ADMIN_TOKEN ?? crypto.randomBytes(24).toString('hex')
  return { ...buildApp({ db, adminToken }), db }
}
