import { describe, expect, it } from 'vitest'
import { openDb } from '../src/infra/db/client.js'
import type { Db } from '../src/infra/db/types.js'
import { runMigrations, MIGRATIONS } from '../src/infra/db/migrate.js'

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
