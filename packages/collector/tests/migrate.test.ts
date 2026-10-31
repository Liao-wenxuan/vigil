import { describe, expect, it } from 'vitest'
import { openDb } from '../src/infra/db/client.js'
import type { Db } from '../src/infra/db/types.js'
import { runMigrations, MIGRATIONS } from '../src/infra/db/migrate.js'
import { fp, makeEvent, setupDb } from './helpers.js'

/**
 * v1（老版本）的表结构。
 *
 * 照抄老版本的样子建表 —— 迁移测试的价值全在��**真实的老库**上。
 */
const LEGACY_DDL = `
CREATE TABLE apps (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  upload_token_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  message TEXT NOT NULL,
  url TEXT,
  referrer TEXT,
  user_agent TEXT,
  browser TEXT,
  os TEXT,
  device TEXT,
  environment TEXT,
  release TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  raw_stack TEXT,
  resolved_stack TEXT,
  http_json TEXT,
  resource_json TEXT
);

CREATE TABLE error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  error_id INTEGER,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE sourcemaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  release TEXT NOT NULL,
  file_name TEXT NOT NULL,
  base_name TEXT NOT NULL,
  map_json TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
`

/** 造一个"有历史数据的老库" */
async function createLegacyDb() {
  const db = await openDb(':memory:', { migrate: false })
  await db.exec(LEGACY_DDL)

  await db.run(
    `INSERT INTO apps (app_id, name, token_hash, upload_token_hash, enabled, created_at)
     VALUES ('app_legacy1', '老应用', 'hash_runtime', 'hash_upload', 1, ?)`,
    [1000]
  )
  await db.run(
    `INSERT INTO errors
       (id, app_id, fingerprint, category, kind, name, message, first_seen, last_seen, count)
     VALUES (1, 'app_legacy1', 'fingerprint1', 'javascript', 'js', 'TypeError', 'boom', 2000, 3000, 5)`,
    []
  )
  await db.run(
    `INSERT INTO error_events
       (id, app_id, fingerprint, error_id, occurred_at, received_at, payload_json)
     VALUES (1, 'app_legacy1', 'fingerprint1', 1, 2000, 2100, '{"message":"boom"}')`,
    []
  )
  await db.run(
    `INSERT INTO sourcemaps (app_id, release, file_name, base_name, map_json, uploaded_at)
     VALUES ('app_legacy1', '1.0.0', 'assets/index.js', 'index.js', '{"version":3}', 2500)`,
    []
  )

  return db
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?",
    [name]
  )
  return (row?.n ?? 0) > 0
}

describe('v1 → v2 数据迁移', () => {
  it('老表被清理，新表建好', async () => {
    const db = await createLegacyDb()
    await runMigrations(db, 'sqlite', MIGRATIONS)

    expect(await tableExists(db, 'apps')).toBe(false)
    expect(await tableExists(db, 'errors')).toBe(false)
    expect(await tableExists(db, 'error_events')).toBe(false)

    expect(await tableExists(db, 'organizations')).toBe(true)
    expect(await tableExists(db, 'projects')).toBe(true)
    expect(await tableExists(db, 'issues')).toBe(true)
    expect(await tableExists(db, 'issue_events')).toBe(true)
    await db.close()
  })

  it('sourcemaps 表不会被误删（v1 与 v2 同名）', async () => {
    // ⚠️ 回归测试：之前迁移里直接 DROP sourcemaps，
    //    结果把 v2 刚建好的同名表也删了 ——
    //    症状是任何上报都在查 sourcemaps 时抛错，整个摄入链路 500。
    const db = await createLegacyDb()
    await runMigrations(db, 'sqlite', MIGRATIONS)

    expect(await tableExists(db, 'sourcemaps')).toBe(true)
    await db.close()
  })

  it('sourcemap 数据被搬到 v2 结构（project_id + release_id）', async () => {
    const db = await createLegacyDb()
    await runMigrations(db, 'sqlite', MIGRATIONS)

    const rows = await db.all<{ file_name: string; base_name: string; map_json: string }>(
      'SELECT file_name, base_name, map_json FROM sourcemaps'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].file_name).toBe('assets/index.js')
    expect(rows[0].map_json).toBe('{"version":3}')
    await db.close()
  })

  it('老错误被搬进 issues，且带上活动流起点', async () => {
    const db = await createLegacyDb()
    await runMigrations(db, 'sqlite', MIGRATIONS)

    const issues = await db.all<{
      fingerprint: string
      count: number
      status: string
      substatus: string
    }>('SELECT fingerprint, count, status, substatus FROM issues')

    expect(issues).toHaveLength(1)
    expect(issues[0].fingerprint).toBe('fingerprint1')
    expect(issues[0].count).toBe(5)
    expect(issues[0].status).toBe('unresolved')

    // 迁移过来的 Issue 也要有活动流 —— 否则详情页是空的
    const activity = await db.all<{ action: string; reason: string }>(
      'SELECT action, reason FROM issue_activity'
    )
    expect(activity).toHaveLength(1)
    expect(activity[0].action).toBe('created')
    await db.close()
  })

  it('老 token 的哈希被搬过去（老密钥继续可用）', async () => {
    const db = await createLegacyDb()
    await runMigrations(db, 'sqlite', MIGRATIONS)

    const keys = await db.all<{ kind: string; key_hash: string }>(
      'SELECT kind, key_hash FROM project_keys'
    )
    expect(keys).toHaveLength(2)
    expect(keys.find((k) => k.kind === 'runtime')?.key_hash).toBe('hash_runtime')
    expect(keys.find((k) => k.kind === 'upload')?.key_hash).toBe('hash_upload')
    await db.close()
  })

  it('老事件明细被搬进 issue_events', async () => {
    const db = await createLegacyDb()
    await runMigrations(db, 'sqlite', MIGRATIONS)

    const events = await db.all<{ event_id: string }>('SELECT event_id FROM issue_events')
    expect(events).toHaveLength(1)
    expect(events[0].event_id).toBe('legacy-1')
    await db.close()
  })

  it('全新库（没有老表）不会触发数据迁移', async () => {
    const db = await openDb(':memory:', { migrate: false })
    await runMigrations(db, 'sqlite', MIGRATIONS)

    expect(await tableExists(db, 'sourcemaps')).toBe(true)
    const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')
    expect(row?.n).toBe(0)
    await db.close()
  })
})

