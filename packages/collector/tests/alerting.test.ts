import { describe, expect, it } from 'vitest'
import { fp, makeEvent, setupDb } from './helpers.js'

describe('告警引擎', () => {
  describe('规则评估', () => {
    it('issue.count 超过阈值时触发', async () => {
      const { issues, alerting, evaluator, project } = await setupDb()
      const base = Date.now()

      // 三次独立的发生（时间戳不同，否则会被 event_id 去重）
      for (let i = 0; i < 3; i++) {
        await issues.ingestEvent(
          project.id,
          makeEvent({ fingerprint: fp('count'), occurredAt: base + i * 1000 })
        )
      }

      const rule = await alerting.createRule({
        projectId: project.id,
        name: '错误过多',
        type: 'issue.count',
        threshold: 3,
        windowSeconds: 300
      })

      const result = await evaluator.evaluateProject(project.id)
      expect(result.triggered).toBe(1)

      const incidents = await alerting.listIncidents(project.id)
      expect(incidents).toHaveLength(1)
      expect(incidents[0].ruleId).toBe(rule.id)
    })

    it('没超过阈值不触发', async () => {
      const { issues, alerting, evaluator, project } = await setupDb()
      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('low') }))

      await alerting.createRule({
        projectId: project.id,
        name: '错误过多',
        type: 'issue.count',
        threshold: 10,
        windowSeconds: 300
      })

      const result = await evaluator.evaluateProject(project.id)
      expect(result.triggered).toBe(0)
    })

    it('告警去重：同一窗口内不重复触发（避免告警疲劳）', async () => {
      const { issues, alerting, evaluator, project } = await setupDb()
      const base = Date.now()

      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('dedupe'), occurredAt: base })
      )
      await issues.ingestEvent(
        project.id,
        makeEvent({ fingerprint: fp('dedupe'), occurredAt: base + 1000 })
      )

      await alerting.createRule({
        projectId: project.id,
        name: '错误过多',
        type: 'issue.count',
        threshold: 2,
        windowSeconds: 300
      })

      const first = await evaluator.evaluateProject(project.id)
      const second = await evaluator.evaluateProject(project.id)

      expect(first.triggered).toBe(1)
      // 第二次被去重键挡掉
      expect(second.triggered).toBe(0)
      expect(await alerting.listIncidents(project.id)).toHaveLength(1)
    })

    it('metric.error_count 按项目错误总数触发', async () => {
      const { issues, alerting, evaluator, project } = await setupDb()
      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('m1') }))
      await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('m2') }))

      await alerting.createRule({
        projectId: project.id,
        name: '项目错误总数',
        type: 'metric.error_count',
        threshold: 2,
        windowSeconds: 300
      })

      const result = await evaluator.evaluateProject(project.id)
      expect(result.triggered).toBe(1)
    })

    it('metric.lcp_p95 超阈值时触发', async () => {
      const { performance, alerting, evaluator, project } = await setupDb()
      await performance.ingestTransaction(project.id, {
        name: '/checkout',
        type: 'page',
        startedAt: Date.now(),
        durationMs: 4000,
        vitals: { lcp: 5000 },
        pageUrl: 'https://a.com/checkout',
        userAgent: 'test',
        sessionId: 's1'
      })

      await alerting.createRule({
        projectId: project.id,
        name: 'LCP 太慢',
        type: 'metric.lcp_p95',
        threshold: 2500,
        windowSeconds: 300
      })

      const result = await evaluator.evaluateProject(project.id)
      expect(result.triggered).toBe(1)
    })

    it('条件过滤：环境不匹配时不触发', async () => {
      const { issues, alerting, evaluator, project } = await setupDb()
      const event = makeEvent({ fingerprint: fp('env'), environment: 'staging' })
      await issues.ingestEvent(project.id, event)
      await issues.ingestEvent(project.id, event)

      await alerting.createRule({
        projectId: project.id,
        name: '生产环境错误',
        type: 'issue.count',
        threshold: 1,
        windowSeconds: 300,
        conditions: { environment: ['production'] }
      })

      const result = await evaluator.evaluateProject(project.id)
      expect(result.triggered).toBe(0)
    })
  })

  describe('通道', () => {
    it('webhook 通道真的把消息发出去', async () => {
      // 起一个本地服务当 webhook 接收端
      const received: unknown[] = []
      const { createServer } = await import('node:http')
      const server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          received.push(JSON.parse(body))
          res.writeHead(200).end('ok')
        })
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const { issues, alerting, evaluator, project } = await setupDb()
        const base = Date.now()
        await issues.ingestEvent(
          project.id,
          makeEvent({ fingerprint: fp('hook'), occurredAt: base })
        )
        await issues.ingestEvent(
          project.id,
          makeEvent({ fingerprint: fp('hook'), occurredAt: base + 1000 })
        )

        const channel = await alerting.createChannel({
          projectId: project.id,
          name: '测试 webhook',
          type: 'webhook',
          config: { url: `http://127.0.0.1:${port}/hook` }
        })

        await alerting.createRule({
          projectId: project.id,
          name: '错误过多',
          type: 'issue.count',
          threshold: 2,
          windowSeconds: 300,
          channelIds: [channel.id]
        })

        await evaluator.evaluateProject(project.id)

        expect(received).toHaveLength(1)
        expect((received[0] as { title: string }).title).toContain('错误次数超阈值')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('飞书通道用飞书的 payload 格式', async () => {
      const received: unknown[] = []
      const { createServer } = await import('node:http')
      const server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          received.push(JSON.parse(body))
          res.writeHead(200).end('ok')
        })
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const { issues, alerting, evaluator, project } = await setupDb()
        const event = makeEvent({ fingerprint: fp('feishu') })
        await issues.ingestEvent(project.id, event)

        const channel = await alerting.createChannel({
          projectId: project.id,
          name: '飞书',
          type: 'feishu',
          config: { url: `http://127.0.0.1:${port}/feishu` }
        })

        await alerting.createRule({
          projectId: project.id,
          name: '新问题',
          type: 'issue.count',
          threshold: 1,
          windowSeconds: 300,
          channelIds: [channel.id]
        })

        await evaluator.evaluateProject(project.id)

        expect(received).toHaveLength(1)
        const payload = received[0] as { msg_type: string; content: { text: string } }
        // 格式不对的话飞书机器人会返回 200 但不显示
        expect(payload.msg_type).toBe('text')
        expect(payload.content.text).toContain('错误次数超阈值')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
})
