import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PostgresDb, type PgClient, type PgPool } from '../src/infra/db/postgres.js'
import { runMigrations, MIGRATIONS } from '../src/infra/db/migrate.js'
import { TenancyService } from '../src/domains/tenancy/service.js'
import { IssueService } from '../src/domains/issues/service.js'
import { ArtifactService } from '../src/domains/artifacts/service.js'
import { PerformanceService } from '../src/domains/performance/service.js'
import { ReplayService } from '../src/domains/replay/service.js'
import { TrendService } from '../src/domains/trend/service.js'
import { makeEvent, makeTransaction } from './helpers.js'

/**
 * **真 PostgreSQL** 上的兼容性验证。
 *
 * ## 为什么需要它
 *
 * SQLite 上跑通**不等于** PG 上能跑。本项目有一批 SQLite 独有的写法：
 * `last_insert_rowid()`、`INSERT OR REPLACE`、`INSERT OR IGNORE`、
 * `sqlite_master`、`pragma_table_info` —— 它们在 PG 上**全是语法错误**。
 *
 * 而 PG 那边还有 SQLite 没有的坑：占位符是 `$1` 不是 `?`、
 * `RETURNING` 的用法、`ON CONFLICT` 的冲突目标。
 *
 * ## PGlite 是什么
 *
 * **WASM 编译的 PostgreSQL 本体** —— 不是模拟器，是 PG 自己。
 * 所以这个测试跑的是**真 PG 的解析器与执行器**。
 *
 * 本机没有 PG 也没有 Docker（缺 WSL2），但 PGlite 让 CI 和本地
 * 都能真跑一遍 PG 方言。
 */

/** PGlite 适配成 `pg` 的连接池接口 */
class PGlitePool implements PgPool {
  constructor(private readonly pg: PGlite) {}

  async query(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    // 多语句（DDL 迁移）必须走 `exec` ——
    // PG 的**预处理语句**不接受多条命令（"cannot insert multiple commands
    // into a prepared statement"）。
    if (/;\s*\S/.test(sql)) {
      await this.pg.exec(sql)
      return { rows: [], rowCount: 0 }
    }
    const result = await this.pg.query(sql, params as never[])
    return { rows: result.rows as unknown[], rowCount: result.affectedRows ?? result.rows.length }
  }

  async connect(): Promise<PgClient> {
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {}
    }
  }
}

/** 建一个装好 schema 的 PG 库 */
async function createPgDb() {
  const pg = new PGlite()
  await pg.waitReady
  const db = new PostgresDb(new PGlitePool(pg))
  await runMigrations(db, 'postgres', MIGRATIONS)
  return { pg, db }
}