/**
 * v3：用量计数器的回填。
 *
 * 这一段的关键在「**已经有数据的库**」上：计数器从 0 起步看起来能跑，
 * 但等于给每个老项目凭空多发了一整个配额。这种错不会报错，只会让限额失效。
 */
describe('迁移 v3：用量计数器', () => {
  it('老库里已摄入的事件条数被回填进计数器', async () => {
    const { db, issues, project } = await setupDb()

    for (let i = 0; i < 3; i++) {
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp(`old-${i}`), occurredAt: Date.now() + i })
      )
    }

    // 退回到 v3 之前的状态：删表 + 删迁移记录
    await db.exec('DROP TABLE project_usage')
    await db.run('DELETE FROM schema_migrations WHERE version = 3')

    const applied = await runMigrations(db, 'sqlite', MIGRATIONS)
    expect(applied).toContain(3)

    const row = await db.get<{ events_total: number }>(
      'SELECT events_total FROM project_usage WHERE project_id = ?',
      [project.id]
    )
    expect(Number(row?.events_total)).toBe(3)
  })

  it('没有任何事件的项目也会建出计数行（值为 0）', async () => {
    const { db, tenancy, organization } = await setupDb()

    const empty = await tenancy.createProject({
      organizationId: organization.id,
      name: '空项目'
    })

    await db.exec('DROP TABLE project_usage')
    await db.run('DELETE FROM schema_migrations WHERE version = 3')
    await runMigrations(db, 'sqlite', MIGRATIONS)

    const row = await db.get<{ events_total: number }>(
      'SELECT events_total FROM project_usage WHERE project_id = ?',
      [empty.project.id]
    )
    expect(Number(row?.events_total)).toBe(0)
  })
})

/**
 * v4：告警历史按项目查的索引。
 *
 * 少了 `idx_alert_incidents_project`，告警历史列表会退化成
 * 「全表扫描 + 临时 B 树排序」。
 *
 * ⚠️ 这个错在演示数据上**看不出来** —— 只有几十行时扫表比走索引还快。
 *    所以这里先造够行数，再看 `EXPLAIN QUERY PLAN` 怎么说。
 */
describe('迁移 v4：告警历史项目索引', () => {
  /** 把 `?` 换成字面量 0 —— EXPLAIN 要求绑定参数，绑 NULL 会让优化器把约束优化掉 */
  function inlineParams(sql: string): string {
    return sql.replace(/\?/g, '0')
  }

  it('索引建好了', async () => {
    const { db } = await setupDb()
    const row = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name = 'idx_alert_incidents_project'"
    )
    expect(Number(row?.n)).toBe(1)
    await db.close()
  })

  it('告警历史列表走索引，不是全表扫描', async () => {
    const { db, project } = await setupDb()

    await db.run(
      `INSERT INTO alert_rules
         (project_id, name, type, threshold, window_seconds, enabled, created_at, updated_at)
       VALUES (?, '规则', 'error_count', 1, 300, 1, 1, 1)`,
      [project.id]
    )
    const rule = await db.get<{ id: number }>('SELECT id FROM alert_rules LIMIT 1')

    // 造到 3000 行 —— 行数够多时「扫表 vs 走索引」才有分歧
    const insert = async (i: number) =>
      db.run(
        `INSERT INTO alert_incidents
           (rule_id, project_id, status, triggered_at, dedupe_key, payload_json)
         VALUES (?, ?, 'triggered', ?, ?, '{}')`,
        [rule?.id ?? 1, project.id, 1000 + i, `dedupe-${i}`]
      )
    for (let i = 0; i < 3000; i++) await insert(i)

    const rows = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${inlineParams(
        'SELECT * FROM alert_incidents WHERE project_id = ? ORDER BY triggered_at DESC LIMIT ?'
      )}`
    )
    const plan = rows.map((r) => r.detail).join(' | ')

    expect(plan).toContain('idx_alert_incidents_project')
    // ⚠️ 双向断言：只断言「用了索引」不够 ——
    //    万一哪天有人把索引列写错，SQLite 可能仍报「用了索引」但其实先扫了表。
    expect(plan).not.toMatch(/SCAN alert_incidents/)
    // ORDER BY 也不能再靠临时排序
    expect(plan).not.toContain('TEMP B-TREE')
    await db.close()
  })
})
