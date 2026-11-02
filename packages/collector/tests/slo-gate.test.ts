import { describe, expect, it } from 'vitest'
import { decideSloGate } from '../src/domains/slo/gate.js'
import type { Slo, SloEvaluation, SloStatus } from '@vigil/protocol'

/**
 * 发布闸门的策略。
 *
 * 这是**业务规则**（什么情况不放行），所以要有测试 ——
 * 每次改都要手工跑一遍命令看退出码是不可接受的。
 */
describe('SLO 发布闸门', () => {
  const slo: Slo = {
    id: 1,
    projectId: 1,
    name: '可用性 99.9%',
    metric: 'error_rate',
    target: 0.999,
    windowSeconds: 30 * 86400,
    stepSeconds: 3600,
    enabled: true,
    createdAt: 0,
    updatedAt: 0
  }

  function evaluation(overrides: Partial<SloEvaluation> = {}): SloEvaluation {
    return {
      sloId: 1,
      status: 'healthy',
      windowStart: 0,
      windowEnd: 0,
      evaluatedSteps: 100,
      skippedSteps: 0,
      goodSteps: 100,
      total: 1000,
      bad: 0,
      sli: 1,
      errorRatio: 0,
      budgetTotal: 10,
      budgetRemaining: 10,
      budgetConsumedRatio: 0,
      burnRate: 0,
      ...overrides
    }
  }

  function items(status: SloStatus, overrides: Partial<SloEvaluation> = {}) {
    return [{ slo, evaluation: evaluation({ status, ...overrides }) }]
  }

  it('预算耗尽 → 阻断', () => {
    const result = decideSloGate(items('exhausted', { budgetRemaining: -10, burnRate: 50 }))
    expect(result.passed).toBe(false)
    expect(result.entries[0].blocking).toBe(true)
    expect(result.summary).toContain('可用性 99.9%')
  })

  it('有风险 → 默认不阻断，只提示', () => {
    const result = decideSloGate(items('at_risk', { sli: 0.9, burnRate: 3 }))
    expect(result.passed).toBe(true)
    expect(result.entries[0].blocking).toBe(false)
    expect(result.entries[0].reason).toContain('不阻断')
  })

  it('有风险 → 严格模式下阻断', () => {
    const result = decideSloGate(items('at_risk', { sli: 0.9, burnRate: 3 }), { strict: true })
    expect(result.passed).toBe(false)
    expect(result.entries[0].blocking).toBe(true)
  })

  it('达标 → 放行', () => {
    const result = decideSloGate(items('healthy'))
    expect(result.passed).toBe(true)
    expect(result.entries[0].reason).toBe('达标')
  })

  it('没有可判定的数据 → 默认跳过，不阻断', () => {
    const result = decideSloGate(items('healthy', { sli: null, errorRatio: null, burnRate: null }))
    expect(result.passed).toBe(true)
    expect(result.entries[0].reason).toContain('跳过')
  })

  it('没有可判定的数据 → 要求数据时阻断', () => {
    const result = decideSloGate(
      items('healthy', { sli: null, errorRatio: null, burnRate: null }),
      {
        requireData: true
      }
    )
    expect(result.passed).toBe(false)
  })

  it('没有 SLO → 默认跳过', () => {
    const result = decideSloGate([])
    expect(result.passed).toBe(true)
    expect(result.summary).toContain('没有 SLO')
  })

  it('没有 SLO → 要求必须有 SLO 时阻断', () => {
    const result = decideSloGate([], { requireSlo: true })
    expect(result.passed).toBe(false)
  })

  it('多条 SLO 时任一阻断就整体阻断', () => {
    const second: Slo = { ...slo, id: 2, name: '错误率低于 60%' }
    const result = decideSloGate([
      { slo, evaluation: evaluation({ status: 'healthy' }) },
      {
        slo: second,
        evaluation: evaluation({ sloId: 2, status: 'exhausted', budgetRemaining: -1 })
      }
    ])
    expect(result.passed).toBe(false)
    expect(result.summary).toContain('错误率低于 60%')
  })
})
