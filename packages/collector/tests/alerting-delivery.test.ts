import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRetryable, postJson } from '../src/domains/alerting/channels.js'
import { DeliveryWorker } from '../src/domains/alerting/delivery.js'
import { fp, makeEvent, setupDb } from './helpers.js'

/**
 * 告警通道的可靠性：重试 + 死信。
 *
 * 值班系统里「通知没送到」是最伤的故障 ——
 * 告警触发了，但没人收到，而且**事后查不到为什么**。
 */
describe('告警通道可靠性', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 装一个假的 fetch：按脚本依次返回结果 */
  function stubFetch(responses: Array<{ status?: number; throw?: string }>): { calls: number } {
    const state = { calls: 0 }
    vi.stubGlobal('fetch', async () => {
      const spec = responses[Math.min(state.calls, responses.length - 1)]
      state.calls++
      if (spec.throw) throw new Error(spec.throw)
      return {
        ok: (spec.status ?? 200) < 400,
        status: spec.status ?? 200,
        text: async () => '服务端错误'
      }
    })
    return state
  }

  describe('哪些失败值得重试', () => {
    it('网络错误、5xx、429 值得重试', () => {
      expect(isRetryable({ ok: false })).toBe(true)
      expect(isRetryable({ ok: false, status: 500 })).toBe(true)
      expect(isRetryable({ ok: false, status: 503 })).toBe(true)
      expect(isRetryable({ ok: false, status: 429 })).toBe(true)
    })

    it('4xx 不值得重试（请求本身有问题，再发一百次也一样）', () => {
      expect(isRetryable({ ok: false, status: 400 })).toBe(false)
      expect(isRetryable({ ok: false, status: 401 })).toBe(false)
      expect(isRetryable({ ok: false, status: 404 })).toBe(false)
    })
  })

  describe('重试', () => {
    it('5xx 之后重试成功', async () => {
      const fetchState = stubFetch([{ status: 503 }, { status: 200 }])

      const result = await postJson('https://example.com/hook', { a: 1 })

      expect(result.ok).toBe(true)
      expect(result.attempts).toBe(2)
      expect(fetchState.calls).toBe(2)
    })

    it('4xx 不重试', async () => {
      const fetchState = stubFetch([{ status: 400 }])

      const result = await postJson('https://example.com/hook', { a: 1 })

      expect(result.ok).toBe(false)
      expect(result.attempts).toBe(1)
      expect(fetchState.calls).toBe(1)
    })

    it('网络错误会重试', async () => {
      const fetchState = stubFetch([{ throw: 'ECONNRESET' }, { status: 200 }])

      const result = await postJson('https://example.com/hook', { a: 1 })

      expect(result.ok).toBe(true)
      expect(result.attempts).toBe(2)
      expect(fetchState.calls).toBe(2)
    })

    it('全失败时尝试次数有上限（不会无限重试）', async () => {
      const fetchState = stubFetch([{ status: 503 }])

      const result = await postJson('https://example.com/hook', { a: 1 })

      expect(result.ok).toBe(false)
      // 最多 3 次（1 次首发 + 2 次重试）
      expect(result.attempts).toBeLessThanOrEqual(3)
      expect(fetchState.calls).toBeLessThanOrEqual(3)
    })

    it('总预算封顶：预算不够再试一次时就不试了', async () => {
      stubFetch([{ status: 503 }])

      // 预算给 1ms —— 塞不下一次尝试，只能试一次
      const result = await postJson('https://example.com/hook', { a: 1 }, 1)

      expect(result.ok).toBe(false)
      expect(result.attempts).toBe(1)
    })
  })

  describe('异步投递', () => {
    it('评估只入队，不碰网络', async () => {
      const { alerting, evaluator, project, issues } = await setupDb()
      const fetchState = stubFetch([{ status: 200 }])

      const channel = await alerting.createChannel({
        projectId: project.id,
        name: '机器人',
        type: 'webhook',
        config: { url: 'https://example.com/hook' }
      })
      await alerting.createRule({
        projectId: project.id,
        name: '新问题出现',
        type: 'issue.new',
        threshold: 1,
        windowSeconds: 300,
        channelIds: [channel.id]
      })

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('queue') }))
      await evaluator.evaluateProject(project.id)

      // ⚠️ 评估是同步的 —— 等通道会把整个告警引擎拖住
      expect(fetchState.calls).toBe(0)

      // 但投递已经入队了
      const pending = await alerting.listPendingDeliveries(Date.now())
      expect(pending).toHaveLength(1)
      expect(pending[0].status).toBe('pending')
    })

    it('worker 发出去了 → 记为 sent', async () => {
      const { alerting, evaluator, project, issues } = await setupDb()
      stubFetch([{ status: 200 }])

      const channel = await alerting.createChannel({
        projectId: project.id,
        name: '机器人',
        type: 'webhook',
        config: { url: 'https://example.com/hook' }
      })
      await alerting.createRule({
        projectId: project.id,
        name: '新问题出现',
        type: 'issue.new',
        threshold: 1,
        windowSeconds: 300,
        channelIds: [channel.id]
      })

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('sent') }))
      await evaluator.evaluateProject(project.id)

      const worker = new DeliveryWorker(alerting)
      const report = await worker.runOnce()

      expect(report.sent).toBe(1)
      expect(await alerting.listDeadDeliveries(project.id)).toHaveLength(0)
    })

    it('worker 发不出去 → 排到后面再试', async () => {
      const { alerting, evaluator, project, issues } = await setupDb()
      stubFetch([{ status: 500 }])

      const channel = await alerting.createChannel({
        projectId: project.id,
        name: '机器人',
        type: 'webhook',
        config: { url: 'https://example.com/hook' }
      })
      await alerting.createRule({
        projectId: project.id,
        name: '新问题出现',
        type: 'issue.new',
        threshold: 1,
        windowSeconds: 300,
        channelIds: [channel.id]
      })

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('retry') }))
      await evaluator.evaluateProject(project.id)

      const worker = new DeliveryWorker(alerting)
      const report = await worker.runOnce()

      expect(report.retrying).toBe(1)
      expect(report.dead).toBe(0)
      // 还没到重试时间 → worker 不会再取它
      const due = await alerting.listPendingDeliveries(Date.now())
      expect(due).toHaveLength(0)
      // 但它还在队列里，只是排在后面
      const later = await alerting.listPendingDeliveries(Date.now() + 10 * 60_000)
      expect(later).toHaveLength(1)
      expect(later[0].lastError).toBeTruthy()
    })

    it('重试用尽 → 转死信', async () => {
      const { alerting, evaluator, project, issues } = await setupDb()
      stubFetch([{ status: 500 }])

      const channel = await alerting.createChannel({
        projectId: project.id,
        name: '机器人',
        type: 'webhook',
        config: { url: 'https://example.com/hook' }
      })
      await alerting.createRule({
        projectId: project.id,
        name: '新问题出现',
        type: 'issue.new',
        threshold: 1,
        windowSeconds: 300,
        channelIds: [channel.id]
      })

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('dead') }))
      await evaluator.evaluateProject(project.id)

      const worker = new DeliveryWorker(alerting)
      // 一轮轮试下去，直到重试用尽
      // ⚠️ 时间步长要够大 —— 最长的退避是 12 小时，步长小了投递根本轮不到
      let now = Date.now()
      for (let i = 0; i < 10; i++) {
        const report = await worker.runOnce(now)
        if (report.dead > 0) break
        now += 24 * 3600_000
      }

      const dead = await alerting.listDeadDeliveries(project.id)
      expect(dead).toHaveLength(1)
      expect(dead[0].status).toBe('dead')
      expect(dead[0].lastError).toBeTruthy()
      expect(dead[0].message?.title).toBeTruthy()
    }, 30_000)

    it('通道被删了 → 直接死信，不无限重试', async () => {
      const { alerting, evaluator, project, issues } = await setupDb()
      stubFetch([{ status: 200 }])

      const channel = await alerting.createChannel({
        projectId: project.id,
        name: '机器人',
        type: 'webhook',
        config: { url: 'https://example.com/hook' }
      })
      await alerting.createRule({
        projectId: project.id,
        name: '新问题出现',
        type: 'issue.new',
        threshold: 1,
        windowSeconds: 300,
        channelIds: [channel.id]
      })

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('orphan') }))
      await evaluator.evaluateProject(project.id)

      // 通道没了
      await alerting.deleteChannel(project.id, channel.id)

      const worker = new DeliveryWorker(alerting)
      const report = await worker.runOnce()

      expect(report.orphaned).toBe(1)
      expect(await alerting.listDeadDeliveries(project.id)).toHaveLength(1)
    })
  })
})
