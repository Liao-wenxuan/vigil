import { describe, expect, it } from 'vitest'
import { computePriority } from '../src/domains/issues/service.js'
import { fp, makeEvent, setupDb } from './helpers.js'

describe('Issue 服务', () => {
  describe('摄入与聚合', () => {
    it('同一指纹聚合成一条，count 累加', async () => {
      const { issues, project } = await setupDb()
      // 三次**独立的**发生：时间戳必须不同。
      // 完全相同的事件会被服务端按 event_id 去重（那是网络重试的防护）
      const base = Date.now()

      for (let i = 0; i < 3; i++) {
        await issues.ingestEvent(
          project.id,
          makeEvent({ fingerprint: fp('one'), occurredAt: base + i * 1000 })
        )
      }

      const result = await issues.listIssues({ projectId: project.id })
      expect(result.total).toBe(1)
      expect(result.issues[0].count).toBe(3)
    })

    it('不同指纹分成不同 Issue', async () => {
      const { issues, project } = await setupDb()

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('a') }))
      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('b') }))
      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('a') }))

      const result = await issues.listIssues({ projectId: project.id })
      expect(result.total).toBe(2)
    })

    it('重复上报同一事件不会被重复计数（靠 event_id 去重）', async () => {
      const { issues, project } = await setupDb()
      const event = makeEvent({ fingerprint: fp('dup'), eventId: 'event-001' })

      await issues.ingestEvent(project.id, event)
      await issues.ingestEvent(project.id, event)

      const result = await issues.listIssues({ projectId: project.id })
      expect(result.issues[0].count).toBe(1)
    })

    it('受影响用户数按人去重', async () => {
      const { issues, project } = await setupDb()
      const base = Date.now()

      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('users'), userId: 'u_1', occurredAt: base })
      )
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('users'), userId: 'u_1', occurredAt: base + 1000 })
      )
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('users'), userId: 'u_2', occurredAt: base + 2000 })
      )

      const result = await issues.listIssues({ projectId: project.id })
      expect(result.issues[0].count).toBe(3)
      expect(result.issues[0].user_count).toBe(2)
    })

    it('多应用隔离：A 的事件不会进 B', async () => {
      const { issues, tenancy, project, organization } = await setupDb()
      const other = await tenancy.createProject({
        organizationId: organization.id,
        name: '另一个应用'
      })

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('shared') }))
      await issues.ingestEvent(other.project.id, makeEvent({ fingerprint: fp('shared') }))

      expect((await issues.listIssues({ projectId: project.id })).total).toBe(1)
      expect((await issues.listIssues({ projectId: other.project.id })).total).toBe(1)
    })
  })

  describe('生命周期', () => {
    it('标记已解决后状态变为 resolved', async () => {
      const { issues, project } = await setupDb()
      const outcome = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('r') }))

      const resolved = await issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      expect(resolved.status).toBe('resolved')
      expect(resolved.resolvedInRelease).toBe('1.4.3')
    })

    it('在更新版本重新出现 → 判为回归', async () => {
      const { issues, project } = await setupDb()
      const outcome = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('reg') }))

      await issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('reg'), release: '1.4.4' }))

      const detail = await issues.getIssue(project.id, outcome.issueId)
      expect(detail.status).toBe('unresolved')
      expect(detail.substatus).toBe('regressed')
    })

    it('在同版本重新出现 → 保持 resolved（是噪音）', async () => {
      const { issues, project } = await setupDb()
      const outcome = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('noise') }))

      await issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('noise'), release: '1.4.3' })
      )

      const detail = await issues.getIssue(project.id, outcome.issueId)
      expect(detail.status).toBe('resolved')
    })

    it('活动流记录每一次状态变化', async () => {
      const { issues, project } = await setupDb()
      const outcome = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('act') }))

      await issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      await issues.archive(project.id, outcome.issueId, { strategy: 'forever' })

      const detail = await issues.getIssue(project.id, outcome.issueId)
      const actions = detail.activity?.map((a) => a.action) ?? []
      expect(actions).toContain('created')
      expect(actions).toContain('resolved')
      expect(actions).toContain('archived')
    })

    it('人工操作会把操作人记进活动流', async () => {
      // ⚠️ 这条曾经**静默失效**：`writeActivity` 用 `db.run()` 写入（返回 void），
      // 调用方拿到的 id 是 undefined，UPDATE 匹配不到任何行 ——
      // 「谁做的」永远记不上，而类型检查发现不了（参数是 `unknown[]`）。
      const { issues, tenancy, project, organization } = await setupDb()
      const member = await tenancy.createMember(organization.id, 'w@example.com', '王五')
      const outcome = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('who') }))

      await issues.resolve(project.id, outcome.issueId, {
        release: '1.4.3',
        actorId: member.id,
        reason: '手动解决'
      })

      const detail = await issues.getIssue(project.id, outcome.issueId)
      const resolved = detail.activity?.find((a) => a.action === 'resolved')
      expect(resolved?.actorId).toBe(member.id)
      // 原因由状态机生成（`在 <版本> 解决`），不是调用方传的那句
      expect(resolved?.reason).toContain('解决')
    })

    it('评论会进详情', async () => {
      const { issues, tenancy, project, organization } = await setupDb()
      const member = await tenancy.createMember(organization.id, 'c@example.com', '李四')
      const outcome = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('c') }))

      const detail = await issues.comment(
        project.id,
        outcome.issueId,
        member.id,
        '已经定位到是空指针'
      )
      expect(detail.comments).toHaveLength(1)
      expect(detail.comments?.[0].body).toBe('已经定位到是空指针')
    })

    it('分配负责人', async () => {
      const { issues, tenancy, project, organization } = await setupDb()
      const member = await tenancy.createMember(organization.id, 'a@example.com', '张三')
      const outcome = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('assign') }))

      const detail = await issues.assign(project.id, outcome.issueId, member.id)
      expect(detail.assigneeId).toBe(member.id)
      expect(detail.assigneeName).toBe('张三')
    })

    it('批量归档', async () => {
      const { issues, project } = await setupDb()
      const a = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('ba') }))
      const b = await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('bb') }))

      const affected = await issues.bulkAction(project.id, {
        issueIds: [a.issueId, b.issueId],
        action: 'archive',
        archiveStrategy: 'forever'
      })

      expect(affected).toBe(2)
      expect((await issues.getIssue(project.id, a.issueId)).status).toBe('archived')
      expect((await issues.getIssue(project.id, b.issueId)).status).toBe('archived')
    })
  })

  describe('查询', () => {
    it('按分类过滤', async () => {
      const { issues, project } = await setupDb()
      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('js') }))
      await issues.ingestEvent(
        project.id,
        makeEvent({
          fingerprint: fp('http'),
          category: 'http',
          http: { method: 'GET', url: '/api/x', status: 500 }
        })
      )

      const result = await issues.listIssues({ projectId: project.id, category: 'http' })
      expect(result.total).toBe(1)
    })

    it('关键词能搜到消息', async () => {
      const { issues, project } = await setupDb()
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('search'), message: 'Payment gateway timeout' })
      )

      const result = await issues.listIssues({ projectId: project.id, query: 'gateway' })
      expect(result.total).toBe(1)
    })

    it('统计汇总正确', async () => {
      const { issues, project } = await setupDb()
      const base = Date.now()

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('stat'), occurredAt: base }))
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('stat'), occurredAt: base + 1000 })
      )

      const stats = await issues.stats(project.id)
      expect(stats.total).toBe(1)
      expect(stats.occurrences).toBe(2)
      expect(stats.unresolved).toBe(1)
      expect(stats.new).toBe(1)
    })
  })
})