describe('PostgreSQL 兼容性', () => {
  it('成员凭据与项目授权在 PG 上能签发、查哈希、改角色、撤销', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const org = await tenancy.createOrganization('PG 权限组织')
    const created = await tenancy.createMember(org.id, 'pg-owner@example.com', 'PG 所有者', 'owner')
    const project = await tenancy.createProject({ organizationId: org.id, name: 'PG 权限项目' })

    const { id, key } = await tenancy.createMemberKey(created.id, 'pg-key')
    const found = await tenancy.findMemberByKey(key)
    expect(found?.id).toBe(created.id)
    expect(found?.role).toBe('owner')

    // 只存哈希；复合主键的 ON CONFLICT 在 PG 上也要能改角色
    const rows = await db.all<{ key_hash: string }>('SELECT key_hash FROM member_keys')
    expect(rows).toHaveLength(1)
    expect(rows[0].key_hash).not.toContain(key)

    await tenancy.setProjectMember(project.project.id, created.id, 'editor')
    await tenancy.setProjectMember(project.project.id, created.id, 'owner')
    const roles = await tenancy.listProjectMembers(project.project.id)
    expect(roles).toEqual([
      {
        member_id: created.id,
        email: 'pg-owner@example.com',
        name: 'PG 所有者',
        role: 'owner'
      }
    ])

    await tenancy.revokeMemberKey(created.id, id)
    expect(await tenancy.findMemberByKey(key)).toBeUndefined()
    await pg.close()
  })

  it('迁移 v8 的用量回填在 PG 方言下能累加（INSERT…SELECT…ON CONFLICT）', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const org = await tenancy.createOrganization('PG 回填组织')
    const created = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 回填应用'
    })
    const projectId = created.project.id

    await db.run('UPDATE project_usage SET events_total = 7 WHERE project_id = ?', [projectId])
    await db.run(
      `INSERT INTO transactions (project_id, name, duration_ms, started_at, received_at)
       VALUES (?, 'pg-tx', 100, ?, ?)`,
      [projectId, 1_700_000_000_000, 1_700_000_000_000]
    )
    await db.run(
      `INSERT INTO behavior_events (project_id, session_id, type, name, timestamp)
       VALUES (?, 'pg-sess', 'pageview', '/pg', ?)`,
      [projectId, 1_700_000_000_000]
    )
    await db.run('DELETE FROM schema_migrations WHERE version = 8')

    const applied = await runMigrations(db, 'postgres', MIGRATIONS)
    expect(applied).toContain(8)

    const row = await db.get<{ events_total: number }>(
      'SELECT events_total FROM project_usage WHERE project_id = ?',
      [projectId]
    )
    expect(Number(row?.events_total)).toBe(9)
    await pg.close()
  })

  it('PG 方言能建出全部表', async () => {
    const { pg, db } = await createPgDb()
    const tables = await db.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    )
    await pg.close()

    expect(tables.length).toBeGreaterThanOrEqual(26)
    expect(tables.map((t) => t.table_name)).toContain('issues')
    expect(tables.map((t) => t.table_name)).toContain('replay_events')
  })

  it('租户域在 PG 上能建组织、项目、环境、版本', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)

    const org = await tenancy.createOrganization('PG 组织')
    const project = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用',
      slug: 'pg-app'
    })
    const env = await tenancy.createEnvironment(project.project.id, 'production', '生产环境', true)
    const release = await tenancy.createRelease(project.project.id, '1.0.0')

    expect(org.id).toBeGreaterThan(0)
    expect(project.project.id).toBeGreaterThan(0)
    expect(project.runtimeKey).toMatch(/^vsk_/)
    expect(env.id).toBeGreaterThan(0)
    expect(release.id).toBeGreaterThan(0)

    // 密钥是按哈希存的，明文查不出来
    const rows = await db.all<{ key_hash: string }>('SELECT key_hash FROM project_keys')
    expect(rows.length).toBe(2)
    expect(rows.some((r) => r.key_hash.includes(project.runtimeKey))).toBe(false)

    await pg.close()
  })

  it('错误摄入与聚合在 PG 上正常（RETURNING id + ON CONFLICT）', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const artifacts = new ArtifactService(db)
    const issues = new IssueService(db, artifacts.sourcemapResolver)

    const org = await tenancy.createOrganization('PG 组织')
    const project = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用',
      slug: 'pg-app'
    })

    for (let i = 0; i < 3; i++) {
      await issues.ingestEvent(
        project.project.id,
        makeEvent({ fingerprint: 'a'.repeat(16), userId: 'u-pg' })
      )
    }

    const listed = await issues.listIssues({ projectId: project.project.id })
    expect(listed.total).toBe(1)
    expect(listed.issues[0].count).toBe(3)
    expect(listed.issues[0].user_count).toBe(1)

    const stats = await issues.stats(project.project.id)
    expect(stats.total).toBe(1)
    expect(stats.occurrences).toBe(3)

    await pg.close()
  })

  it('Issue 状态机在 PG 上走完整生命周期', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const artifacts = new ArtifactService(db)
    const issues = new IssueService(db, artifacts.sourcemapResolver)

    const org = await tenancy.createOrganization('PG 组织')
    const project = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用',
      slug: 'pg-app'
    })

    const outcome = await issues.ingestEvent(
      project.project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), release: '1.0.0' })
    )
    expect(outcome.status).toBe('unresolved')

    await issues.resolve(project.project.id, outcome.issueId, { release: '1.0.0' })
    const resolved = await issues.getIssue(project.project.id, outcome.issueId)
    expect(resolved.status).toBe('resolved')

    // 在新版本再次出现 → 回归
    await issues.ingestEvent(
      project.project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), release: '1.0.1' })
    )
    const regressed = await issues.getIssue(project.project.id, outcome.issueId)
    expect(regressed.status).toBe('unresolved')
    expect(regressed.substatus).toBe('regressed')

    await pg.close()
  })

  it('性能事务与分位数在 PG 上正常', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const performance = new PerformanceService(db)

    const org = await tenancy.createOrganization('PG 组织')
    const project = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用',
      slug: 'pg-app'
    })

    for (let i = 0; i < 5; i++) {
      await performance.ingestTransaction(
        project.project.id,
        makeTransaction({
          startedAt: Date.now() - i * 1000,
          vitals: {
            lcp: 1000 + i * 100,
            fcp: 800,
            cls: 0.02,
            inp: 100,
            ttfb: 50,
            tbt: 20,
            longTaskCount: 0
          }
        })
      )
    }

    const summary = await performance.summary({ projectId: project.project.id })
    expect(summary.transactions).toBe(5)
    expect(summary.vitals.lcp.count).toBe(5)
    expect(summary.vitals.lcp.p95).toBeGreaterThan(0)

    await pg.close()
  })

  it('回放与行为在 PG 上正常', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const replay = new ReplayService(db)

    const org = await tenancy.createOrganization('PG 组织')
    const project = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用',
      slug: 'pg-app'
    })

    await replay.ingestBehavior(project.project.id, {
      appId: 'pg-app',
      sdk: { name: '@vigil/sdk', version: '0.1.0' },
      events: [
        { type: 'pageview', name: '/', url: 'https://a.com/', timestamp: Date.now() },
        { type: 'click', name: 'button:去结算', url: 'https://a.com/', timestamp: Date.now() }
      ],
      session: {
        sessionId: 's-pg',
        startedAt: Date.now() - 1000,
        endedAt: Date.now(),
        durationMs: 1000,
        pageViews: 1
      }
    })

    // 回放先到、行为后到 —— 会话行必须存在
    await replay.saveReplay(project.project.id, 's-pg', {
      events: [
        {
          type: 4,
          timestamp: Date.now(),
          data: { href: 'https://a.com/', width: 1280, height: 800 }
        },
        { type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [] } } }
      ],
      bytes: 128
    })

    const sessions = await replay.listSessions(project.project.id)
    expect(sessions.total).toBe(1)
    expect(sessions.sessions[0].hasReplay).toBe(true)

    const summary = await replay.summary(project.project.id)
    expect(summary.pageViews).toBe(1)
    expect(summary.clicks.length).toBe(1)

    await pg.close()
  })

  it('错误趋势在 PG 上按天分桶（时区偏移生效）', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const artifacts = new ArtifactService(db)
    const issues = new IssueService(db, artifacts.sourcemapResolver)
    const trend = new TrendService(db)

    const org = await tenancy.createOrganization('PG 组织')
    const project = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用',
      slug: 'pg-app'
    })

    // 窗口必须对齐**本地午夜**（东八区）——
    // 用 UTC 午夜当窗口起点，事件会落在窗口外。
    const tzOffset = 480
    const offsetMs = tzOffset * 60_000
    const localMidnight = Math.floor((Date.now() + offsetMs) / 86_400_000) * 86_400_000 - offsetMs

    await issues.ingestEvent(
      project.project.id,
      makeEvent({ fingerprint: 'c'.repeat(16), occurredAt: localMidnight + 3_600_000 })
    )

    const result = await trend.errorTrend(project.project.id, {
      since: localMidnight,
      until: localMidnight + 86_400_000,
      bucket: 'day',
      tzOffsetMinutes: tzOffset
    })

    expect(result.bucket).toBe('day')
    expect(result.points.length).toBeGreaterThan(0)
    expect(result.points[result.points.length - 1].occurrences).toBe(1)
    // 桶起点就是本地午夜
    expect(result.points[result.points.length - 1].timestamp).toBe(localMidnight)

    await pg.close()
  })

  it('占位符翻译对字符串里的问号无感', async () => {
    const { pg, db } = await createPgDb()

    // SQL 字面量里的 `?` 不能被当成占位符
    const rows = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM (SELECT 'a?b' AS x) WHERE x = ?",
      ['a?b']
    )

    expect(rows[0]?.n).toBe(1)
    await pg.close()
  })

  it('批量多行 VALUES 在 PG 上能一次写入多个 span 与行为事件', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)
    const performance = new PerformanceService(db)
    const replay = new ReplayService(db)
    const org = await tenancy.createOrganization('PG 批量组织')
    const project = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 批量应用',
      slug: 'pg-batch'
    })

    // 8 个 span = 80 个占位符，专门压一下 `?` → `$1..$80` 的翻译
    const tx = await performance.ingestTransaction(
      project.project.id,
      makeTransaction({
        spans: Array.from({ length: 8 }, (_, i) => ({
          name: `span-${i}`,
          type: 'custom',
          durationMs: 10 + i
        }))
      })
    )
    expect(tx.spans).toBe(8)
    const spanRows = await db.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM spans WHERE transaction_id = ?',
      [tx.transactionId]
    )
    expect(Number(spanRows[0]?.n)).toBe(8)

    // 20 条行为事件 = 180 个占位符，跨方言的多行 VALUES
    const events = Array.from({ length: 20 }, (_, i) => ({
      sessionId: 's-pg-batch',
      type: 'pageview',
      name: `/page-${i}`,
      url: `https://a.com/page-${i}`,
      timestamp: 1_700_000_000_000 + i
    }))
    const result = await replay.ingestBehavior(project.project.id, {
      appId: 'pg-batch',
      sdk: { name: '@vigil/sdk', version: '0.1.0' },
      events
    } as never)
    expect(result.accepted).toBe(20)
    const behaviorRows = await db.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM behavior_events WHERE project_id = ?',
      [project.project.id]
    )
    expect(Number(behaviorRows[0]?.n)).toBe(20)

    await pg.close()
  })
})

