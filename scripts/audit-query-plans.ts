/**
 * 查询计划闸门 —— 找出在真实数据量下会退化成全表扫描的查询。
 *
 * ## 为什么需要
 *
 * 演示数据只有几十行，任何查询都是「亚毫秒」。
 * 但线上 `issue_events` / `transactions` / `behavior_events` 这些表
 * 会随流量线性增长 —— 缺索引的查询在 10 万行时是**全表扫描**，
 * 而这在演示数据上完全看不出来。
 *
 * ## 怎么做的
 *
 * 1. 用 `app.inject()` 打一遍管理端所有 GET 接口，
 *    插桩记录**实际执行的 SQL**（不靠猜，直接从运行时拿）
 * 2. 把库复制一份，灌入合成数据把增长表放大到 ~2 万行
 * 3. 对每条 SQL 跑 `EXPLAIN QUERY PLAN`，看是不是走了索引
 *
 * ⚠️ 计划必须在**放大后的库**上看 —— SQLite 的计划选择依赖表规模，
 *    小表上「全表扫描更便宜」的判断到了线上会翻车。
 *
 * ## 为什么要内联参数
 *
 * `EXPLAIN QUERY PLAN` 对带 `?` 的语句要求绑定参数，
 * 而绑 `NULL` 会让优化器以为条件恒假、把约束整个优化掉，
 * 计划就失真了。这里把 `?` 换成字面量 `0`：
 * 约束还在（`col = 0` 照样是等值约束），计划有代表性。
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { buildApp } from '../packages/collector/src/app.js'
import { openDb, defaultDbPath } from '../packages/collector/src/infra/db/client.js'
import type { Db } from '../packages/collector/src/infra/db/types.js'

const ADMIN_TOKEN = 'audit-plans-token'
/** 增长表放大到多少行 —— 足以让「扫表 vs 走索引」的分歧显现 */
const TARGET_ROWS = 20_000

/** 随流量增长的表 —— 这些表上的全表扫描是真问题 */
const GROWTH_TABLES = [
  'issues',
  'issue_events',
  'issue_activity',
  'issue_comments',
  'transactions',
  'spans',
  'behavior_events',
  'replay_sessions',
  'replay_events',
  'alert_incidents',
  'audit_log'
]

/** 管理端只读接口清单 */
function readEndpoints(
  projectId: string,
  issueId: number | undefined
): { path: string; method: 'GET' | 'POST' }[] {
  const p = `/api/v1/projects/${projectId}`
  return [
    { path: '/api/v1/organizations', method: 'GET' },
    { path: `${p}/stats`, method: 'GET' },
    { path: `${p}/issues`, method: 'GET' },
    { path: `${p}/issues/trend`, method: 'GET' },
    { path: `${p}/performance`, method: 'GET' },
    { path: `${p}/transactions`, method: 'GET' },
    { path: `${p}/error-performance`, method: 'GET' },
    { path: `${p}/behavior/summary`, method: 'GET' },
    { path: `${p}/sessions`, method: 'GET' },
    { path: `${p}/sessions/1/replay`, method: 'GET' },
    { path: `${p}/alert-rules`, method: 'GET' },
    { path: `${p}/channels`, method: 'GET' },
    { path: `${p}/alert-incidents`, method: 'GET' },
    { path: `${p}/issues/${issueId ?? 1}`, method: 'GET' },
    // 带时间窗的变体 —— 线上默认都带窗口，窗口查询的谓词更多，更容易丢索引
    { path: `${p}/stats?since=1700000000000&until=1800000000000`, method: 'GET' },
    { path: `${p}/issues?since=1700000000000&until=1800000000000`, method: 'GET' },
    { path: `${p}/issues/trend?since=1700000000000&until=1800000000000`, method: 'GET' },
    { path: `${p}/performance?since=1700000000000&until=1800000000000`, method: 'GET' },
    { path: `${p}/transactions?since=1700000000000&until=1800000000000`, method: 'GET' },
    { path: `${p}/behavior/summary?since=1700000000000&until=1800000000000`, method: 'GET' },
    { path: `${p}/sessions?since=1700000000000&until=1800000000000`, method: 'GET' },
    { path: `${p}/alert-incidents?since=1700000000000&until=1800000000000`, method: 'GET' }
  ]
}

