/**
 * 摄入路径的 DB 往返与提交预算。
 *
 * ## 为什么要有这个闸门
 *
 * 一条错误事件从进来到落库要跑好几条 SQL。**每条 SQL 在 PostgreSQL 部署下
 * 都是一次网络往返** —— 3 次往返就是 3 倍延迟。
 *
 * 而「多了一条查询」是**静默**的：没有任何测试会挂，也没有报错，
 * 只有线上摄入变慢了才看得出来。所以得把它变成一个**有上限的数字**。
 *
 * 提交次数同理：一批 20 条事件**只该提交一次**。
 * 逐条提交就是 20 次 —— SQLite 上是 20 次 WAL 追加，PG 上是 20 次网络往返。
 *
 * ## 怎么量
 *
 * 包一层 `Db` 记 SQL，跑**真实的管道**（不是直接调领域方法），
 * 统计每条事件的往返次数和每批的提交次数。
 *
 * ⚠️ BEGIN / COMMIT 走的是 better-sqlite3 的**底层句柄**，
 *    不经过 `Db.exec` —— 所以提交次数要从句柄上数。
 */
import { createHash } from 'node:crypto'
import { openDb, rawHandle } from '../packages/collector/src/infra/db/client.js'
import type { Db } from '../packages/collector/src/infra/db/types.js'
import { TenancyService } from '../packages/collector/src/domains/tenancy/service.js'
import { ArtifactService } from '../packages/collector/src/domains/artifacts/service.js'
import { IssueService } from '../packages/collector/src/domains/issues/service.js'
import { PerformanceService } from '../packages/collector/src/domains/performance/service.js'
import { ReplayService } from '../packages/collector/src/domains/replay/service.js'
import { UsageService } from '../packages/collector/src/domains/usage/service.js'
import { IngestionPipeline } from '../packages/collector/src/domains/ingestion/pipeline.js'
import type { ErrorEvent } from '@vigil/protocol'

/** 稳态下每条错误事件允许的 DB 往返次数 */
const BUDGET = Number(process.env.VIGIL_INGEST_BUDGET ?? 3)
/** 一批允许的提交次数（整批一个事务 → 1 次） */
const COMMIT_BUDGET = Number(process.env.VIGIL_INGEST_COMMIT_BUDGET ?? 1)
/** 用来测量的事件条数（SDK 一批最多 20 条） */
const SAMPLE = 20

const raw = await openDb(':memory:')
const counts = { all: 0, get: 0, run: 0, insert: 0 }
const sqlLog: string[] = []

const spy: Db = {
  dialect: raw.dialect,
  exec: (sql) => raw.exec(sql),
  all: async (sql, params) => {
    counts.all++
    sqlLog.push(sql.replace(/\s+/g, ' ').slice(0, 90))
    return raw.all(sql, params)
  },
  get: async (sql, params) => {
    counts.get++
    sqlLog.push(sql.replace(/\s+/g, ' ').slice(0, 90))
    return raw.get(sql, params)
  },
  run: async (sql, params) => {
    counts.run++
    sqlLog.push(sql.replace(/\s+/g, ' ').slice(0, 90))
    return raw.run(sql, params)
  },
  insert: async (sql, params) => {
    counts.insert++
    sqlLog.push(sql.replace(/\s+/g, ' ').slice(0, 90))
    return raw.insert(sql, params)
  },
  transaction: (fn) => raw.transaction(fn),
  savepoint: (name, fn) => raw.savepoint(name, fn),
  close: () => raw.close()
}

// 提交次数要从底层句柄数 —— BEGIN / COMMIT 不经过 `Db.exec`
// ⚠️ rawHandle 只认 SqliteDb 实例，所以要传**原始的** db，不是包装过的 spy
const handle = rawHandle(raw)
const statements: string[] = []
if (handle) {
  const originalExec = handle.exec.bind(handle)
  handle.exec = (sql: string) => {
    statements.push(sql)
    return originalExec(sql)
  }
}