/**
 * PG 部署的初始化路径。
 *
 * CLI 以前只会 openDb(SQLite)，在容器里建出一个谁都不读的空库。
 * 这组测试保证 TenancyService 在**真 PG** 上也能建组织 / 项目 /
 * 密钥 / 用量行 —— 也就是 REST 管理接口背后实际走的那条链路。
 */
describe('PostgreSQL 上的租户初始化', () => {
  it('能建组织、项目，密钥只存哈希且用量行自动建好', async () => {
    const { pg, db } = await createPgDb()
    const tenancy = new TenancyService(db)

    const org = await tenancy.createOrganization('PG 组织')
    expect(org.id).toBeGreaterThan(0)

    const created = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用',
      retentionDays: 30,
      eventQuota: 5000
    })
    expect(created.project.id).toBeGreaterThan(0)
    expect(created.runtimeKey).toMatch(/^vsk_/)
    expect(created.uploadKey).toMatch(/^vup_/)

    // 两把密钥都不能以明文落在库里
    const keys = await db.all<{ kind: string; key_hash: string }>(
      'SELECT kind, key_hash FROM project_keys WHERE project_id = ? ORDER BY kind',
      [created.project.id]
    )
    expect(keys).toHaveLength(2)
    expect(keys.map((k) => k.kind)).toEqual(['runtime', 'upload'])
    for (const key of keys) {
      expect(key.key_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(key.key_hash).not.toContain(created.runtimeKey)
      expect(key.key_hash).not.toContain(created.uploadKey)
    }

    // 计数器从 0 起步：老库回填是迁移 v3 的事，新项目必须由 createProject 建行
    const usage = await db.get<{ events_total: number }>(
      'SELECT events_total FROM project_usage WHERE project_id = ?',
      [created.project.id]
    )
    expect(Number(usage?.events_total)).toBe(0)

    const projects = await tenancy.listProjects(org.id)
    expect(projects.some((p) => p.id === created.project.id)).toBe(true)

    await pg.close()
  })
})
