import { createHash } from 'node:crypto'
import { openDb } from '../src/infra/db/client.js'
import type { Db } from '../src/infra/db/types.js'
import { TenancyService } from '../src/domains/tenancy/service.js'
import { IssueService } from '../src/domains/issues/service.js'
import { ArtifactService } from '../src/domains/artifacts/service.js'
import { PerformanceService } from '../src/domains/performance/service.js'
import { AlertingService } from '../src/domains/alerting/service.js'
import { AlertEvaluator } from '../src/domains/alerting/evaluator.js'
import { ReplayService } from '../src/domains/replay/service.js'
import type { ErrorEvent, PerformanceEvent } from '@vigil/protocol'

/**
 * 测试夹具。
 *
 * 每个测试拿到一个**全新的内存库** —— 状态机测试要能精确断言
 * 「流转前是什么、流转后是什么」，数据库里有别的数据就会干扰。
 */
export async function setupDb(options: { transformDb?: (db: Db) => Db } = {}) {
  const raw = await openDb(':memory:')
  const db = options.transformDb ? options.transformDb(raw) : raw
  const tenancy = new TenancyService(db)
  const artifacts = new ArtifactService(db)
  const issues = new IssueService(db, artifacts.sourcemapResolver)
  const performance = new PerformanceService(db)
  const alerting = new AlertingService(db)
  const evaluator = new AlertEvaluator(db, alerting)
  const replay = new ReplayService(db)

  const organization = await tenancy.createOrganization('测试组织')
  const created = await tenancy.createProject({ organizationId: organization.id, name: '测试应用' })

  return {
    db,
    tenancy,
    artifacts,
    issues,
    performance,
    alerting,
    evaluator,
    replay,
    organization,
    project: created.project,
    runtimeKey: created.runtimeKey,
    uploadKey: created.uploadKey
  }
}

/** 读查询计数 —— 用来断言「查询次数不随数据量/规则数增长」 */
export interface ReadCounter {
  reads: number
}

/**
 * 包一层 Db，统计**读**查询（get / all）。
 *
 * 写查询不算 —— 告警落库本来就一条规则一次。
 */
export function countingDb(inner: Db, counter: ReadCounter): Db {
  return {
    dialect: inner.dialect,
    async exec(sql) {
      return inner.exec(sql)
    },
    async all(sql, params) {
      counter.reads++
      return inner.all(sql, params)
    },
    async get(sql, params) {
      counter.reads++
      return inner.get(sql, params)
    },
    async run(sql, params) {
      return inner.run(sql, params)
    },
    async insert(sql, params) {
      return inner.insert(sql, params)
    },
    async transaction(fn) {
      return inner.transaction(fn)
    },
    async close() {
      return inner.close()
    }
  }
}

/**
 * 合法格式的指纹（16 位十六进制）。
 *
 * Collector 会校验指纹格式，格式不对会走服务端兜底 ——
 * 测试要模拟 SDK 真实产出的格式。
 */
export function fp(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 16)
}

/** 造一条错误事件 */
export function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    category: 'javascript',
    kind: 'js',
    name: 'TypeError',
    message: 'Cannot read properties of undefined',
    stack: 'TypeError: boom\n    at foo (https://a.com/index.js:10:5)',
    frames: [{ filename: 'https://a.com/index.js', functionName: 'foo', lineno: 10, colno: 5 }],
    fingerprint: fp('default'),
    url: 'https://a.com/page',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    sessionId: 'session-1',
    release: '1.4.2',
    environment: 'production',
    occurredAt: Date.now(),
    ...overrides
  }
}

/** 造一个性能事务 */
export function makeTransaction(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
  return {
    name: '/checkout',
    type: 'page',
    startedAt: Date.now(),
    durationMs: 1200,
    vitals: { fcp: 800, lcp: 1500, cls: 0.02, inp: 120, ttfb: 200, tbt: 50, longTaskCount: 1 },
    pageUrl: 'https://a.com/checkout',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    sessionId: 'session-1',
    release: '1.4.2',
    environment: 'production',
    ...overrides
  }
}
