import { describe, expect, it } from 'vitest'
import { SloService } from '../src/domains/slo/service.js'
import { setupDb, makeEvent, makeTransaction } from './helpers.js'

/**
 * SLO 与错误预算。
 *
 * 这个域最容易错的地方是**口径**，所以测试盯的是具体数字：
 * 分步判定、无流量步、预算、燃烧率。
 */
describe('SLO 与错误预算', () => {
  /** 造一个项目 + 服务 */
  async function setup() {
    const base = await setupDb()
    const slo = new SloService(base.db)
    return { ...base, slo }
  }

  /** 在指定时刻灌入一批「页面访问」和一批「错误」 */
  async function feed(
    base: Pick<Awaited<ReturnType<typeof setup>>, 'performance' | 'issues'>,
    projectId: number,
    opts: { visits: number; errors: number; at: number }
  ): Promise<void> {
    for (let i = 0; i < opts.visits; i++) {
      await base.performance.ingestTransaction(
        projectId,
        makeTransaction({
          startedAt: opts.at,
          name: '/page'
        })
      )
    }
    for (let i = 0; i < opts.errors; i++) {
      await base.issues.ingestEvent(
        projectId,
        makeEvent({
          fingerprint: 'fp-slo',
          occurredAt: opts.at,
          // ⚠️ 消息必须各不相同 —— 服务端给没带 eventId 的事件生成 ID，
          //    而 ID 是整个载荷的哈希：载荷一样就是同一条，会被去重掉。
          message: `boom-${i}`
        })
      )
    }
  }

  describe('定义', () => {
    it('能创建并读回', async () => {
      const { slo, project } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: '可用性',
        target: 0.999,
        windowSeconds: 3600
      })

      expect(created.id).toBeGreaterThan(0)
      expect(created.name).toBe('可用性')
      expect(created.target).toBe(0.999)
      expect(created.enabled).toBe(true)

      const list = await slo.list(project.id)
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(created.id)
    })

    it('目标值必须在 (0, 1] 之间', async () => {
      const { slo, project } = await setup()
      await expect(
        slo.create({ projectId: project.id, name: 'x', target: 0, windowSeconds: 3600 })
      ).rejects.toThrow()
      await expect(
        slo.create({ projectId: project.id, name: 'x', target: 1.5, windowSeconds: 3600 })
      ).rejects.toThrow()
    })

    it('步长必须整除窗口', async () => {
      const { slo, project } = await setup()
      await expect(
        slo.create({
          projectId: project.id,
          name: 'x',
          target: 0.99,
          windowSeconds: 3600,
          stepSeconds: 700
        })
      ).rejects.toThrow(/整除/)
    })

    it('别的项目读不到也改不了', async () => {
      const { slo, project, tenancy, organization } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.99,
        windowSeconds: 3600
      })
      const other = await tenancy.createProject({
        organizationId: organization.id,
        name: '别的项目'
      })

      // 读不到
      await expect(slo.get(other.project.id, created.id)).rejects.toThrow()

      // 用别的项目的路径删 —— 删不掉（这条比「抛不抛错」更重要）
      await slo.delete(other.project.id, created.id)
      expect(await slo.get(project.id, created.id)).toBeDefined()

      // 改不动
      await expect(slo.update(other.project.id, created.id, { name: '被改了' })).rejects.toThrow()
      expect((await slo.get(project.id, created.id)).name).toBe('x')
    })
  })

  describe('评估', () => {
    it('没有流量 → SLI 是 null，不是 1', async () => {
      const { slo, project } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.999,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const result = await slo.evaluate(project.id, created, 1_700_000_000_000)
      expect(result.sli).toBeNull()
      expect(result.errorRatio).toBeNull()
      expect(result.evaluatedSteps).toBe(0)
      expect(result.skippedSteps).toBeGreaterThan(0)
      expect(result.status).toBe('healthy')
    })

    it('全部达标 → SLI 是 1，预算没动', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      await feed(base, project.id, { visits: 100, errors: 0, at: now - 60_000 })

      const result = await slo.evaluate(project.id, created, now)
      expect(result.sli).toBe(1)
      expect(result.errorRatio).toBe(0)
      expect(result.goodSteps).toBeGreaterThan(0)
      expect(result.budgetRemaining).toBeCloseTo(result.budgetTotal)
      expect(result.status).toBe('healthy')
    })

    it('错误集中在一个小流量步 → 预算没烧完，但 SLI 掉下来 → at_risk', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      // 大流量的一步：干干净净
      await feed(base, project.id, { visits: 1000, errors: 0, at: now - 20 * 60_000 })
      // 小流量的一步：错误集中爆发（用户体感最差的就是这种）
      await feed(base, project.id, { visits: 10, errors: 5, at: now - 60_000 })

      const result = await slo.evaluate(project.id, created, now)
      expect(result.total).toBe(1010)
      expect(result.bad).toBe(5)
      // 预算还够（0.1 × 1010 = 101，才用了 5）
      expect(result.budgetRemaining).toBeGreaterThan(0)
      expect(result.status).not.toBe('exhausted')
      // 但那一步不达标 → SLI 掉下来 → 有风险
      expect(result.sli).toBeCloseTo(0.5)
      expect(result.status).toBe('at_risk')
    })

    it('预算 = (1 - 目标) × 请求数', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      await feed(base, project.id, { visits: 100, errors: 5, at: now - 60_000 })

      const result = await slo.evaluate(project.id, created, now)
      expect(result.total).toBe(100)
      expect(result.bad).toBe(5)
      expect(result.budgetTotal).toBeCloseTo(10) // (1 - 0.9) × 100
      expect(result.budgetRemaining).toBeCloseTo(5)
      expect(result.budgetConsumedRatio).toBeCloseTo(0.5)
    })

    it('预算烧完了 → exhausted', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      // 允许 10 个错，来了 20 个 → 预算用完
      await feed(base, project.id, { visits: 100, errors: 20, at: now - 60_000 })

      const result = await slo.evaluate(project.id, created, now)
      expect(result.budgetRemaining).toBeLessThanOrEqual(0)
      expect(result.status).toBe('exhausted')
    })

    it('燃烧率 = 错误率 ÷ 允许错误率', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      // 错误率 0.05，允许 0.1 → 燃烧率 0.5
      await feed(base, project.id, { visits: 100, errors: 5, at: now - 60_000 })

      const result = await slo.evaluate(project.id, created, now)
      expect(result.burnRate).toBeCloseTo(0.5)
    })

    it('无流量的步被跳过，不算达标也不算不达标', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      // 只有一步有流量，其余 5 步空着
      await feed(base, project.id, { visits: 100, errors: 0, at: now - 60_000 })

      const result = await slo.evaluate(project.id, created, now)
      expect(result.evaluatedSteps).toBe(1)
      // 窗口对齐到步边界后可能多出一步，所以是「至少 5 步空着」
      expect(result.skippedSteps).toBeGreaterThanOrEqual(5)
      expect(result.sli).toBe(1)
    })
  })

  describe('多窗口燃烧率', () => {
    it('长窗口和短窗口都超阈值才算 alerting', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      // 错误集中在一小段时间里 → 短窗口烧得快，长窗口还没烧完
      await feed(base, project.id, { visits: 100, errors: 60, at: now - 60_000 })

      const windows = await slo.burnRateWindows(project.id, created, now)
      expect(windows).toHaveLength(4)

      const hour = windows.find((w) => w.longSeconds === 3600)
      expect(hour).toBeDefined()
      expect(hour?.shortBurnRate).toBeGreaterThan(0)
      // 长窗口（1 小时）里错误只占很小一段时间 → 没到阈值
      expect(hour?.alerting).toBe(false)
    })

    it('没有流量时燃烧率是 null', async () => {
      const { slo, project } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const windows = await slo.burnRateWindows(project.id, created, 1_700_000_000_000)
      expect(windows.every((w) => w.longBurnRate === null && w.shortBurnRate === null)).toBe(true)
      expect(windows.every((w) => w.alerting === false)).toBe(true)
    })
  })

  describe('预算趋势', () => {
    it('每步给出错误率与累计消耗比例', async () => {
      const { slo, project, ...base } = await setup()
      const created = await slo.create({
        projectId: project.id,
        name: 'x',
        target: 0.9,
        windowSeconds: 3600,
        stepSeconds: 600
      })

      const now = 1_700_000_000_000
      await feed(base, project.id, { visits: 100, errors: 5, at: now - 60_000 })

      const series = await slo.budgetSeries(project.id, created, now)
      expect(series.points.length).toBeGreaterThan(0)

      const withData = series.points.filter((p) => p.total > 0)
      expect(withData).toHaveLength(1)
      expect(withData[0].bad).toBe(5)
      expect(withData[0].errorRate).toBeCloseTo(0.05)
      expect(withData[0].compliant).toBe(true)
      expect(withData[0].consumedRatio).toBeCloseTo(0.5)
    })
  })
})
