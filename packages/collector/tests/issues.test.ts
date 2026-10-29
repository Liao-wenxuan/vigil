import { describe, expect, it } from 'vitest'
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
