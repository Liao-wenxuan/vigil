/**
 * 摄入路径的 DB 往返预算。
 *
 * ## 为什么要有这个闸门
 *
 * 一条错误事件从进来到落库要跑好几条 SQL。**每条 SQL 在 PostgreSQL 部署下
 * 都是一次网络往返** —— 5 次往返就是 5 倍延迟。
 *
 * 而「多了一条查询」是**静默**的：没有任何测试会挂，也没有报错，
 * 只有线上摄入变慢了才看得出来。所以得把它变成一个**有上限的数字**。
 *
 * ## 怎么量
 *
 * 包一层 `Db` 记 SQL，跑一批事件，统计每条事件的往返次数。
 *
 * ⚠️ 量的是**稳态**（Issue 已存在）—— 建 Issue 那条路径天然多几次，
 *    一次性成本不该算进每条事件的预算里。
 *
 * ## 预算怎么来的
 *
 * 稳态 4 次：
 *   1. 找 Issue            SELECT issues WHERE fingerprint
 *   2. 查重                SELECT issue_events WHERE event_id
 *   3. 写明细              INSERT issue_events
 *   4. 更新聚合计数与状态   UPDATE issues
 *
 * 曾多出来的一次是**查 sourcemap** —— 未命中没被缓存，
 * 没上传 map 的项目每条事件都要白跑一次库（现已被负缓存消掉）。
 */
import { createHash } from 'node:crypto'
import { openDb } from '../packages/collector/src/infra/db/client.js'
import type { Db } from '../packages/collector/src/infra/db/types.js'
import { TenancyService } from '../packages/collector/src/domains/tenancy/service.js'
import { ArtifactService } from '../packages/collector/src/domains/artifacts/service.js'
import { IssueService } from '../packages/collector/src/domains/issues/service.js'
import type { ErrorEvent } from '@vigil/protocol'

/**
 * 稳态下每条错误事件允许的 DB 往返次数
 *
 * 可以用环境变量临时调（`VIGIL_INGEST_BUDGET=3 npx tsx scripts/audit-ingest-calls.ts`）——
 * 调预算的时候要能看到闸门真的会挂。
 */
const BUDGET = Number(process.env.VIGIL_INGEST_BUDGET ?? 4)
/** 用来测量的事件条数 */
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
  close: () => raw.close()
}

const tenancy = new TenancyService(spy)
const artifacts = new ArtifactService(spy)
const issues = new IssueService(spy, artifacts.sourcemapResolver)

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

// 先建好 Issue —— 之后才是稳态
await issues.ingestEvent(project.id, makeEvent())

sqlLog.length = 0
for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0

const t0 = performance.now()
for (let i = 0; i < SAMPLE; i++) {
  await issues.ingestEvent(project.id, makeEvent({ occurredAt: 1_700_000_000_000 + i * 1000 }))
}
const dt = performance.now() - t0

const total = counts.all + counts.get + counts.run + counts.insert
const perEvent = total / SAMPLE

console.log(`稳态摄入 ${SAMPLE} 条事件`)
console.log(`  DB 往返：${total} 次（${perEvent.toFixed(1)} 次/条 · 预算 ${BUDGET} 次）`)
console.log(`  耗时：${dt.toFixed(1)} ms（${(dt / SAMPLE).toFixed(3)} ms/条）`)
console.log(`  分类：读 ${counts.all + counts.get} · 写 ${counts.run + counts.insert}`)

console.log('\n每条事件执行的 SQL（按次数）：')
const freq = new Map<string, number>()
for (const sql of sqlLog) freq.set(sql, (freq.get(sql) ?? 0) + 1)
for (const [sql, n] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} 次  ${sql}`)
}

await raw.close()

console.log(`\n${'─'.repeat(60)}`)
if (perEvent <= BUDGET) {
  console.log(`闸门 1 条，通过 1 条，失败 0 条（${perEvent.toFixed(1)} ≤ ${BUDGET} 次/条）`)
  console.log('─'.repeat(60))
} else {
  console.log(
    `闸门 1 条，通过 0 条，失败 1 条（${perEvent.toFixed(1)} > ${BUDGET} 次/条 —— 摄入路径变慢了）`
  )
  console.log('─'.repeat(60))
  process.exitCode = 1
}