/**
 * 列表分页与排序。
 *
 * 这一组守的是「面板在数据量大时还能用」：
 * 过滤、排序、分页必须在 SQL 里完成，只回传当前页。
 */
describe('列表分页与排序', () => {
  /** 造 n 个互不相同的问题，发生次数依次为 i % 4 + 1 */
  async function seed(
    n: number
  ): Promise<{ issues: Awaited<ReturnType<typeof setupDb>>['issues']; projectId: number }> {
    const ctx = await setupDb()
    const base = Date.now() - 3600_000

    for (let i = 0; i < n; i++) {
      const occurrences = (i % 4) + 1
      for (let k = 0; k < occurrences; k++) {
        await ctx.issues.ingestEvent(
          ctx.project.id,
          makeEvent({ fingerprint: fp(`page-${i}`), occurredAt: base + i * 1000 + k })
        )
      }
    }

    return { issues: ctx.issues, projectId: ctx.project.id }
  }

  it('limit/offset 只取当前页，三页拼起来不重不漏', async () => {
    const { issues, projectId } = await seed(25)

    const page1 = await issues.listIssues({ projectId, limit: 10, offset: 0, sort: 'last_seen' })
    const page2 = await issues.listIssues({ projectId, limit: 10, offset: 10, sort: 'last_seen' })
    const page3 = await issues.listIssues({ projectId, limit: 10, offset: 20, sort: 'last_seen' })

    expect(page1.total).toBe(25)
    expect(page1.issues).toHaveLength(10)
    expect(page3.issues).toHaveLength(5)

    const ids = [...page1.issues, ...page2.issues, ...page3.issues].map((row) => row.id)
    expect(ids).toHaveLength(25)
    expect(new Set(ids).size).toBe(25)
  })

  it('优先级并列时靠 id 兜底，翻页仍然稳定', async () => {
    const { issues, projectId } = await seed(12)

    // 全部同样次数、同样时近性 → 优先级分数大量并列
    const first = await issues.listIssues({ projectId, limit: 5, offset: 0, sort: 'priority' })
    const second = await issues.listIssues({ projectId, limit: 5, offset: 5, sort: 'priority' })

    const overlap = first.issues.filter((a) => second.issues.some((b) => b.id === a.id))
    expect(overlap).toHaveLength(0)
  })

  it('limit 有上限，一次请求拉不走全表', async () => {
    const { issues, projectId } = await seed(8)

    const result = await issues.listIssues({ projectId, limit: 100_000 })
    expect(result.issues.length).toBeLessThanOrEqual(200)
    expect(result.total).toBe(8)
  })

  it('priority 排序结果与 computePriority 的 JS 实现一致', async () => {
    const ctx = await setupDb()
    const now = Date.now()

    // 刻意让四个维度各不相同：量级、用户数、时近性、状态
    const cases: Array<{ label: string; times: number; ageMs: number; users: number }> = [
      { label: 'loud-old', times: 30, ageMs: 30 * 24 * 3600_000, users: 1 },
      { label: 'few-recent', times: 2, ageMs: 60_000, users: 2 },
      { label: 'many-users', times: 5, ageMs: 3600_000, users: 9 },
      { label: 'single-new', times: 1, ageMs: 10_000, users: 0 }
    ]

    for (const item of cases) {
      for (let k = 0; k < item.times; k++) {
        await ctx.issues.ingestEvent(
          ctx.project.id,
          makeEvent({
            fingerprint: fp(item.label),
            occurredAt: now - item.ageMs + k,
            userId: k < item.users ? `u-${item.label}-${k}` : undefined
          })
        )
      }
    }

    const viaSql = await ctx.issues.listIssues({
      projectId: ctx.project.id,
      sort: 'priority',
      limit: 50
    })

    const viaJs = [...viaSql.issues].sort(
      (a, b) => computePriority(b, Date.now()) - computePriority(a, Date.now())
    )

    expect(viaSql.issues.map((row) => row.id)).toEqual(viaJs.map((row) => row.id))
  })

  it('有窗口时窗口计数跟着分页走，累计次数不被改写', async () => {
    const ctx = await setupDb()
    const now = Date.now()

    // a：窗口内 1 次，历史上 3 次
    for (let k = 0; k < 3; k++) {
      await ctx.issues.ingestEvent(
        ctx.project.id,
        makeEvent({ fingerprint: fp('win-a'), occurredAt: now - 5 * 86400_000 + k })
      )
    }
    // b：窗口内 4 次，另有一次在 10 天前（累计 5 次）
    for (let k = 0; k < 4; k++) {
      await ctx.issues.ingestEvent(
        ctx.project.id,
        makeEvent({ fingerprint: fp('win-b'), occurredAt: now - 3600_000 + k })
      )
    }
    await ctx.issues.ingestEvent(
      ctx.project.id,
      makeEvent({ fingerprint: fp('win-b'), occurredAt: now - 10 * 86400_000 })
    )

    const page = await ctx.issues.listIssues({
      projectId: ctx.project.id,
      since: now - 2 * 3600_000,
      sort: 'count',
      limit: 1,
      offset: 0
    })

    expect(page.total).toBe(1)
    expect(page.issues[0].fingerprint).toBe(fp('win-b'))
    expect(page.issues[0].window_count).toBe(4)
    // 累计次数是另一个口径，不能被窗口计数覆盖
    expect(page.issues[0].count).toBe(5)
  })
})
