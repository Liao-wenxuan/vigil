import { describe, expect, it } from 'vitest'
import { fp, makeEvent, makeTransaction, setupDb } from './helpers.js'
import { RetentionService } from '../src/domains/retention/service.js'

/**
 * 保留策略。
 *
 * 这里守的是**存储有界**这条硬指标：给了天数，超过天数的数据必须真的消失。
 * 之前 `retention_days` 只是个字段 —— 写进去没人读，表只增不减。
 */

const DAY = 24 * 3600_000

/** 数一张表里还剩几行 */
async function countRows(
  db: Awaited<ReturnType<typeof setupDb>>['db'],
  table: string,
  projectId: number
): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
    [projectId]
  )
  return Number(row?.n ?? 0)
}

/** 五个受管表各造一条指定时间的记录 */
async function seedAt(
  ctx: Awaited<ReturnType<typeof setupDb>>,
  at: number,
  label: string
): Promise<void> {
  const { issues, performance, replay, project } = ctx

  await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp(label), occurredAt: at }))
  await performance.ingestTransaction(project.id, makeTransaction({ startedAt: at }), {})
  await replay.ingestBehavior(project.id, {
    appId: project.slug,
    sdk: { name: '@vigil/sdk', version: '0.1.0' },
    events: [
      {
        type: 'pageview',
        name: '/page',
        url: 'https://example.com/page',
        timestamp: at
      }
    ],
    session: {
      sessionId: `sess-${label}`,
      startedAt: at,
      endedAt: at + 1000,
      durationMs: 1000,
      pageViews: 1
    }
  })
  await replay.saveReplay(
    project.id,
    `sess-${label}`,
    { events: [{ type: 4, timestamp: at, data: { href: '/page' } }], bytes: 16 },
    { userId: undefined }
  )
}

describe('保留策略', () => {
  it('超出界线的五类数据都被删，界内的一条不动', async () => {
    const ctx = await setupDb()
    const now = Date.now()
    const old = now - 100 * DAY
    const fresh = now - 1 * DAY

    await seedAt(ctx, old, 'old')
    await seedAt(ctx, fresh, 'fresh')

    const retention = new RetentionService(ctx.db, { now: () => now })
    const deleted = await retention.sweepProject(ctx.project.id, now - 30 * DAY)

    expect(deleted.issueEvents).toBe(1)
    expect(deleted.transactions).toBe(1)
    expect(deleted.behaviorEvents).toBe(1)
    expect(deleted.replayEvents).toBe(1)
    expect(deleted.sessions).toBe(1)

    // 界内的必须还在 —— 删多了比删少了严重得多
    expect(await countRows(ctx.db, 'issue_events', ctx.project.id)).toBe(1)
    expect(await countRows(ctx.db, 'transactions', ctx.project.id)).toBe(1)
    expect(await countRows(ctx.db, 'behavior_events', ctx.project.id)).toBe(1)
    expect(await countRows(ctx.db, 'replay_events', ctx.project.id)).toBe(1)
    expect(await countRows(ctx.db, 'replay_sessions', ctx.project.id)).toBe(1)
  })

  it('按项目自己的 retention_days 裁剪（不是全局一刀切）', async () => {
    const ctx = await setupDb()
    const now = Date.now()

    // 项目 A：保留 7 天
    await ctx.db.run('UPDATE projects SET retention_days = 7 WHERE id = ?', [ctx.project.id])
    await seedAt(ctx, now - 10 * DAY, 'ten-days')

    // 项目 B：保留 90 天
    const other = await ctx.tenancy.createProject({
      organizationId: ctx.organization.id,
      name: '长期项目',
      retentionDays: 90
    })
    await ctx.issues.ingestEvent(
      other.project.id,
      makeEvent({ fingerprint: fp('ten-days-b'), occurredAt: now - 10 * DAY })
    )

    const retention = new RetentionService(ctx.db, { now: () => now })
    const report = await retention.sweep()

    expect(report.projects).toBe(2)
    expect(await countRows(ctx.db, 'issue_events', ctx.project.id)).toBe(0)
    // 同样的 10 天前数据，在 90 天的项目里必须活着
    expect(await countRows(ctx.db, 'issue_events', other.project.id)).toBe(1)
  })

  it('retention_days = 0 表示永久保留，一条都不删', async () => {
    const ctx = await setupDb()
    const now = Date.now()

    const keep = await ctx.tenancy.createProject({
      organizationId: ctx.organization.id,
      name: '永久保留',
      retentionDays: 0
    })
    await ctx.issues.ingestEvent(
      keep.project.id,
      makeEvent({ fingerprint: fp('forever'), occurredAt: now - 1000 * DAY })
    )

    const retention = new RetentionService(ctx.db, { now: () => now })
    await retention.sweep()

    expect(await countRows(ctx.db, 'issue_events', keep.project.id)).toBe(1)
  })

  it('分批删：批大小 2、6 条过期数据也能清干净', async () => {
    const ctx = await setupDb()
    const now = Date.now()

    for (let i = 0; i < 6; i++) {
      await ctx.issues.ingestEvent(
        ctx.project.id,
        makeEvent({ fingerprint: fp(`batch-${i}`), occurredAt: now - 100 * DAY + i })
      )
    }

    const retention = new RetentionService(ctx.db, {
      batchSize: 2,
      maxBatches: 10,
      now: () => now
    })
    const deleted = await retention.sweepProject(ctx.project.id, now - 30 * DAY)

    expect(deleted.issueEvents).toBe(6)
    expect(await countRows(ctx.db, 'issue_events', ctx.project.id)).toBe(0)
  })

  it('重入保护：上一轮没跑完，下一轮直接跳过', async () => {
    const ctx = await setupDb()
    const now = Date.now()
    const retention = new RetentionService(ctx.db, { now: () => now })

    // 并发触发两次：第二次必须自己让开，而不是叠一轮并发删除
    const [first, second] = await Promise.all([retention.sweep(), retention.sweep()])

    expect([first.skipped, second.skipped].filter(Boolean)).toHaveLength(1)
  })
})
