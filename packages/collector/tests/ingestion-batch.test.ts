import { describe, expect, it, vi } from 'vitest'
import { setupDb, makeTransaction, countingDb } from './helpers.js'
import { IngestionPipeline } from '../src/domains/ingestion/pipeline.js'
import { UsageService } from '../src/domains/usage/service.js'
import type { PerformanceEvent } from '@vigil/protocol'

/**
 * 摄入写入的批量化。
 *
 * 守的是「批量写既要快、又不能丢数据」：
 * 多行 VALUES 的参数个数有上限（SQLite 999），超过要分块；
 * 整批一个事务后，单条失败必须靠 SAVEPOINT 隔离，
 * 不能把同批其余的好数据一起回滚掉。
 */

function pipelineFor(ctx: Awaited<ReturnType<typeof setupDb>>): IngestionPipeline {
  return new IngestionPipeline(
    ctx.db,
    ctx.issues,
    ctx.performance,
    ctx.artifacts,
    ctx.replay,
    new UsageService(ctx.db)
  )
}

const envelope = (transactions: unknown[]) =>
  ({ appId: 'app', sdk: { name: 'vigil', version: '0.1.0' }, transactions }) as never

describe('摄入批量写入', () => {
  it('一条事务的多个 span 用多行 VALUES 一次写完，一条不丢', async () => {
    const ctx = await setupDb()
    const spans = Array.from({ length: 8 }, (_, i) => ({
      name: `span-${i}`,
      type: 'custom' as const,
      durationMs: i * 10
    }))

    const result = await ctx.performance.ingestTransaction(
      ctx.project.id,
      makeTransaction({ spans })
    )

    expect(result.spans).toBe(8)
    const rows = await ctx.db.all<{ name: string }>(
      'SELECT name FROM spans WHERE transaction_id = ? ORDER BY name',
      [result.transactionId]
    )
    expect(rows.map((r) => r.name)).toEqual(spans.map((s) => s.name))
  })

  it('span 超过单批参数上限时自动分块，仍然全部落库', async () => {
    const ctx = await setupDb()
    const spans = Array.from({ length: 95 }, (_, i) => ({
      name: `span-${String(i).padStart(3, '0')}`,
      type: 'custom' as const,
      durationMs: 1
    }))

    const result = await ctx.performance.ingestTransaction(
      ctx.project.id,
      makeTransaction({ spans })
    )

    expect(result.spans).toBe(95)
    const count = await ctx.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM spans WHERE transaction_id = ?',
      [result.transactionId]
    )
    expect(Number(count?.n)).toBe(95)
  })

  it('一批行为事件跨分块边界也能整批落库', async () => {
    const ctx = await setupDb()
    const events = Array.from({ length: 120 }, (_, i) => ({
      sessionId: 'sess-batch',
      type: 'pageview',
      name: `/page-${i}`,
      url: `/page-${i}`,
      timestamp: 1_700_000_000_000 + i
    }))

    const result = await ctx.replay.ingestBehavior(ctx.project.id, {
      appId: 'app',
      sdk: { name: 'vigil', version: '0.1.0' },
      events
    } as never)

    expect(result.accepted).toBe(120)
    const count = await ctx.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM behavior_events WHERE project_id = ?',
      [ctx.project.id]
    )
    expect(Number(count?.n)).toBe(120)
  })

  it('一批里混了不同环境/版本，各条按自身维度解析（不再共用第一条）', async () => {
    const ctx = await setupDb()
    const pipeline = pipelineFor(ctx)
    const prod = await ctx.tenancy.createEnvironment(ctx.project.id, 'production', '生产', true)
    const staging = await ctx.tenancy.createEnvironment(ctx.project.id, 'staging', '预发', false)
    const r1 = await ctx.tenancy.createRelease(ctx.project.id, '1.0.0')
    const r2 = await ctx.tenancy.createRelease(ctx.project.id, '2.0.0')

    const result = await pipeline.ingestPerformance(
      ctx.project as never,
      envelope([
        makeTransaction({ environment: 'production', release: '1.0.0', startedAt: 1 }),
        makeTransaction({ environment: 'staging', release: '2.0.0', startedAt: 2 })
      ])
    )

    expect(result.accepted).toBe(2)
    const rows = await ctx.db.all<{ environment_id: number; release_id: number }>(
      'SELECT environment_id, release_id FROM transactions ORDER BY id'
    )
    expect(rows).toEqual([
      { environment_id: prod.id, release_id: r1.id },
      { environment_id: staging.id, release_id: r2.id }
    ])
  })

  it('重复的维度只查一次库，不会随条数线性增加查询', async () => {
    const ctx = await setupDb()
    const counter = { reads: 0 }
    const countedDb = countingDb(ctx.db, counter)
    const pipeline = new IngestionPipeline(
      countedDb,
      ctx.issues,
      ctx.performance,
      ctx.artifacts,
      ctx.replay,
      new UsageService(countedDb)
    )

    await pipeline.ingestPerformance(
      ctx.project as never,
      envelope(
        Array.from({ length: 20 }, (_, i) =>
          makeTransaction({ environment: 'production', release: '1.0.0', startedAt: i + 1 })
        )
      )
    )

    // 环境 1 次 + 版本 1 次 + 配额 1 次，不该是 20×2
    expect(counter.reads).toBeLessThanOrEqual(3)
  })

  it('一条坏事务只回滚自己，同批其余照常落库', async () => {
    const ctx = await setupDb()
    const pipeline = pipelineFor(ctx)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = null as unknown as PerformanceEvent

    const result = await pipeline.ingestPerformance(
      ctx.project as never,
      envelope([makeTransaction({ startedAt: 1 }), broken, makeTransaction({ startedAt: 3 })])
    )

    quiet.mockRestore()
    expect(result.accepted).toBe(2)
    expect(result.dropped).toBe(1)
    const count = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM transactions')
    expect(Number(count?.n)).toBe(2)
  })
})
