import { describe, expect, it } from 'vitest'
import type { Db } from '../src/infra/db/types.js'
import { rawHandle } from '../src/infra/db/client.js'
import { IngestionPipeline } from '../src/domains/ingestion/pipeline.js'
import { UsageService } from '../src/domains/usage/service.js'
import { ArtifactService } from '../src/domains/artifacts/service.js'
import { IssueService } from '../src/domains/issues/service.js'
import { fp, makeEvent, setupDb } from './helpers.js'

/**
 * 一批事件的摄入：整批一个事务 + 每条事件一个 SAVEPOINT。
 *
 * ## 为什么要有 SAVEPOINT
 *
 * PG 里**一条语句失败会中止整个事务** ——
 * 不隔离的话，一批 20 条里第 5 条坏，另外 19 条好的一起丢。
 * 所以每条事件套一层 SAVEPOINT，失败只回滚那一条。
 */
describe('批量摄入', () => {
  /** 用同一个库建管道 —— 两个 setupDb 会拿到两个不同的内存库 */
  async function setup() {
    const base = await setupDb()
    const pipeline = new IngestionPipeline(
      base.db,
      base.issues,
      base.performance,
      base.artifacts,
      base.replay,
      new UsageService(base.db)
    )
    return { ...base, pipeline }
  }

  /** 造一个「写入 issue_events 时按条件抛错」的 Db */
  function failingDb(inner: Db, shouldFail: (sql: string, params: unknown[]) => boolean): Db {
    return {
      dialect: inner.dialect,
      exec: (sql) => inner.exec(sql),
      all: (sql, params) => inner.all(sql, params),
      get: (sql, params) => inner.get(sql, params),
      run: async (sql, params) => {
        const list = Array.isArray(params) ? params : []
        if (shouldFail(sql, list)) throw new Error('注入的写入失败')
        return inner.run(sql, params)
      },
      insert: (sql, params) => inner.insert(sql, params),
      transaction: (fn) => inner.transaction(fn),
      savepoint: (name, fn) => inner.savepoint(name, fn),
      close: () => inner.close()
    }
  }

  /**
   * 在注入后的库上重建整条链路 ——
   * ⚠️ 服务必须建在**同一个库**上，
   *    否则注入的故障根本走不到真正写数据的那一层。
   */
  function pipelineOn(db: Db, base: Awaited<ReturnType<typeof setup>>) {
    const artifacts = new ArtifactService(db)
    const issues = new IssueService(db, artifacts.sourcemapResolver)
    return new IngestionPipeline(
      db,
      issues,
      base.performance,
      artifacts,
      base.replay,
      new UsageService(db)
    )
  }

  const envelope = (events: ReturnType<typeof makeEvent>[]) =>
    ({
      appId: 'x',
      sdk: { name: 'vigil', version: '0.1.0' },
      events
    }) as never

  it('一批事件都进去', async () => {
    const { pipeline, project } = await setup()

    const result = await pipeline.ingestErrors(
      project as never,
      envelope([
        makeEvent({ fingerprint: fp('a') }),
        makeEvent({ fingerprint: fp('b') }),
        makeEvent({ fingerprint: fp('c') })
      ])
    )

    expect(result.accepted).toBe(3)
    expect(result.dropped).toBe(0)
  })

  it('一条坏事件不影响同批的其他事件', async () => {
    const base = await setup()
    const db = failingDb(
      base.db,
      (sql, params) =>
        sql.includes('INSERT INTO issue_events') && params.some((p) => String(p).includes('炸了'))
    )
    const pipeline = pipelineOn(db, base)

    const result = await pipeline.ingestErrors(
      project_of(base) as never,
      envelope([
        makeEvent({ fingerprint: fp('ok1') }),
        makeEvent({ fingerprint: fp('bad'), message: '炸了' }),
        makeEvent({ fingerprint: fp('ok2') })
      ])
    )

    expect(result.accepted).toBe(2)
    expect(result.dropped).toBe(1)

    // 两条好的必须真的落库了（坏的那条不能拖累它们）
    const list = await base.issues.listIssues({ projectId: base.project.id })
    expect(list.total).toBe(2)
    expect(list.issues.every((i) => i.count === 1)).toBe(true)
  })

  it('整批都失败 → 抛出去（系统性故障不能静默吞掉）', async () => {
    const base = await setup()
    const db = failingDb(base.db, (sql) => sql.includes('INSERT INTO issue_events'))
    const pipeline = pipelineOn(db, base)

    await expect(
      pipeline.ingestErrors(
        base.project as never,
        envelope([makeEvent({ fingerprint: fp('x') }), makeEvent({ fingerprint: fp('y') })])
      )
    ).rejects.toThrow('注入的写入失败')
  })

  it('整批只提交一次（不是每条一次）', async () => {
    const { pipeline, project, db } = await setup()

    // ⚠️ BEGIN / COMMIT 走的是**底层句柄**，不经过 `Db.exec` ——
    //    所以要拦 better-sqlite3 的 exec 才数得到。
    const raw = rawHandle(db)
    expect(raw).toBeDefined()
    const statements: string[] = []
    const originalExec = raw!.exec.bind(raw!)
    raw!.exec = (sql: string) => {
      statements.push(sql)
      return originalExec(sql)
    }

    await pipeline.ingestErrors(
      project as never,
      envelope([
        makeEvent({ fingerprint: fp('s1') }),
        makeEvent({ fingerprint: fp('s2') }),
        makeEvent({ fingerprint: fp('s3') }),
        makeEvent({ fingerprint: fp('s4') })
      ])
    )

    expect(statements.filter((s) => s === 'BEGIN')).toHaveLength(1)
    expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(1)
    // 每条事件一个保存点
    expect(statements.filter((s) => s.startsWith('SAVEPOINT'))).toHaveLength(4)
  })
})

/** 取项目行（管道要的是完整行，不是只有 id） */
function project_of(base: { project: { id: number } }): unknown {
  return base.project
}
