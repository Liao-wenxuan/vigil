import { describe, expect, it } from 'vitest'
import { fp, makeEvent, makeTransaction, setupDb } from './helpers.js'

/**
 * SLO 燃烧率告警。
 *
 * ## 为什么「长短窗口同时超」才算触发
 *
 * 只看一个窗口两头不讨好：
 * - 只看短窗口 → 一阵尖峰就炸，过十分钟又好了，告警来回响，人就麻木了
 * - 只看长窗口 → 真出事了要等一天才响
 *
 * 所以长窗口配短窗口，**两个都超阈值才触发**。
 */
describe('SLO 燃烧率告警', () => {
  /**
   * 造一批访问与错误。
   *
   * @param visits 访问次数（分摊在 visitSpanMs 内）
   * @param errors 错误次数
   * @param errorAt 错误发生的时间（相对 now）
   */
  async function feed(
    base: Awaited<ReturnType<typeof setupDb>>,
    opts: {
      now: number
      visits: number
      visitSpanMs: number
      errors: number
      errorAtMs: number
    }
  ): Promise<void> {
    for (let i = 0; i < opts.visits; i++) {
      await base.performance.ingestTransaction(
        base.project.id,
        makeTransaction({
          startedAt: opts.now - opts.visitSpanMs + (i * opts.visitSpanMs) / opts.visits,
          name: '/page'
        })
      )
    }
    for (let i = 0; i < opts.errors; i++) {
      await base.issues.ingestEvent(
        base.project.id,
        makeEvent({
          fingerprint: fp('burn'),
          occurredAt: opts.now - opts.errorAtMs,
          // 载荷必须各不相同，否则会被 event_id 去重
          message: `boom-${i}`
        })
      )
    }
  }

  it('长短窗口同时超阈值 → 触发', async () => {
    const base = await setupDb()
    const now = Date.now()

    // 1000 次访问里 500 次报错 —— 错误率 50%，远超 99% 的目标
    await feed(base, { now, visits: 1000, visitSpanMs: 3600_000, errors: 500, errorAtMs: 60_000 })

    const slo = await base.slo.create({
      projectId: base.project.id,
      name: '可用性 99%',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })

    const rule = await base.alerting.createRule({
      projectId: base.project.id,
      name: '燃烧率告警',
      type: 'slo.burn_rate',
      threshold: 1,
      // 30 分钟短窗口（配 1 天长窗口）
      windowSeconds: 1800,
      conditions: { sloId: slo.id }
    })

    const result = await base.evaluator.evaluateProject(base.project.id)
    expect(result.triggered).toBe(1)

    const incidents = await base.alerting.listIncidents(base.project.id)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].ruleId).toBe(rule.id)
  })

  it('只有一个窗口超阈值 → 不触发', async () => {
    const base = await setupDb()
    const now = Date.now()

    // ⚠️ 要造出「短窗口烧得凶、长窗口没烧」的场面：
    //    访问铺满 3 天（基线很低），错误全集中在最后 30 分钟。
    //    30 分钟短窗口配的是 **6 小时**长窗口（SRE 那四组之一）：
    //    短窗口：错误率 ≈ 10/69 ≈ 14%，燃烧率 14.5×
    //    长窗口：错误率 ≈ 10/833 ≈ 1.2%，燃烧率 1.2×
    //    阈值取这组的**标准值 6** → 短窗口超、长窗口没超 → 不触发
    await feed(base, {
      now,
      visits: 10000,
      visitSpanMs: 3 * 86400_000,
      errors: 10,
      errorAtMs: 60_000
    })

    const slo = await base.slo.create({
      projectId: base.project.id,
      name: '可用性 99%',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })

    await base.alerting.createRule({
      projectId: base.project.id,
      name: '燃烧率告警',
      type: 'slo.burn_rate',
      threshold: 6,
      windowSeconds: 1800,
      conditions: { sloId: slo.id }
    })

    const result = await base.evaluator.evaluateProject(base.project.id)
    expect(result.triggered).toBe(0)
    expect(await base.alerting.listIncidents(base.project.id)).toHaveLength(0)
  })

  it('阈值调高 → 不触发', async () => {
    const base = await setupDb()
    const now = Date.now()

    await feed(base, { now, visits: 1000, visitSpanMs: 3600_000, errors: 500, errorAtMs: 60_000 })

    const slo = await base.slo.create({
      projectId: base.project.id,
      name: '可用性 99%',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })

    await base.alerting.createRule({
      projectId: base.project.id,
      name: '燃烧率告警',
      type: 'slo.burn_rate',
      // 燃烧率远不到 1000 倍
      threshold: 1000,
      windowSeconds: 1800,
      conditions: { sloId: slo.id }
    })

    const result = await base.evaluator.evaluateProject(base.project.id)
    expect(result.triggered).toBe(0)
  })

  it('两个 SLO 同时超阈值 → 两条都触发（去重键要区分 SLO）', async () => {
    const base = await setupDb()
    const now = Date.now()

    await feed(base, { now, visits: 1000, visitSpanMs: 3600_000, errors: 500, errorAtMs: 60_000 })

    const first = await base.slo.create({
      projectId: base.project.id,
      name: 'SLO 甲',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })
    const second = await base.slo.create({
      projectId: base.project.id,
      name: 'SLO 乙',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })
    expect(first.id).not.toBe(second.id)

    // 不指定 sloId → 盯所有启用的 SLO
    await base.alerting.createRule({
      projectId: base.project.id,
      name: '燃烧率告警',
      type: 'slo.burn_rate',
      threshold: 1,
      windowSeconds: 1800
    })

    const result = await base.evaluator.evaluateProject(base.project.id)
    expect(result.triggered).toBe(2)

    const incidents = await base.alerting.listIncidents(base.project.id)
    expect(incidents).toHaveLength(2)
    // 两条告警各说各的 SLO —— 证明去重键把它们分开了
    const bodies = incidents.map((i) => JSON.stringify(i.payload))
    expect(bodies.some((b) => b.includes('SLO 甲'))).toBe(true)
    expect(bodies.some((b) => b.includes('SLO 乙'))).toBe(true)
  })

  it('conditions.sloId 只盯指定的 SLO', async () => {
    const base = await setupDb()
    const now = Date.now()

    await feed(base, { now, visits: 1000, visitSpanMs: 3600_000, errors: 500, errorAtMs: 60_000 })

    const watched = await base.slo.create({
      projectId: base.project.id,
      name: '盯着的',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })
    await base.slo.create({
      projectId: base.project.id,
      name: '没盯的',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })

    await base.alerting.createRule({
      projectId: base.project.id,
      name: '燃烧率告警',
      type: 'slo.burn_rate',
      threshold: 1,
      windowSeconds: 1800,
      conditions: { sloId: watched.id }
    })

    const result = await base.evaluator.evaluateProject(base.project.id)
    expect(result.triggered).toBe(1)
  })

  it('停用的 SLO 不参与评估', async () => {
    const base = await setupDb()
    const now = Date.now()

    await feed(base, { now, visits: 1000, visitSpanMs: 3600_000, errors: 500, errorAtMs: 60_000 })

    const slo = await base.slo.create({
      projectId: base.project.id,
      name: '停用的',
      target: 0.99,
      windowSeconds: 30 * 86400,
      stepSeconds: 3600
    })
    await base.slo.update(base.project.id, slo.id, { enabled: false })

    await base.alerting.createRule({
      projectId: base.project.id,
      name: '燃烧率告警',
      type: 'slo.burn_rate',
      threshold: 1,
      windowSeconds: 1800
    })

    const result = await base.evaluator.evaluateProject(base.project.id)
    expect(result.triggered).toBe(0)
  })
})