const tenancy = new TenancyService(spy)
const artifacts = new ArtifactService(spy)
const issues = new IssueService(spy, artifacts.sourcemapResolver)
const pipeline = new IngestionPipeline(
  spy,
  issues,
  new PerformanceService(spy),
  artifacts,
  new ReplayService(spy),
  new UsageService(spy)
)

const org = await tenancy.createOrganization('预算组织')
const { project } = await tenancy.createProject({
  organizationId: org.id,
  name: '预算应用'
})

const fp = (label: string) => createHash('sha256').update(label).digest('hex').slice(0, 16)

function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    category: 'javascript',
    kind: 'js',
    name: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at foo (https://a.com/index.js:10:5)',
    fingerprint: fp('budget'),
    url: 'https://a.com/page',
    sessionId: 'session-1',
    release: '1.4.2',
    environment: 'production',
    occurredAt: Date.now(),
    ...overrides
  } as ErrorEvent
}

// 先建好 Issue —— 之后量的才是稳态
await pipeline.ingestErrors(
  project as never,
  {
    appId: 'bench',
    sdk: { name: 'vigil', version: '0.1.0' },
    events: [makeEvent()]
  } as never
)

sqlLog.length = 0
for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
statements.length = 0

/** 跑一批，返回这次批的 SQL 次数 */
async function ingestBatch(size: number): Promise<number> {
  sqlLog.length = 0
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
  const events = Array.from({ length: size }, (_, i) =>
    makeEvent({ occurredAt: 1_700_000_000_000 + Math.random() * 1_000_000 + i })
  )
  await pipeline.ingestErrors(
    project as never,
    {
      appId: 'bench',
      sdk: { name: 'vigil', version: '0.1.0' },
      events
    } as never
  )
  return counts.all + counts.get + counts.run + counts.insert
}

// ⚠️ 每批有**固定开销**（配额检查 + 用量记账），那是「每批一次」不是「每条一次」。
//    所以要跑两个规模，取差值 —— 只把随条数增长的部分算进每条预算。
const callsOne = await ingestBatch(1)
statements.length = 0
const t0 = performance.now()
const callsBatch = await ingestBatch(SAMPLE)
const dt = performance.now() - t0

const commits = statements.filter((s) => s === 'COMMIT').length
const perEvent = (callsBatch - callsOne) / (SAMPLE - 1)

console.log(`稳态摄入一批 ${SAMPLE} 条事件`)
console.log(`  DB 往返：${callsBatch} 次 → 每条 ${perEvent.toFixed(1)} 次（预算 ${BUDGET} 次）`)
console.log(`  提交：${commits} 次（预算 ${COMMIT_BUDGET} 次）`)
console.log(`  耗时：${dt.toFixed(1)} ms（${(dt / SAMPLE).toFixed(3)} ms/条）`)

console.log('\n每条事件执行的 SQL（按次数）：')
const freq = new Map<string, number>()
for (const sql of sqlLog) freq.set(sql, (freq.get(sql) ?? 0) + 1)
for (const [sql, n] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} 次  ${sql}`)
}

await raw.close()

const failures: string[] = []
if (perEvent > BUDGET) failures.push(`${perEvent.toFixed(1)} > ${BUDGET} 次/条`)
if (commits > COMMIT_BUDGET) failures.push(`${commits} > ${COMMIT_BUDGET} 次提交`)

console.log(`\n${'─'.repeat(60)}`)
if (failures.length === 0) {
  console.log(
    `闸门 2 条，通过 2 条，失败 0 条（${perEvent.toFixed(1)} ≤ ${BUDGET} 次/条，${commits} ≤ ${COMMIT_BUDGET} 次提交）`
  )
  console.log('─'.repeat(60))
} else {
  console.log(`闸门 2 条，通过 0 条，失败 2 条（${failures.join('；')}）`)
  console.log('─'.repeat(60))
  process.exitCode = 1
}
