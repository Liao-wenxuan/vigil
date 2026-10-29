import { describe, expect, it } from 'vitest'
import { makeEvent, makeTransaction, setupDb } from './helpers.js'
import { TrendService } from '../src/domains/trend/service.js'

/**
 * 时间维度的测试。
 *
 * 这里守的是监控面板的基本能力：
 * **「过去 24 小时有没有新问题」和「历史上共有多少问题」是两个问题。**
 *
 * 没有时间窗的时候，看的是 issues 表的全量快照（问题表本身就是累计的）；
 * 给了时间窗，看的是窗口内**实际发生过**的问题。
 */

const HOUR = 3600_000
const DAY = 24 * HOUR

describe('问题域的时间窗口', () => {
  it('没有时间窗时统计全量', async () => {
    const { issues, project } = await setupDb()
    const now = Date.now()

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: now - 5 * DAY })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now })
    )

    const stats = await issues.stats(project.id)
    expect(stats.total).toBe(2)
    expect(stats.occurrences).toBe(2)
    expect(stats.users).toBeUndefined()
  })

  it('有时间窗时只统计窗口内发生的问题', async () => {
    const { issues, project } = await setupDb()
    const now = Date.now()

    // 5 天前的旧问题
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: now - 5 * DAY })
    )
    // 1 小时前的新问题，发生两次
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now - HOUR })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now - HOUR + 1000 })
    )

    const stats = await issues.stats(project.id, { since: now - 2 * HOUR })

    expect(stats.total).toBe(1)
    expect(stats.occurrences).toBe(2)
    expect(stats.newIssues).toBe(1)
    expect(stats.since).toBe(now - 2 * HOUR)
  })

  it('窗口统计的用户数是窗口内去重的', async () => {
    const { issues, project } = await setupDb()
    const now = Date.now()

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), userId: 'u1', occurredAt: now - HOUR })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), userId: 'u2', occurredAt: now - HOUR })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), userId: 'u1', occurredAt: now - 5 * DAY })
    )

    const stats = await issues.stats(project.id, { since: now - 2 * HOUR })
    expect(stats.users).toBe(2)
  })

  it('问题列表在时间窗内只列有发生的问题，并给出窗口内次数', async () => {
    const { issues, project } = await setupDb()
    const now = Date.now()

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: now - 5 * DAY })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now - HOUR })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now - HOUR + 1000 })
    )

    const all = await issues.listIssues({ projectId: project.id })
    expect(all.total).toBe(2)

    const scoped = await issues.listIssues({ projectId: project.id, since: now - 2 * HOUR })
    expect(scoped.total).toBe(1)
    expect(scoped.issues[0].window_count).toBe(2)
    // 累计次数仍然是 2 —— 两个口径不能混
    expect(scoped.issues[0].count).toBe(2)
  })

  it('没有时间窗时 window_count 是 undefined（不假装有窗口）', async () => {
    const { issues, project } = await setupDb()
    await issues.ingestEvent(project.id, makeEvent({ fingerprint: 'a'.repeat(16) }))

    const all = await issues.listIssues({ projectId: project.id })
    expect(all.issues[0].window_count).toBeUndefined()
  })

  it('按次数排序时，有窗口就按窗口内的次数排', async () => {
    const { issues, project } = await setupDb()
    const now = Date.now()

    // 累计多、窗口内少
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: now - 5 * DAY })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: now - 6 * DAY })
    )
    // 累计少、窗口内多
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now - HOUR })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now - HOUR + 1000 })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'b'.repeat(16), occurredAt: now - HOUR + 2000 })
    )

    const scoped = await issues.listIssues({
      projectId: project.id,
      since: now - 2 * HOUR,
      sort: 'count'
    })

    // 窗口内 b 发生 3 次、a 发生 0 次（a 只是被窗口过滤掉了）
    expect(scoped.total).toBe(1)
    expect(scoped.issues[0].fingerprint).toBe('b'.repeat(16))
  })
})

describe('错误趋势', () => {
  it('按天分桶，空桶补 0', async () => {
    const { db, issues, project } = await setupDb()
    const trend = new TrendService(db)
    const now = Date.now()
    const dayStart = Math.floor(now / DAY) * DAY

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: dayStart + 3600_000 })
    )

    const result = await trend.errorTrend(project.id, {
      since: dayStart - 2 * DAY,
      until: dayStart + DAY
    })

    expect(result.bucket).toBe('day')
    // 起点落在窗口内的桶：前天、昨天、今天（右端那根不属于窗口）
    expect(result.points).toHaveLength(3)
    // 没有数据的那天必须是 0，不能「不存在」
    expect(result.points[0].occurrences).toBe(0)
    expect(result.points[1].occurrences).toBe(0)
    expect(result.points[2].occurrences).toBe(1)
  })

  it('错误率用页面访问数做分母', async () => {
    const { db, issues, performance, project } = await setupDb()
    const trend = new TrendService(db)
    const now = Date.now()
    const dayStart = Math.floor(now / DAY) * DAY

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: dayStart + 3600_000 })
    )
    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: dayStart + 3700_000 })
    )
    for (let i = 0; i < 8; i++) {
      await performance.ingestTransaction(
        project.id,
        makeTransaction({ startedAt: dayStart + 3600_000 + i * 100 })
      )
    }

    const result = await trend.errorTrend(project.id, {
      since: dayStart,
      until: dayStart + DAY
    })

    const today = result.points[result.points.length - 1]
    expect(today.occurrences).toBe(2)
    expect(today.transactions).toBe(8)
    expect(today.errorRate).toBeCloseTo(0.25, 5)
  })

  it('没有页面访问时错误率是 null，不是 0', async () => {
    const { db, issues, project } = await setupDb()
    const trend = new TrendService(db)
    const now = Date.now()
    const dayStart = Math.floor(now / DAY) * DAY

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: dayStart + 3600_000 })
    )

    const result = await trend.errorTrend(project.id, { since: dayStart, until: dayStart + DAY })
    const today = result.points[result.points.length - 1]

    expect(today.occurrences).toBe(1)
    expect(today.transactions).toBe(0)
    // 「没访问过」和「真的没错」不是一回事
    expect(today.errorRate).toBeNull()
  })

  it('按小时分桶', async () => {
    const { db, issues, project } = await setupDb()
    const trend = new TrendService(db)
    const now = Date.now()
    const hourStart = Math.floor(now / HOUR) * HOUR

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: hourStart })
    )

    const result = await trend.errorTrend(project.id, {
      bucket: 'hour',
      since: hourStart - 2 * HOUR,
      until: hourStart + HOUR
    })

    expect(result.bucket).toBe('hour')
    expect(result.points).toHaveLength(3)
    expect(result.points[2].occurrences).toBe(1)
  })

  it('时区偏移把「天」的边界对齐到本地午夜', async () => {
    const { db, issues, project } = await setupDb()
    const trend = new TrendService(db)
    const now = Date.now()

    // 东八区（+480）：本地 00:30 对应 UTC 前一天 16:30
    const tzOffset = 480
    const localMidnight = Math.floor((now + tzOffset * 60_000) / DAY) * DAY - tzOffset * 60_000

    await issues.ingestEvent(
      project.id,
      makeEvent({ fingerprint: 'a'.repeat(16), occurredAt: localMidnight + 30 * 60_000 })
    )

    const result = await trend.errorTrend(project.id, {
      since: localMidnight,
      until: localMidnight + DAY,
      tzOffsetMinutes: tzOffset
    })

    // 桶起点就是本地午夜
    expect(result.points[0].timestamp).toBe(localMidnight)
    expect(result.points[0].occurrences).toBe(1)
  })
})
