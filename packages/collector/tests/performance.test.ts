import { describe, expect, it } from 'vitest'
import { makeEvent, makeTransaction, setupDb } from './helpers.js'
import { percentiles } from '../src/domains/performance/service.js'

describe('性能域', () => {
  describe('分位数', () => {
    it('空数组返回全零', () => {
      const result = percentiles([])
      expect(result.count).toBe(0)
      expect(result.p95).toBe(0)
    })

    it('单值时所有分位相同', () => {
      const result = percentiles([100])
      expect(result.p50).toBe(100)
      expect(result.p95).toBe(100)
      expect(result.min).toBe(100)
      expect(result.max).toBe(100)
    })

    it('最近秩法：分位数一定是实际观测到的值', () => {
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
      const result = percentiles(values)

      expect(result.p50).toBe(50)
      expect(result.p95).toBe(100)
      expect(result.avg).toBe(55)
      // 不会报出一个从未出现过的值
      expect(values).toContain(result.p95)
    })

    it('顺序无关', () => {
      const a = percentiles([30, 10, 20])
      const b = percentiles([10, 20, 30])
      expect(a.p50).toBe(b.p50)
      expect(a.p95).toBe(b.p95)
    })
  })

  describe('事务摄入', () => {
    it('写入事务与 span', () => {
      const { performance, project } = setupDb()

      const result = performance.ingestTransaction(
        project.id,
        makeTransaction({
          spans: [
            {
              name: 'GET /api/user',
              type: 'http',
              durationMs: 320,
              statusCode: 200,
              url: '/api/user'
            },
            { name: 'main.js', type: 'resource', durationMs: 80, sizeBytes: 120000 }
          ]
        })
      )

      expect(result.transactionId).toBeGreaterThan(0)
      expect(result.spans).toBe(2)
    })

    it('汇总能算出 LCP 分位数', () => {
      const { performance, project } = setupDb()

      for (const lcp of [1000, 2000, 3000, 4000, 5000]) {
        performance.ingestTransaction(
          project.id,
          makeTransaction({ vitals: { lcp }, sessionId: `s_${lcp}` })
        )
      }

      const summary = performance.summary({ projectId: project.id })
      expect(summary.transactions).toBe(5)
      expect(summary.vitals.lcp.p95).toBe(5000)
      expect(summary.vitals.lcp.avg).toBe(3000)
    })

    it('按环境过滤', () => {
      const { performance, project } = setupDb()

      performance.ingestTransaction(
        project.id,
        makeTransaction({ environment: 'production', vitals: { lcp: 1000 } })
      )
      performance.ingestTransaction(
        project.id,
        makeTransaction({ environment: 'staging', vitals: { lcp: 9000 } })
      )

      const prod = performance.summary({ projectId: project.id, environment: 'production' })
      expect(prod.transactions).toBe(1)
      expect(prod.vitals.lcp.p95).toBe(1000)
    })

    it('能列出最慢的接口', () => {
      const { performance, project } = setupDb()

      performance.ingestTransaction(
        project.id,
        makeTransaction({
          spans: [{ name: 'GET /api/slow', type: 'http', durationMs: 5000, statusCode: 200 }]
        })
      )
      performance.ingestTransaction(
        project.id,
        makeTransaction({
          spans: [{ name: 'GET /api/fast', type: 'http', durationMs: 50, statusCode: 200 }]
        })
      )

      const summary = performance.summary({ projectId: project.id })
      expect(summary.topSpans[0].name).toBe('GET /api/slow')
      expect(summary.topSpans[0].p95).toBe(5000)
    })
  })

  describe('错误与性能关联', () => {
    it('能查出哪些错误发生时页面 LCP 更差', () => {
      const { issues, performance, project } = setupDb()

      // 一个带性能快照的错误
      issues.ingestEvent(
        project.id,
        makeEvent({
          fingerprint: 'f'.repeat(16),
          vitals: { lcp: 4000 }
        })
      )

      const rows = performance.errorPerformanceCorrelation(project.id)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0].avgLcp).toBe(4000)
    })
  })
})
