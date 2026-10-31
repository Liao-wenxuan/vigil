import { describe, expect, it } from 'vitest'
import { canonicalJson, generateEventId } from '../src/domains/issues/event-identity.js'
import { fp, makeEvent, setupDb } from './helpers.js'

/**
 * 事件身份（去重 ID）。
 *
 * 这组测试盯的是一个**已经出过一次**的 bug：
 * 兜底 ID 的哈希漏掉了 release，导致同一毫秒内同会话的两条事件
 * （来自不同版本）算出同一个 ID，第二条被当成网络重试丢掉 ——
 * 回归检测因此被绕过，Issue 永远停在 resolved。
 *
 * 那个 bug 的表现形式是**偶发**的测试失败（只在两次上报落在同一毫秒时触发），
 * 而且失败信息指向状态机，跟去重毫无关系 —— 极难定位。
 */
describe('事件身份', () => {
  describe('规范化序列化', () => {
    it('键顺序不同但内容相同 → 序列化结果相同', () => {
      const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } })
      const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
      expect(a).toBe(b)
    })

    it('内容不同 → 序列化结果不同', () => {
      expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }))
    })

    it('数组顺序不同 → 结果不同（数组是有序的）', () => {
      expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    })

    it('undefined 字段被忽略（与 JSON 语义一致）', () => {
      expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
    })
  })

  describe('兜底 ID', () => {
    it('同一条事件 → 同一个 ID（去重成立）', () => {
      const event = makeEvent({ fingerprint: fp('a') })
      expect(generateEventId(event, 1000)).toBe(generateEventId(event, 1000))
    })

    it('键顺序不同 → 同一个 ID（换序列化方式不会让重试变成新事件）', () => {
      const base = makeEvent({ fingerprint: fp('b') })
      // 把键整个倒过来 —— 内容一模一样，只是序列化顺序变了
      const flipped = Object.fromEntries(Object.entries(base).reverse()) as typeof base
      expect(generateEventId(flipped, 1000)).toBe(generateEventId(base, 1000))
    })

    it('版本不同 → 不同 ID', () => {
      const a = makeEvent({ fingerprint: fp('c'), release: '1.4.3' })
      const b = makeEvent({ fingerprint: fp('c'), release: '1.4.4' })
      expect(generateEventId(b, 1000)).not.toBe(generateEventId(a, 1000))
    })

    it('消息不同 → 不同 ID', () => {
      const a = makeEvent({ fingerprint: fp('d'), message: 'boom' })
      const b = makeEvent({ fingerprint: fp('d'), message: 'boom again' })
      expect(generateEventId(b, 1000)).not.toBe(generateEventId(a, 1000))
    })

    it('环境不同 → 不同 ID', () => {
      const a = makeEvent({ fingerprint: fp('e'), environment: 'production' })
      const b = makeEvent({ fingerprint: fp('e'), environment: 'staging' })
      expect(generateEventId(b, 1000)).not.toBe(generateEventId(a, 1000))
    })

    it('发生时间不同 → 不同 ID', () => {
      const event = makeEvent({ fingerprint: fp('f') })
      expect(generateEventId(event, 1000)).not.toBe(generateEventId(event, 2000))
    })
  })

  describe('去重不能吃掉真实事件', () => {
    it('同一毫秒、不同版本的两条事件都会被计数', async () => {
      const { issues, project } = await setupDb()
      const at = 1_700_000_000_000

      // ⚠️ 两次上报的 occurredAt **完全相同** ——
      //    旧实现只哈希「指纹+时间+用户+会话+URL」，这两条会算出同一个 ID，
      //    第二条被当成网络重试丢掉，count 停在 1。
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('same-ms'), occurredAt: at })
      )
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('same-ms'), occurredAt: at, release: '1.4.4' })
      )

      const result = await issues.listIssues({ projectId: project.id })
      expect(result.issues[0].count).toBe(2)
    })

    it('完全相同的事件仍然只算一次（网络重试）', async () => {
      const { issues, project } = await setupDb()
      const event = makeEvent({ fingerprint: fp('retry'), occurredAt: 1_700_000_000_000 })

      await issues.ingestEvent(project.id, event)
      await issues.ingestEvent(project.id, event)

      const result = await issues.listIssues({ projectId: project.id })
      expect(result.issues[0].count).toBe(1)
    })
  })
})
