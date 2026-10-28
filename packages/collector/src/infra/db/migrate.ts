import { createHash } from 'node:crypto'
import { buildSchema } from './schema.js'
import type { Db } from './types.js'
import { ts as tsType, type Dialect } from './dialect.js'

/**
 * 迁移框架。
 *
 * ## 为什么要版本化迁移
 *
 * 企业级系统的 schema 一定会变。两种做法：
 * - 每次改动删库重建 —— 开发期能接受，**上线后是灾难**
 * - 版本化迁移 —— 每个版本一条不可变的脚本，记录在 `schema_migrations` 里
 *
 * 迁移必须是**只增不改**的：已经跑过的版本不能改，因为线上环境已经应用了它。
 * 要改就加一个新版本。
 */
export interface Migration {
  version: number
  name: string
  up(db: Db, dialect: Dialect): Promise<void>
}

/**
 * 表是否存在。
 *
 * 两边查的地方不一样：SQLite 有自己的系统表 `sqlite_master`，
 * PG 走标准的 `information_schema`。
 *
 * ⚠️ `sqlite_master` 在 PG 上**根本不存在** —— 查它会直接报
 * 「relation does not exist」，整个迁移流程起不来。
 */
async function tableExists(db: Db, dialect: Dialect, name: string): Promise<boolean> {
  if (dialect === 'postgres') {
    const row = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ?`,
      [name]
    )
    return (row?.n ?? 0) > 0
  }
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?",
    [name]
  )
  return (row?.n ?? 0) > 0
}

/** 表里有没有某列 */
async function hasColumn(
  db: Db,
  dialect: Dialect,
  table: string,
  column: string
): Promise<boolean> {
  if (dialect === 'postgres') {
    const row = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
      [table, column]
    )
    return (row?.n ?? 0) > 0
  }
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?',
    [table, column]
  )
  return (row?.n ?? 0) > 0
}

/**
 * 腾出与 v2 同名的老表。
 *
 * ## 为什么必须做
 *
 * v1 和 v2 都有 `sourcemaps` 表，但**列结构不同**：
 *   v1：app_id + release（字符串）
 *   v2：project_id + release_id（外键）
 *
 * 而建表语句是 `CREATE TABLE IF NOT EXISTS sourcemaps (...)` ——
 * 表名已存在时它**什么都不做**，于是 v2 的列根本不存在。
 * 后果是任何上报在查 sourcemaps 时都抛错，整个摄入链路 500。
 *
 * 而且它**只在有历史数据的库上出现** —— 全新库没有老表，一切正常。
 * 这类 bug 最危险的地方就在这里：本地全绿，升级的生产环境直接挂。
 *
 * 修法：建 v2 的表**之前**先把老表改名，把表名腾出来。
 */
async function renameLegacyTables(db: Db, dialect: Dialect): Promise<void> {
  if (
    (await tableExists(db, dialect, 'sourcemaps')) &&
    !(await hasColumn(db, dialect, 'sourcemaps', 'project_id'))
  ) {
    await db.exec('ALTER TABLE sourcemaps RENAME TO sourcemaps_legacy')
  }
}

/**
 * v1 → v2 的数据迁移：老的 4 张表搬进新的领域模型。
 *
 * 老结构（v1）：
 *   apps(app_id, name, token_hash, upload_token_hash, enabled, created_at, last_seen_at)
 *   errors(id, app_id, fingerprint, category, kind, name, message, ...)
 *   error_events(id, app_id, fingerprint, error_id, occurred_at, received_at, payload_json)
 *   sourcemaps(id, app_id, release, file_name, base_name, map_json, uploaded_at)
 *
 * 新结构（v2）：
 *   organizations → projects → project_keys / issues / issue_events / sourcemaps
 *
 * 关键点：**老 token 的哈希直接搬过去**，所以用户已有的上报 token 不会失效。
 * （明文本来就没存，存的是哈希，搬哈希即可。）
 */
async function migrateLegacyV1Data(db: Db, dialect: Dialect): Promise<void> {
  if (!(await tableExists(db, dialect, 'apps'))) return

  const legacyApps = await db.all<{
    app_id: string
    name: string
    token_hash: string
    upload_token_hash: string
    enabled: number
    created_at: number
    last_seen_at: number | null
  }>('SELECT * FROM apps')

  if (legacyApps.length === 0) return

  const now = Date.now()

  // 一个组织装下所有老应用 —— 迁移期的临时结构
  await db.run(
    `INSERT INTO organizations (id, slug, name, created_at) VALUES (1, 'legacy', 'Legacy', ?) ON CONFLICT DO NOTHING`,
    [now]
  )

  for (const app of legacyApps) {
    // 老 app_id（app_xxx）直接当 slug，肉眼可辨
    await db.run(
      `INSERT INTO projects
         (id, organization_id, slug, name, platform, retention_days, event_quota, created_at)
       VALUES (?, 1, ?, ?, 'javascript', 90, 1000000, ?) ON CONFLICT DO NOTHING`,
      [legacyAppId(app.app_id), app.app_id, app.name, app.created_at]
    )

    // 密钥：哈希直接搬，老 token 继续可用
    await db.run(
      `INSERT INTO project_keys (project_id, kind, key_hash, label, created_at)
       VALUES (?, 'runtime', ?, '迁移自 v1', ?) ON CONFLICT DO NOTHING`,
      [legacyAppId(app.app_id), app.token_hash, app.created_at]
    )
    await db.run(
      `INSERT INTO project_keys (project_id, kind, key_hash, label, created_at)
       VALUES (?, 'upload', ?, '迁移自 v1', ?) ON CONFLICT DO NOTHING`,
      [legacyAppId(app.app_id), app.upload_token_hash, app.created_at]
    )
  }

  // errors → issues
  const legacyErrors = await db.all<{
    id: number
    app_id: string
    fingerprint: string
    category: string
    kind: string
    name: string | null
    message: string
    url: string | null
    referrer: string | null
    user_agent: string | null
    browser: string | null
    os: string | null
    device: string | null
    environment: string | null
    release: string | null
    first_seen: number
    last_seen: number
    count: number
    raw_stack: string | null
    resolved_stack: string | null
    http_json: string | null
    resource_json: string | null
  }>('SELECT * FROM errors')

  for (const error of legacyErrors) {
    // 老数据里可能有空指纹（早期种子脚本的 bug），补一个兜底
    const fingerprint =
      error.fingerprint && error.fingerprint.length > 0
        ? error.fingerprint
        : createHash('sha256')
            .update(`${error.category}|${error.message}|${error.url ?? ''}`)
            .digest('hex')
            .slice(0, 16)

    await db.run(
      `INSERT INTO issues
         (id, project_id, fingerprint, short_id, category, kind, title, level,
          status, substatus, count, user_count, first_seen, last_seen,
          is_bookmarked, is_subscribed, has_seen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', 'unresolved', 'new', ?, 0, ?, ?, 0, 0, 0, ?, ?) ON CONFLICT DO NOTHING`,
      [
        error.id,
        legacyAppId(error.app_id),
        fingerprint,
        shortIdFor(error.id),
        error.category,
        error.kind,
        error.name || error.message.slice(0, 120),
        error.count,
        error.first_seen,
        error.last_seen,
        error.first_seen,
        error.last_seen
      ]
    )
  }

  // error_events → issue_events
  if (await tableExists(db, dialect, 'error_events')) {
    const legacyEvents = await db.all<{
      id: number
      app_id: string
      fingerprint: string
      error_id: number | null
      occurred_at: number
      received_at: number
      payload_json: string
    }>('SELECT * FROM error_events')

    for (const event of legacyEvents) {
      await db.run(
        `INSERT INTO issue_events
           (issue_id, project_id, event_id, occurred_at, received_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          event.error_id ?? 0,
          legacyAppId(event.app_id),
          `legacy-${event.id}`,
          event.occurred_at,
          event.received_at,
          event.payload_json
        ]
      )
    }
  }

  // 迁移过来的 Issue 也要有活动流 —— 否则详情页是空的，
  // 「这个问题是什么时候出现的」就无从查起。
  const migrated = await db.all<{ id: number; first_seen: number }>(
    'SELECT id, first_seen FROM issues WHERE id NOT IN (SELECT issue_id FROM issue_activity)'
  )

  for (const issue of migrated) {
    await db.run(
      `INSERT INTO issue_activity
         (issue_id, actor_type, actor_id, action, reason, data_json, created_at)
       VALUES (?, 'system', NULL, 'created', ?, NULL, ?)`,
      [issue.id, '从 v1 迁移导入', issue.first_seen]
    )
  }

  // v1 的 sourcemaps → v2 的 sourcemaps
  //
  // ⚠️ 这两张表**同名**，但列不一样（v1 是 app_id + release 字符串，
  //    v2 是 project_id + release_id 外键）。
  //    建表阶段已经把老表改名成 sourcemaps_legacy，把表名腾给 v2 了。
  if (await tableExists(db, dialect, 'sourcemaps_legacy')) {
    const legacyMaps = await db.all<{
      id: number
      app_id: string
      release: string
      file_name: string
      base_name: string
      map_json: string
      uploaded_at: number
    }>('SELECT * FROM sourcemaps_legacy')

    // v1 的行按列名取，v2 的行按外键取 —— 两套列名，不能直接搬
    for (const map of legacyMaps) {
      const releaseRow = await db.get<{ id: number }>(
        'SELECT id FROM releases WHERE project_id = ? AND version = ?',
        [legacyAppId(map.app_id), map.release]
      )

      await db.run(
        `INSERT INTO sourcemaps
           (project_id, release_id, file_name, base_name, map_json, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          legacyAppId(map.app_id),
          releaseRow?.id ?? null,
          map.file_name,
          map.base_name,
          map.map_json,
          map.uploaded_at
        ]
      )
    }

    await db.exec('DROP TABLE sourcemaps_legacy')
  }

  // 老表清空 —— 数据已经搬到新模型，留着只会让人困惑。
  //
  // ⚠️ 只删**v2 里不存在同名表**的老表。
  //    `sourcemaps` 两边都有，删了就把 v2 的表也毁了。
  for (const table of ['error_events', 'errors', 'apps']) {
    if (await tableExists(db, dialect, table)) await db.exec(`DROP TABLE ${table}`)
  }
}

