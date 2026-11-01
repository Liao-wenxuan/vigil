import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PostgresDb, type PgClient, type PgPool } from '../src/infra/db/postgres.js'
import { runMigrations, MIGRATIONS } from '../src/infra/db/migrate.js'
import { TenancyService } from '../src/domains/tenancy/service.js'
import { ArtifactService } from '../src/domains/artifacts/service.js'
import { IssueService } from '../src/domains/issues/service.js'
import { PerformanceService } from '../src/domains/performance/service.js'
import { ReplayService } from '../src/domains/replay/service.js'
import { UsageService } from '../src/domains/usage/service.js'
import { IngestionPipeline } from '../src/domains/ingestion/pipeline.js'
import { fp, makeEvent } from './helpers.js'

/**
 * SAVEPOINT 与批量事务在**真 PostgreSQL** 上的行为。
 *
 * PGlite 是 WASM 编译的 PG 本体 —— SAVEPOINT 是 PG 的语法，
 * 所以这里跑的是**真 PG 的解析器与执行器**，不是模拟。
 *
 * ## 为什么这组测试必须存在
 *
 * SAVEPOINT 之前只在 SQLite 和假连接池上验过。
 * 而 SAVEPOINT 的**全部价值**在于「PG 里一条语句失败会中止整个事务」，
 * 这一点只有真 PG 能证明 —— 假连接池只知道「发了什么 SQL」，
 * 不知道「那条 SQL 之后事务还活着吗」。
 */
class PGlitePool implements PgPool {
  readonly log: string[] = []

  constructor(private readonly pg: PGlite) {}

  async query(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    this.log.push(sql)
    // 多语句（DDL 迁移）必须走 `exec` ——
    // PG 的**预处理语句**不接受多条命令
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

async function createPg() {
  const pg = new PGlite()
  await pg.waitReady
  const pool = new PGlitePool(pg)
  const db = new PostgresDb(pool)
  await runMigrations(db, 'postgres', MIGRATIONS)
  return { pg, pool, db }
}

/** 一张用来验事务语义的小表 */
async function probeTable(db: PostgresDb): Promise<void> {
  await db.exec('CREATE TABLE sp_probe (id INTEGER PRIMARY KEY, note TEXT)')
}

describe('真 PG 上的保存点', () => {
  it('失败只回滚保存点里的，外层的写入还在', async () => {
    const { pg, db } = await createPg()
    await probeTable(db)

    await db.transaction(async () => {
      await db.run('INSERT INTO sp_probe (id, note) VALUES (?, ?)', [1, 'outer-before'])
      await expect(
        db.savepoint('sp_1', async () => {
          await db.run('INSERT INTO sp_probe (id, note) VALUES (?, ?)', [2, 'inside'])
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')
      await db.run('INSERT INTO sp_probe (id, note) VALUES (?, ?)', [3, 'outer-after'])
    })

    const rows = await db.all<{ id: number }>('SELECT id FROM sp_probe ORDER BY id')
    await pg.close()

    // 保存点里那条被回滚了，两条外层的都在
    expect(rows.map((r) => r.id)).toEqual([1, 3])
  })

  it('真 PG 的约束冲突之后，事务还能继续（这才是 SAVEPOINT 的意义）', async () => {
    const { pg, db } = await createPg()
    await probeTable(db)

    await db.transaction(async () => {
      await db.run('INSERT INTO sp_probe (id, note) VALUES (?, ?)', [1, 'first'])

      // 主键冲突 —— PG 会**中止整个事务**，
      // 后续语句全部报 "current transaction is aborted"
      await expect(
        db.savepoint('sp_2', async () => {
          await db.run('INSERT INTO sp_probe (id, note) VALUES (?, ?)', [1, 'duplicate'])
        })
      ).rejects.toThrow()

      // ⚠️ 这一句能成功，就说明 ROLLBACK TO SAVEPOINT 把事务救回来了。
      //    没有 SAVEPOINT 的话，这里会报 "current transaction is aborted"。
      await db.run('INSERT INTO sp_probe (id, note) VALUES (?, ?)', [2, 'after-conflict'])
    })

    const rows = await db.all<{ id: number; note: string }>(
      'SELECT id, note FROM sp_probe ORDER BY id'
    )
    await pg.close()

    expect(rows.map((r) => r.id)).toEqual([1, 2])
    expect(rows[1].note).toBe('after-conflict')
  })

  it('嵌套事务只发一次 BEGIN', async () => {
    const { pg, pool, db } = await createPg()

    // ⚠️ 先清日志 —— 建库时的迁移也发过事务
    pool.log.length = 0
    await db.transaction(async () => {
      await db.transaction(async () => {
        await db.run('SELECT 1')
      })
    })

    const begins = pool.log.filter((s) => s === 'BEGIN').length
    const commits = pool.log.filter((s) => s === 'COMMIT').length
    await pg.close()

    expect(begins).toBe(1)
    expect(commits).toBe(1)
  })
})

describe('真 PG 上的批量摄入', () => {
  it('一批事件走一个事务，条数与计数都对', async () => {
    const { pg, pool, db } = await createPg()
    const tenancy = new TenancyService(db)
    const artifacts = new ArtifactService(db)
    const issues = new IssueService(db, artifacts.sourcemapResolver)
    const pipeline = new IngestionPipeline(
      db,
      issues,
      new PerformanceService(db),
      artifacts,
      new ReplayService(db),
      new UsageService(db)
    )

    const org = await tenancy.createOrganization('PG 组织')
    const { project } = await tenancy.createProject({
      organizationId: org.id,
      name: 'PG 应用'
    })

    pool.log.length = 0
    const result = await pipeline.ingestErrors(
      project as never,
      {
        appId: 'pg',
        sdk: { name: 'vigil', version: '0.1.0' },
        events: [
          makeEvent({ fingerprint: fp('pg1') }),
          makeEvent({ fingerprint: fp('pg2') }),
          makeEvent({ fingerprint: fp('pg3') })
        ]
      } as never
    )

    const list = await issues.listIssues({ projectId: project.id })
    await pg.close()

    expect(result.accepted).toBe(3)
    expect(result.dropped).toBe(0)
    expect(list.total).toBe(3)
    // 整批一个事务 → 只发一次 BEGIN
    expect(pool.log.filter((s) => s === 'BEGIN').length).toBe(1)
    // 每条事件一个保存点
    expect(pool.log.filter((s) => s.startsWith('SAVEPOINT')).length).toBe(3)
  })
})