/** 把 `?` 换成字面量 0（跳过单引号字符串里的内容） */
function inlineParams(sql: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      inString = !inString
      out += ch
      continue
    }
    if (!inString && ch === '?') {
      out += '0'
      continue
    }
    out += ch
  }
  return out
}

type Recorded = { sql: string; params: unknown[] | Record<string, unknown> | undefined }

async function collectSql(projectId: string, issueId: number | undefined): Promise<Recorded[]> {
  const base = await openDb(defaultDbPath(), { migrate: false })
  const recorded: Recorded[] = []

  const record = (sql: string, params?: unknown[] | Record<string, unknown>) => {
    recorded.push({ sql, params })
  }

  const spy: Db = {
    dialect: base.dialect,
    exec: (sql) => base.exec(sql),
    all: async (sql, params) => {
      record(sql, params)
      return base.all(sql, params)
    },
    get: async (sql, params) => {
      record(sql, params)
      return base.get(sql, params)
    },
    run: (sql, params) => base.run(sql, params),
    insert: async (sql, params) => {
      record(sql, params)
      return base.insert(sql, params)
    },
    transaction: (fn) => base.transaction(fn),
    close: () => base.close()
  }

  const { app } = await buildApp({ db: spy, adminToken: ADMIN_TOKEN })
  for (const ep of readEndpoints(projectId, issueId)) {
    const res = await app.inject({
      method: ep.method,
      url: ep.path,
      headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
    })
    if (res.statusCode >= 400) {
      console.warn(`  ⚠ ${ep.path} → ${res.statusCode} ${res.body.slice(0, 100)}`)
    }
  }
  await app.close()
  await base.close()
  return recorded
}

/** 把增长表灌到 TARGET_ROWS 行（复制体上操作，不碰真库） */
function inflate(db: Database.Database): Map<string, number> {
  // 造数只为让查询计划显出「扫表 vs 走索引」的差别，
  // 外键完整性无关紧要 —— 关掉免得造出指向不存在父行的行
  db.pragma('foreign_keys = OFF')
  const sizes = new Map<string, number>()
  for (const table of GROWTH_TABLES) {
    const exists = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table) as { n: number } | undefined
    if (!exists || exists.n === 0) continue

    const current = (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
    const need = Math.max(0, TARGET_ROWS - current)
    sizes.set(table, current)
    if (need === 0) continue

    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string
      type: string
      notnull: number
      dflt_value: unknown
    }[]
    const writable = cols.filter((c) => !/^(id|rowid)$/i.test(c.name))
    if (writable.length === 0) continue

    // ⚠️ 只有**外键列**要固定成已有值 —— 固定了才不会指向不存在的父行。
    //    非外键的 `*_id`（比如 event_id、session_id）必须逐行唯一，
    //    否则 UNIQUE 约束会把造出来的行全挡掉（表根本没变大，计划就失真了）。
    const fkCols = new Set(
      (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { from: string }[]).map(
        (r) => r.from
      )
    )
    const sample = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as
      Record<string, unknown> | undefined
    const keep = (name: string): boolean => fkCols.has(name)

    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${table} (${writable.map((c) => c.name).join(', ')}) VALUES (${writable
        .map(() => '?')
        .join(', ')})`
    )
    const tx = db.transaction((from: number, to: number) => {
      for (let i = from; i < to; i++) {
        const row = writable.map((c) => {
          if (keep(c.name) && sample && sample[c.name] !== undefined) return sample[c.name]
          if (sample && sample[c.name] !== undefined && typeof sample[c.name] === 'number') return i
          return `bench-${c.name}-${i}`
        })
        insert.run(...row)
      }
    })
    tx(current, current + need)
    const after = (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
    sizes.set(table, after)
  }
  return sizes
}

function planFor(db: Database.Database, sql: string): string[] {
  try {
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${inlineParams(sql)}`)
    const rows = stmt.all() as { detail: string }[]
    return rows.map((r) => r.detail)
  } catch (err) {
    return [`<无法解释> ${(err as Error).message}`]
  }
}

