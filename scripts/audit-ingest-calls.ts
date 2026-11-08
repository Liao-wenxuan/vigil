/**
 * 摄入路径的 DB 往返与提交预算。
 *
 * ## 为什么要有这个闸门
 *
 * 一条事件从进来到落库要跑好几条 SQL。**每条 SQL 在 PostgreSQL 部署下
 * 都是一次网络往返** —— 3 次往返就是 3 倍延迟。
 *
 * 而「多了一条查询」或「多了一次提交」是**静默**的：没有任何测试会挂，
 * 也没有报错，只有线上摄入变慢了才看得出来。所以得把它变成有上限的数字。
 *
 * ## 覆盖三条路径
 *
 * 早期版本只量错误事件，结果性能事务与行为事件悄悄留着「逐条写、
 * 逐条提交」也没人发现。现在错误 / 性能 / 行为一起量。
 *
 * ## 怎么量
 *
 * 包一层 `Db` 记 SQL，跑**真实的管道**（不是直接调领域方法），
 * 统计每条事件的往返次数和每批的提交次数。
 * 每批有固定开销（配额检查、用量记账），所以跑 1 条和 20 条两个规模
 * 取差值 —— 只把随条数增长的部分算进每条预算。
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
import type { ErrorEvent, PerformanceEvent } from '@vigil/protocol'

/** 用来测量的事件条数（SDK 一批最多 20 条） */
const SAMPLE = 20

type PathBudget = {
  label: string
  /** 稳态下每条事件允许的 DB 往返次数 */
  perEvent: number
  /** 一批允许的提交次数 */
  commits: number
}

const PATHS: PathBudget[] = [
  { label: '错误事件', perEvent: 3, commits: 1 },
  // span 已有自己的多行写入，逐条事务反而会把提交数放大到 20
  { label: '性能事务', perEvent: 3, commits: 1 },
  // 行为事件整批一条多行 VALUES —— 往返数不该随条数增长
  { label: '行为事件', perEvent: 0.5, commits: 1 }
]

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
const sdk = { name: 'vigil', version: '0.1.0' }
const envelope = (key: 'events' | 'transactions', items: unknown[]) =>
  ({ appId: 'bench', sdk, [key]: items }) as never

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

function makeTransaction(index: number): PerformanceEvent {
  return {
    name: 'GET /api/bench',
    type: 'navigation',
    durationMs: 120 + index,
    vitals: { fcp: 800, lcp: 1200, cls: 0.1, inp: 20, ttfb: 100, tbt: 30, longTaskCount: 1 },
    resourceCount: 3,
    transferSize: 4096,
    pageUrl: 'https://a.com/page',
    userAgent: 'bench-agent',
    sessionId: 'session-1',
    release: '1.4.2',
    environment: 'production',
    startedAt: 1_700_000_000_000 + index,
    spans: [
      {
        name: 'GET /api/bench',
        type: 'http',
        durationMs: 40,
        startedAt: 1_700_000_000_000 + index
      }
    ]
  } as unknown as PerformanceEvent
}

function makeBehavior(index: number) {
  return {
    sessionId: 'session-1',
    type: 'page_view',
    name: '/bench',
    url: '/bench',
    timestamp: 1_700_000_000_000 + index,
    durationMs: 12,
    data: null
  }
}

const runners: Record<string, (size: number) => Promise<void>> = {
  错误事件: async (size) => {
    const events = Array.from({ length: size }, (_, i) =>
      makeEvent({ occurredAt: 1_700_000_000_000 + Math.random() * 1_000_000 + i })
    )
    await pipeline.ingestErrors(project as never, envelope('events', events))
  },
  性能事务: async (size) => {
    const transactions = Array.from({ length: size }, (_, i) => makeTransaction(i))
    await pipeline.ingestPerformance(project as never, envelope('transactions', transactions))
  },
  行为事件: async (size) => {
    const events = Array.from({ length: size }, (_, i) => makeBehavior(i))
    await pipeline.ingestBehavior(project as never, envelope('events', events))
  }
}

function reset(): void {
  sqlLog.length = 0
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
  statements.length = 0
}

function totalCalls(): number {
  return counts.all + counts.get + counts.run + counts.insert
}

type Measurement = {
  budget: PathBudget
  perEvent: number
  commits: number
  ms: number
  sqlByFrequency: string[]
}

async function measure(budget: PathBudget): Promise<Measurement> {
  const run = runners[budget.label]
  // 先跑一条建立稳态（比如错误路径要先建出 issue）
  await run(1)

  reset()
  await run(1)
  const callsOne = totalCalls()

  reset()
  const t0 = performance.now()
  await run(SAMPLE)
  const ms = performance.now() - t0
  const callsBatch = totalCalls()
  const commits = statements.filter((s) => s === 'COMMIT').length

  const freq = new Map<string, number>()
  for (const sql of sqlLog) freq.set(sql, (freq.get(sql) ?? 0) + 1)
  const sqlByFrequency = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sql, n]) => `  ${String(n).padStart(3)} 次  ${sql}`)

  return {
    budget,
    // 批量写的 SQL 次数不随条数增长，差值会趋近 0 —— 那正是想要的
    perEvent: Math.max(0, (callsBatch - callsOne) / (SAMPLE - 1)),
    commits,
    ms,
    sqlByFrequency
  }
}

const results: Measurement[] = []
for (const budget of PATHS) results.push(await measure(budget))

console.log(`\n稳态摄入：一批 ${SAMPLE} 条，三条路径`)
console.log('路径        每条往返                 每批提交              耗时')
for (const r of results) {
  console.log(
    `${r.budget.label.padEnd(10)}  ${r.perEvent.toFixed(1)} 次（预算 ${r.budget.perEvent}）`.padEnd(
      30
    ) +
      `  ${r.commits} 次（预算 ${r.budget.commits}）`.padEnd(24) +
      `  ${r.ms.toFixed(1)} ms`
  )
}

const failures: string[] = []
for (const r of results) {
  if (r.perEvent > r.budget.perEvent) {
    failures.push(`${r.budget.label}：每条 ${r.perEvent.toFixed(1)} > ${r.budget.perEvent} 次`)
  }
  if (r.commits > r.budget.commits) {
    failures.push(`${r.budget.label}：${r.commits} > ${r.budget.commits} 次提交`)
  }
}

if (failures.length > 0) {
  console.log('\n各路径实际执行的 SQL（按次数）：')
  for (const r of results) {
    console.log(`  [${r.budget.label}]`)
    for (const line of r.sqlByFrequency) console.log(`    ${line}`)
  }
}

await raw.close()

const total = PATHS.length * 2
console.log(`\n${'─'.repeat(60)}`)
if (failures.length === 0) {
  console.log(`闸门 ${total} 条，通过 ${total} 条，失败 0 条`)
} else {
  console.log(`闸门 ${total} 条，通过 ${total - failures.length} 条，失败 ${failures.length} 条`)
  for (const f of failures) console.log(`  ✗ ${f}`)
}
console.log('─'.repeat(60))
if (failures.length > 0) process.exitCode = 1
