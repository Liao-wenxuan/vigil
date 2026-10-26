import { describe, expect, it } from 'vitest'
import { fp, makeEvent, setupDb } from './helpers.js'

describe('Issue 服务', () => {
  describe('摄入与聚合', () => {
    it('同一指纹聚合成一条，count 累加', () => {
      const { issues, project } = setupDb()
      // 三次**独立的**发生：时间戳必须不同。
      // 完全相同的事件会被服务端按 event_id 去重（那是网络重试的防护）
      const base = Date.now()

      for (let i = 0; i < 3; i++) {
        issues.ingestEvent(
          project.id,
          makeEvent({ fingerprint: fp('one'), occurredAt: base + i * 1000 })
        )
      }

      const result = issues.listIssues({ projectId: project.id })
      expect(result.total).toBe(1)
      expect(result.issues[0].count).toBe(3)
    })

    it('不同指纹分成不同 Issue', () => {
      const { issues, project } = setupDb()

      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('a') }))
      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('b') }))
      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('a') }))

      const result = issues.listIssues({ projectId: project.id })
      expect(result.total).toBe(2)
    })

    it('重复上报同一事件不会被重复计数（靠 event_id 去重）', () => {
      const { issues, project } = setupDb()
      const event = makeEvent({ fingerprint: fp('dup'), eventId: 'event-001' })

      issues.ingestEvent(project.id, event)
      issues.ingestEvent(project.id, event)

      const result = issues.listIssues({ projectId: project.id })
      expect(result.issues[0].count).toBe(1)
    })

    it('受影响用户数按人去重', () => {
      const { issues, project } = setupDb()
      const base = Date.now()

      issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('users'), userId: 'u_1', occurredAt: base })
      )
      issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('users'), userId: 'u_1', occurredAt: base + 1000 })
      )
      issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('users'), userId: 'u_2', occurredAt: base + 2000 })
      )

      const result = issues.listIssues({ projectId: project.id })
      expect(result.issues[0].count).toBe(3)
      expect(result.issues[0].user_count).toBe(2)
    })

    it('多应用隔离：A 的事件不会进 B', () => {
      const { issues, tenancy, project, organization } = setupDb()
      const other = tenancy.createProject({ organizationId: organization.id, name: '另一个应用' })

      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('shared') }))
      issues.ingestEvent(other.project.id, makeEvent({ fingerprint: fp('shared') }))

      expect(issues.listIssues({ projectId: project.id }).total).toBe(1)
      expect(issues.listIssues({ projectId: other.project.id }).total).toBe(1)
    })
  })

  describe('生命周期', () => {
    it('标记已解决后状态变为 resolved', () => {
      const { issues, project } = setupDb()
      const outcome = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('r') }))

      const resolved = issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      expect(resolved.status).toBe('resolved')
      expect(resolved.resolvedInRelease).toBe('1.4.3')
    })

    it('在更新版本重新出现 → 判为回归', () => {
      const { issues, project } = setupDb()
      const outcome = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('reg') }))

      issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('reg'), release: '1.4.4' }))

      const detail = issues.getIssue(project.id, outcome.issueId)
      expect(detail.status).toBe('unresolved')
      expect(detail.substatus).toBe('regressed')
    })

    it('在同版本重新出现 → 保持 resolved（是噪音）', () => {
      const { issues, project } = setupDb()
      const outcome = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('noise') }))

      issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('noise'), release: '1.4.3' }))

      const detail = issues.getIssue(project.id, outcome.issueId)
      expect(detail.status).toBe('resolved')
    })

    it('活动流记录每一次状态变化', () => {
      const { issues, project } = setupDb()
      const outcome = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('act') }))

      issues.resolve(project.id, outcome.issueId, { release: '1.4.3' })
      issues.archive(project.id, outcome.issueId, { strategy: 'forever' })

      const detail = issues.getIssue(project.id, outcome.issueId)
      const actions = detail.activity?.map((a) => a.action) ?? []
      expect(actions).toContain('created')
      expect(actions).toContain('resolved')
      expect(actions).toContain('archived')
    })

    it('评论会进详情', () => {
      const { issues, tenancy, project, organization } = setupDb()
      const member = tenancy.createMember(organization.id, 'c@example.com', '李四')
      const outcome = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('c') }))

      const detail = issues.comment(project.id, outcome.issueId, member.id, '已经定位到是空指针')
      expect(detail.comments).toHaveLength(1)
      expect(detail.comments?.[0].body).toBe('已经定位到是空指针')
    })

    it('分配负责人', () => {
      const { issues, tenancy, project, organization } = setupDb()
      const member = tenancy.createMember(organization.id, 'a@example.com', '张三')
      const outcome = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('assign') }))

      const detail = issues.assign(project.id, outcome.issueId, member.id)
      expect(detail.assigneeId).toBe(member.id)
      expect(detail.assigneeName).toBe('张三')
    })

    it('批量归档', () => {
      const { issues, project } = setupDb()
      const a = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('ba') }))
      const b = issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('bb') }))

      const affected = issues.bulkAction(project.id, {
        issueIds: [a.issueId, b.issueId],
        action: 'archive',
        archiveStrategy: 'forever'
      })

      expect(affected).toBe(2)
      expect(issues.getIssue(project.id, a.issueId).status).toBe('archived')
      expect(issues.getIssue(project.id, b.issueId).status).toBe('archived')
    })
  })

  describe('查询', () => {
    it('按分类过滤', () => {
      const { issues, project } = setupDb()
      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('js') }))
      issues.ingestEvent(
        project.id,
        makeEvent({
          fingerprint: fp('http'),
          category: 'http',
          http: { method: 'GET', url: '/api/x', status: 500 }
        })
      )

      const result = issues.listIssues({ projectId: project.id, category: 'http' })
      expect(result.total).toBe(1)
    })

    it('关键词能搜到消息', () => {
      const { issues, project } = setupDb()
      issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('search'), message: 'Payment gateway timeout' })
      )

      const result = issues.listIssues({ projectId: project.id, query: 'gateway' })
      expect(result.total).toBe(1)
    })

    it('统计汇总正确', () => {
      const { issues, project } = setupDb()
      const base = Date.now()

      issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('stat'), occurredAt: base }))
      issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('stat'), occurredAt: base + 1000 })
      )

      const stats = issues.stats(project.id)
      expect(stats.total).toBe(1)
      expect(stats.occurrences).toBe(2)
      expect(stats.unresolved).toBe(1)
      expect(stats.new).toBe(1)
    })
  })
})