async function main() {
  const src = defaultDbPath()
  if (!existsSync(src)) throw new Error(`找不到数据库：${src}`)

  const real = new Database(src, { readonly: true })
  // 挑**有 issue 的项目** —— 种子数据里各项目的 issue 数不一样，
  // 挑错项目会让 issue 详情接口 404，少覆盖一条查询
  const withIssues = real
    .prepare(
      'SELECT project_id AS id, count(*) AS n FROM issues GROUP BY project_id ORDER BY n DESC LIMIT 1'
    )
    .get() as { id: number; n: number } | undefined
  const fallback = real.prepare('SELECT id FROM projects LIMIT 1').get() as
    { id: number } | undefined
  const project = withIssues ?? fallback
  const firstIssue = project
    ? (real.prepare('SELECT id FROM issues WHERE project_id = ? LIMIT 1').get(project.id) as
        { id: number } | undefined)
    : undefined
  real.close()
  if (!project) throw new Error('库里没有项目，先跑 npm run seed:demo')

  console.log('① 插桩记录实际执行的 SQL…')
  const recorded = await collectSql(String(project.id), firstIssue?.id)
  const selects = recorded.filter((r) => /^\s*select/i.test(r.sql))
  const unique = new Map<string, string>()
  for (const r of selects) unique.set(r.sql, r.sql)
  console.log(
    `   记录到 ${recorded.length} 条 SQL，其中 SELECT ${selects.length} 条，去重后 ${unique.size} 条\n`
  )

  const tmp = join(process.cwd(), 'data', 'audit-plans.db')
  copyFileSync(src, tmp)
  // 复制体上先跑迁移 —— 索引是迁移加的，不迁移的话复制体还是旧结构，
  // 闸门会把「已经修好的问题」继续报出来
  const migrated = await openDb(tmp, { migrate: true })
  await migrated.close()
  const scale = new Database(tmp)
  console.log('② 放大增长表…')
  const sizes = inflate(scale)
  for (const [t, n] of sizes) console.log(`   ${t.padEnd(20)} → ${n} 行`)
  console.log('')

  console.log('③ 跑 EXPLAIN QUERY PLAN…')
  const offenders: { sql: string; plan: string[] }[] = []
  let checked = 0
  for (const sql of unique.keys()) {
    const plan = planFor(scale, sql)
    checked++
    const fullScan = plan.filter(
      (line) =>
        /^(SCAN|SEARCH)/.test(line) &&
        /\bSCAN\b/.test(line) &&
        !/USING (COVERING )?INDEX/.test(line)
    )
    // 只有扫的是「增长表」才算真问题 —— 维度表小，扫一次无所谓
    const growthScan = fullScan.filter((line) =>
      GROWTH_TABLES.some((t) => new RegExp(`\\bSCAN ${t}\\b`).test(line))
    )
    if (growthScan.length > 0) offenders.push({ sql, plan })
  }

  for (const o of offenders) {
    console.log(`\n✗ 全表扫描：${o.sql.replace(/\s+/g, ' ').slice(0, 110)}`)
    for (const line of o.plan) console.log(`    ${line}`)
  }

  scale.close()
  rmSync(tmp, { force: true })

  console.log(`\n${'─'.repeat(60)}`)
  if (offenders.length === 0) {
    console.log(`闸门 1 条，通过 1 条，失败 0 条（检查了 ${checked} 条查询，全部走索引）`)
    console.log('─'.repeat(60))
    return
  }
  console.log(
    `闸门 1 条，通过 0 条，失败 1 条（${offenders.length}/${checked} 条查询退化成全表扫描）`
  )
  console.log('─'.repeat(60))
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
