import { createHash } from 'node:crypto'
import { buildSchema } from './schema.js'
import type { Db } from './client.js'
import type { Dialect } from './dialect.js'

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
  up(db: Db, dialect: Dialect): void
}

/** 表是否存在 */
function tableExists(db: Db, name: string): boolean {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?",
    [name]
  )
  return (row?.n ?? 0) > 0
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
function migrateLegacyV1Data(db: Db): void {
  if (!tableExists(db, 'apps')) return

  const legacyApps = db.all<{
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
  db.run(
    `INSERT OR IGNORE INTO organizations (id, slug, name, created_at) VALUES (1, 'legacy', 'Legacy', ?)`,
    [now]
  )

  for (const app of legacyApps) {
    // 老 app_id（app_xxx）直接当 slug，肉眼可辨
    db.run(
      `INSERT OR IGNORE INTO projects
         (id, organization_id, slug, name, platform, retention_days, event_quota, created_at)
       VALUES (?, 1, ?, ?, 'javascript', 90, 1000000, ?)`,
      [legacyAppId(app.app_id), app.app_id, app.name, app.created_at]
    )

    // 密钥：哈希直接搬，老 token 继续可用
    db.run(
      `INSERT OR IGNORE INTO project_keys (project_id, kind, key_hash, label, created_at)
       VALUES (?, 'runtime', ?, '迁移自 v1', ?)`,
      [legacyAppId(app.app_id), app.token_hash, app.created_at]
    )
    db.run(
      `INSERT OR IGNORE INTO project_keys (project_id, kind, key_hash, label, created_at)
       VALUES (?, 'upload', ?, '迁移自 v1', ?)`,
      [legacyAppId(app.app_id), app.upload_token_hash, app.created_at]
    )
  }

  // errors → issues
  const legacyErrors = db.all<{
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

    db.run(
      `INSERT OR IGNORE INTO issues
         (id, project_id, fingerprint, short_id, category, kind, title, level,
          status, substatus, count, user_count, first_seen, last_seen,
          is_bookmarked, is_subscribed, has_seen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'error', 'unresolved', 'new', ?, 0, ?, ?, 0, 0, 0, ?, ?)`,
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
  if (tableExists(db, 'error_events')) {
    const legacyEvents = db.all<{
      id: number
      app_id: string
      fingerprint: string
      error_id: number | null
      occurred_at: number
      received_at: number
      payload_json: string
    }>('SELECT * FROM error_events')

    for (const event of legacyEvents) {
      db.run(
        `INSERT OR IGNORE INTO issue_events
           (issue_id, project_id, event_id, occurred_at, received_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
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

  // 老表清空 —— 数据已经搬到新模型，留着只会让人困惑
  for (const table of ['error_events', 'errors', 'sourcemaps', 'apps']) {
    if (tableExists(db, table)) db.exec(`DROP TABLE ${table}`)
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
    up(db, dialect) {
      db.exec(buildSchema(dialect))
    }
  },
  {
    version: 2,
    name: 'migrate-legacy-v1-data',
    up(db) {
      migrateLegacyV1Data(db)
    }
  }
]

/**
 * 执行所有未应用的迁移。
 *
 * @returns 本次实际执行的版本号
 */
export function runMigrations(db: Db, dialect: Dialect, migrations: Migration[]): number[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`
  )

  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version)
  )

  const executed: number[] = []

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue

    // 每个版本一个事务：迁移失败不会留下半截状态
    db.transaction(() => {
      migration.up(db, dialect)
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        Date.now()
      ])
    })

    executed.push(migration.version)
  }

  return executed
}
