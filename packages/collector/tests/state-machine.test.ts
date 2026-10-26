import { describe, expect, it } from 'vitest'
import {
  isNewerVersion,
  NEW_ISSUE_WINDOW_MS,
  transition,
  type IssueState
} from '../src/domains/issues/state-machine.js'

/** 构造一个状态快照 */
function state(overrides: Partial<IssueState> = {}): IssueState {
  return {
    status: 'unresolved',
    substatus: 'new',
    count: 0,
    userCount: 0,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    hasSeen: false,
    ...overrides
  }
}

describe('Issue 状态机', () => {
  describe('新建', () => {
    it('初始状态是 unresolved / new', () => {
      const result = transition(state(), { type: 'created', now: Date.now() })
      expect(result.state.status).toBe('unresolved')
      expect(result.state.substatus).toBe('new')
      expect(result.activities).toHaveLength(1)
      expect(result.activities[0].action).toBe('created')
    })
  })

  describe('收到事件', () => {
    it('累加次数并更新最后出现时间', () => {
      const now = Date.now()
      const result = transition(state({ count: 3, userCount: 2 }), {
        type: 'event_received',
        now,
        userIsNew: false
      })
      expect(result.state.count).toBe(4)
      expect(result.state.lastSeen).toBe(now)
      expect(result.state.userCount).toBe(2)
    })

    it('新用户会累加受影响用户数', () => {
      const result = transition(state({ count: 1, userCount: 1 }), {
        type: 'event_received',
        now: Date.now(),
        userIsNew: true
      })
      expect(result.state.userCount).toBe(2)
    })

    it('未解决状态下不会改变状态', () => {
      const result = transition(state({ status: 'unresolved', substatus: 'new' }), {
        type: 'event_received',
        now: Date.now(),
        userIsNew: false
      })
      expect(result.state.status).toBe('unresolved')
      expect(result.state.substatus).toBe('new')
      expect(result.activities).toHaveLength(0)
    })
  })

  describe('回归检测（Resolve with Release）', () => {
    const resolved = state({
      status: 'resolved',
      substatus: 'new',
      count: 10,
      resolvedAt: 1,
      resolvedInRelease: '1.4.3',
      resolvedInReleaseId: 3
    })

    it('在更新的版本出现 → 判为回归', () => {
      const result = transition(resolved, {
        type: 'event_received',
        now: Date.now(),
        release: '1.4.4',
        userIsNew: false
      })

      expect(result.state.status).toBe('unresolved')
      expect(result.state.substatus).toBe('regressed')
      expect(result.activities[0].action).toBe('regressed')
      // 计数照常累加
      expect(result.state.count).toBe(11)
    })

    it('在解决的同一个版本出现 → 算噪音，不重新打开', () => {
      const result = transition(resolved, {
        type: 'event_received',
        now: Date.now(),
        release: '1.4.3',
        userIsNew: false
      })

      expect(result.state.status).toBe('resolved')
      expect(result.state.substatus).not.toBe('regressed')
      expect(result.activities).toHaveLength(0)
      expect(result.state.count).toBe(11)
    })

    it('在更早的版本出现 → 算噪音，不重新打开', () => {
      const result = transition(resolved, {
        type: 'event_received',
        now: Date.now(),
        release: '1.4.2',
        userIsNew: false
      })

      expect(result.state.status).toBe('resolved')
      expect(result.activities).toHaveLength(0)
    })

    it('没有版本信息时保守地不判回归', () => {
      const result = transition(resolved, {
        type: 'event_received',
        now: Date.now(),
        userIsNew: false
      })
      expect(result.state.status).toBe('resolved')
    })
  })

  describe('版本比较', () => {
    it('按语义比较而不是字符串比较', () => {
      // 字符串比较下 '1.4.10' < '1.4.3'（因为 '1' < '3'），
      // 那样 1.4.3 修好的问题在 1.4.10 出现就不会被判成回归
      expect(isNewerVersion('1.4.10', '1.4.3')).toBe(true)
      expect(isNewerVersion('1.4.3', '1.4.10')).toBe(false)
      expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
      expect(isNewerVersion('1.4.3', '1.4.3')).toBe(false)
    })

    it('非标准版本无法判定', () => {
      expect(isNewerVersion('main', '1.4.3')).toBe(false)
      expect(isNewerVersion('abc123', '1.4.3')).toBe(false)
      expect(isNewerVersion(undefined, '1.4.3')).toBe(false)
      expect(isNewerVersion('1.4.4', undefined)).toBe(false)
    })
  })

  describe('归档', () => {
    it('归档后状态是 archived', () => {
      const result = transition(state(), {
        type: 'archive',
        now: Date.now(),
        strategy: 'until_escalating'
      })
      expect(result.state.status).toBe('archived')
      expect(result.state.archiveStrategy).toBe('until_escalating')
      expect(result.activities[0].action).toBe('archived')
    })

    it('归档后事件继续计数（不静默丢弃）', () => {
      const archived = state({ status: 'archived', substatus: 'new', count: 5 })
      const result = transition(archived, {
        type: 'event_received',
        now: Date.now(),
        userIsNew: false
      })
      expect(result.state.count).toBe(6)
      expect(result.state.status).toBe('archived')
    })

    it('解除归档回到 unresolved / ongoing（人工看过）', () => {
      const archived = state({ status: 'archived', substatus: 'new' })
      const result = transition(archived, { type: 'unarchive', now: Date.now() })
      expect(result.state.status).toBe('unresolved')
      expect(result.state.substatus).toBe('ongoing')
      expect(result.state.archiveStrategy).toBeUndefined()
    })
  })

  describe('升级（escalating）', () => {
    it('归档的问题量突增后自动升回', () => {
      const archived = state({ status: 'archived', substatus: 'new' })
      const result = transition(archived, { type: 'escalate', now: Date.now() })
      expect(result.state.status).toBe('unresolved')
      expect(result.state.substatus).toBe('escalating')
      expect(result.activities[0].actorType).toBe('system')
    })
  })

  describe('已阅与自动流转', () => {
    it('标记已阅会把 new 转成 ongoing', () => {
      const result = transition(state({ substatus: 'new' }), { type: 'mark_seen', now: Date.now() })
      expect(result.state.hasSeen).toBe(true)
      expect(result.state.substatus).toBe('ongoing')
    })

    it('超过 7 天自动从 new 转 ongoing', () => {
      const old = state({ substatus: 'new', firstSeen: Date.now() - NEW_ISSUE_WINDOW_MS - 1000 })
      const result = transition(old, { type: 'auto_ongoing', now: Date.now() })
      expect(result.state.substatus).toBe('ongoing')
    })

    it('不到 7 天不变', () => {
      const fresh = state({ substatus: 'new', firstSeen: Date.now() })
      const result = transition(fresh, { type: 'auto_ongoing', now: Date.now() })
      expect(result.state.substatus).toBe('new')
      expect(result.changes).toEqual({})
    })
  })

  describe('解决', () => {
    it('记录解决时间与版本', () => {
      const now = Date.now()
      const result = transition(state(), {
        type: 'resolve',
        now,
        release: '1.4.3',
        releaseId: 7
      })

      expect(result.state.status).toBe('resolved')
      expect(result.state.resolvedAt).toBe(now)
      expect(result.state.resolvedInRelease).toBe('1.4.3')
      expect(result.state.resolvedInReleaseId).toBe(7)
    })

    it('已解决的再解决是空操作', () => {
      const resolved = state({ status: 'resolved' })
      const result = transition(resolved, { type: 'resolve', now: Date.now() })
      expect(result.activities).toHaveLength(0)
      expect(result.changes).toEqual({})
    })
  })
})