/** 老 app_id（app_xxx）→ 稳定的整数项目 ID */
function legacyAppId(appId: string): number {
  const hash = createHash('sha256').update(appId).digest()
  // 取正整数，避免 0（0 在自增主键里有特殊含义）
  return (hash.readUInt32BE(0) % 1_000_000_000) + 1
}

/** 短 ID：VIG-XXXX */
function shortIdFor(id: number): string {
  return `VIG-${id.toString(36).toUpperCase().padStart(4, '0')}`
}

/**
 * 迁移列表。
 *
 * ⚠️ 已发布的迁移**不能修改** —— 线上环境已经应用过了。
 *    要改就加一个新版本。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-schema',
    async up(db, dialect) {
      // ⚠️ 顺序很重要：先腾出与 v2 同名的老表，再建 v2 的表。
      //    `CREATE TABLE IF NOT EXISTS` 遇到同名表会**静默跳过**，
      //    老表结构就被沿用了 —— 症状是 v2 的列根本不存在。
      await renameLegacyTables(db, dialect)
      await db.exec(buildSchema(dialect))
    }
  },
  {
    version: 2,
    name: 'migrate-legacy-v1-data',
    async up(db, dialect) {
      await migrateLegacyV1Data(db, dialect)
    }
  }
]

/**
 * 执行所有未应用的迁移。
 *
 * @returns 本次实际执行的版本号
 */
export async function runMigrations(
  db: Db,
  dialect: Dialect,
  migrations: Migration[]
): Promise<number[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at ${tsType(dialect)} NOT NULL
     )`
  )

  const applied = new Set(
    (await db.all<{ version: number }>('SELECT version FROM schema_migrations')).map(
      (r) => r.version
    )
  )

  const executed: number[] = []

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue

    // 每个版本一个事务：迁移失败不会留下半截状态
    await db.transaction(async () => {
      await migration.up(db, dialect)
      await db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        Date.now()
      ])
    })

    executed.push(migration.version)
  }

  return executed
}
