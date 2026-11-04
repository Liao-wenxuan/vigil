import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRetryable, postJson } from '../src/domains/alerting/channels.js'
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

  describe('死信留档', () => {
    it('通道发不出去 → 留一条 dead 记录', async () => {
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

      const dead = await alerting.listDeadDeliveries(project.id)
      expect(dead).toHaveLength(1)
      expect(dead[0].status).toBe('dead')
      expect(dead[0].channelType).toBe('webhook')
      expect(dead[0].attempts).toBeGreaterThanOrEqual(1)
      expect(dead[0].lastError).toBeTruthy()
      // 消息内容留下来了 —— 重放要用
      expect(dead[0].message?.title).toBeTruthy()
    })

    it('通道发得出去 → 不留死信', async () => {
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

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('ok') }))
      await evaluator.evaluateProject(project.id)

      expect(await alerting.listDeadDeliveries(project.id)).toHaveLength(0)
    })

    it('重放成功 → 状态变成 sent', async () => {
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

      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('replay') }))
      await evaluator.evaluateProject(project.id)

      const dead = await alerting.listDeadDeliveries(project.id)
      expect(dead).toHaveLength(1)

      // 通道恢复了，重放一次
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '' }))
      const { getSender } = await import('../src/domains/alerting/channels.js')
      const row = await alerting.getDelivery(project.id, dead[0].id)
      const target = await alerting.getChannel(project.id, row!.channelId!)
      const result = await getSender(target.type).send(target.config as never, row!.message!)
      await alerting.markDelivery(row!.id, result.ok, result.error)

      expect(result.ok).toBe(true)
      expect(await alerting.listDeadDeliveries(project.id)).toHaveLength(0)
    })
  })
})
