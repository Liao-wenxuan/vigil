import type { Db } from '../../infra/db/client.js'
import { bucketExpr } from '../../infra/db/dialect.js'
import { AppError } from '../../shared/errors.js'
import type {
  Slo,
  SloBudgetPoint,
  SloBudgetSeries,
  SloEvaluation,
  SloMetric,
  SloStatus
} from '@vigil/protocol'

/**
 * SLO（服务水平目标）与错误预算。
 *
 * ## 这个域在回答什么
 *
 * 「错误率涨了」是**症状**；「这个月还能不能发布」是**决策**。
 * 这个域把后者变成可计算的：
 *
 * - **SLI**：窗口内有多大比例的时间是达标的
 * - **错误预算**：还允许出多少错（= (1 - 目标) × 请求数）
 * - **燃烧率**：预算烧得比预期快多少倍
 *
 * ## 为什么 SLI 要分步判定
 *
 * 朴素做法是「窗口内总错误数 / 总请求数」。但那样一来，
 * 窗口里 99.99% 的时间完全正常、最后 1 分钟全崩，SLI 看起来还是 99.99% ——
 * 而用户那 1 分钟全在挨骂。
 *
 * 所以窗口被切成小步，**每步单独判定达标**，整体 SLI = 达标步数 / 总步数。
 *
 * ⚠️ **步长决定了「突发」的敏感度**：
 *    30 天窗口配 1 小时步 = 720 步，偶发一次错误只掉 0.14%；
 *    配 1 天步 = 30 步，同样的错误会掉 3.3%。
 *    所以步长是 SLO 定义的一部分，不是实现细节。
 *
 * ## 无流量的步怎么算
 *
 * 一步里**没有任何流量**时，这一步既不算达标也不算不达标 —— 直接跳过。
 * 理由：没流量的时候「错误率是 0」和「没访问过」是两回事
 * （与趋势域的 `errorRate: null` 是同一个原则）。
 *
 * ## 口径必须和趋势域一致
 *
 * 错误率的分母是**页面访问数**（transactions），分子是**错误发生次数**（issue_events）——
 * 与趋势域 `TrendService` 完全一样。
 * 同一个东西在两个页面显示不同的数，是最伤信任的事。
 */
export class SloService {
  constructor(private readonly db: Db) {}

  // ==========================================================
  // 定义
  // ==========================================================

  async create(input: {
    projectId: number
    name: string
    metric?: SloMetric
    target: number
    windowSeconds: number
    stepSeconds?: number
    enabled?: boolean
  }): Promise<Slo> {
    const name = input.name.trim()
    if (!name) throw AppError.badRequest('SLO 名称不能为空')

    const target = clampTarget(input.target)
    const windowSeconds = clampWindow(input.windowSeconds)
    // 步长必须能整除窗口 —— 否则窗口尾部会剩半步，判定口径就乱了
    const stepSeconds = normalizeStep(
      input.stepSeconds ?? defaultStep(windowSeconds),
      windowSeconds
    )

    const now = Date.now()
    const id = await this.db.insert(
      `INSERT INTO slos
         (project_id, name, metric, target, window_seconds, step_seconds, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        name,
        input.metric ?? 'error_rate',
        target,
        windowSeconds,
        stepSeconds,
        input.enabled === false ? 0 : 1,
        now,
        now
      ]
    )

    return await this.get(input.projectId, id)
  }

  async list(projectId: number): Promise<Slo[]> {
    const rows = await this.db.all<SloRow>('SELECT * FROM slos WHERE project_id = ? ORDER BY id', [
      projectId
    ])
    return rows.map(toSlo)
  }

  async get(projectId: number, id: number): Promise<Slo> {
    const row = await this.db.get<SloRow>('SELECT * FROM slos WHERE id = ? AND project_id = ?', [
      id,
      projectId
    ])
    if (!row) throw AppError.notFound('SLO')
    return toSlo(row)
  }

  async update(
    projectId: number,
    id: number,
    patch: Partial<{
      name: string
      target: number
      windowSeconds: number
      stepSeconds: number
      enabled: boolean
    }>
  ): Promise<Slo> {
    const current = await this.get(projectId, id)
    const target = patch.target === undefined ? current.target : clampTarget(patch.target)
    const windowSeconds =
      patch.windowSeconds === undefined ? current.windowSeconds : clampWindow(patch.windowSeconds)
    const stepSeconds = normalizeStep(
      patch.stepSeconds === undefined ? current.stepSeconds : patch.stepSeconds,
      windowSeconds
    )
    const name = patch.name === undefined ? current.name : patch.name.trim()
    if (!name) throw AppError.badRequest('SLO 名称不能为空')

    await this.db.run(
      `UPDATE slos
       SET name = ?, target = ?, window_seconds = ?, step_seconds = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND project_id = ?`,
      [
        name,
        target,
        windowSeconds,
        stepSeconds,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        Date.now(),
        id,
        projectId
      ]
    )

    return await this.get(projectId, id)
  }

  async delete(projectId: number, id: number): Promise<void> {
    await this.db.run('DELETE FROM slos WHERE id = ? AND project_id = ?', [id, projectId])
  }

  // ==========================================================
  // 评估
  // ==========================================================

  /**
   * 评估当前状态。
   *
   * @param now 评估时刻（默认现在）。测试可以传固定值。
   */
  async evaluate(projectId: number, slo: Slo, now: number = Date.now()): Promise<SloEvaluation> {
    const stepMs = slo.stepSeconds * 1000
    const windowEnd = now
    const windowStart = now - slo.windowSeconds * 1000
    // 窗口起点对齐到步边界 —— 这样步与步首尾相接，不重不漏
    const alignedStart = Math.floor(windowStart / stepMs) * stepMs
    const stepCount = Math.ceil((windowEnd - alignedStart) / stepMs)

    const { errors, transactions } = await this.stepAggregates(
      projectId,
      alignedStart,
      windowEnd,
      stepMs
    )

    const allowed = 1 - slo.target
    let evaluatedSteps = 0
    let skippedSteps = 0
    let goodSteps = 0
    let total = 0
    let bad = 0

    for (let i = 0; i < stepCount; i++) {
      const bucket = alignedStart + i * stepMs
      const stepTotal = transactions.get(bucket) ?? 0
      const stepBad = errors.get(bucket) ?? 0
      total += stepTotal
      bad += stepBad

      // 无流量的步：既不算达标也不算不达标
      if (stepTotal === 0) {
        skippedSteps++
        continue
      }
      evaluatedSteps++
      if (stepBad / stepTotal <= allowed) goodSteps++
    }

    const sli = evaluatedSteps > 0 ? goodSteps / evaluatedSteps : null
    const errorRatio = total > 0 ? bad / total : null

    const budgetTotal = allowed * total
    const budgetRemaining = budgetTotal - bad
    const budgetConsumedRatio = budgetTotal > 0 ? bad / budgetTotal : null
    const burnRate = errorRatio !== null && allowed > 0 ? errorRatio / allowed : null

    return {
      sloId: slo.id,
      status: statusOf({ slo, sli, burnRate, budgetRemaining, bad }),
      windowStart,
      windowEnd,
      evaluatedSteps,
      skippedSteps,
      goodSteps,
      total,
      bad,
      sli,
      errorRatio,
      budgetTotal,
      budgetRemaining,
      budgetConsumedRatio,
      burnRate
    }
  }

  /** 预算消耗趋势（按分步粒度） */
  async budgetSeries(
    projectId: number,
    slo: Slo,
    now: number = Date.now()
  ): Promise<SloBudgetSeries> {
    const stepMs = slo.stepSeconds * 1000
    const windowEnd = now
    const windowStart = now - slo.windowSeconds * 1000
    const alignedStart = Math.floor(windowStart / stepMs) * stepMs
    const stepCount = Math.ceil((windowEnd - alignedStart) / stepMs)

    const { errors, transactions } = await this.stepAggregates(
      projectId,
      alignedStart,
      windowEnd,
      stepMs
    )

    const allowed = 1 - slo.target
    const points: SloBudgetPoint[] = []
    let cumTotal = 0
    let cumBad = 0

    for (let i = 0; i < stepCount; i++) {
      const bucket = alignedStart + i * stepMs
      const stepTotal = transactions.get(bucket) ?? 0
      const stepBad = errors.get(bucket) ?? 0
      cumTotal += stepTotal
      cumBad += stepBad

      const budgetTotal = allowed * cumTotal
      points.push({
        timestamp: bucket,
        total: stepTotal,
        bad: stepBad,
        errorRate: stepTotal > 0 ? stepBad / stepTotal : null,
        compliant: stepTotal > 0 ? stepBad / stepTotal <= allowed : true,
        consumedRatio: budgetTotal > 0 ? cumBad / budgetTotal : null
      })
    }

    return { sloId: slo.id, points }
  }

  /**
   * 多窗口多燃烧率（Google SRE 手册的做法）。
   *
   * ## 为什么单窗口不够
   *
   * 只看「最近 1 小时」会**抖**：一阵短促的错误尖峰就把燃烧率拉爆，
   * 十分钟后又恢复正常 —— 告警来回响，人就麻木了。
   * 只看「最近 3 天」又**太慢**：真出事了要等一天才响。
   *
   * 所以用**长短窗口配对**：短窗口负责快速感知，长窗口负责确认持续消耗。
   * **两个窗口同时超阈值才告警** —— 尖峰不响，持续烧才响。
   */
  async burnRateWindows(
    projectId: number,
    slo: Slo,
    now: number = Date.now()
  ): Promise<SloBurnRateWindow[]> {
    const allowed = 1 - slo.target
    const { errors, transactions } = await this.stepAggregates(
      projectId,
      now - LONGEST_WINDOW_SECONDS * 1000,
      now,
      BURNRATE_STEP_SECONDS * 1000
    )

    // 把 5 分钟桶汇总成各个窗口的（总数, 错误数）
    const ratio = (windowSeconds: number): { total: number; bad: number } => {
      const from = now - windowSeconds * 1000
      let total = 0
      let bad = 0
      for (const [bucket, n] of transactions) {
        if (bucket >= from) total += n
      }
      for (const [bucket, n] of errors) {
        if (bucket >= from) bad += n
      }
      return { total, bad }
    }

    return BURNRATE_PAIRS.map((pair) => {
      const short = ratio(pair.shortSeconds)
      const long = ratio(pair.longSeconds)
      const shortBurn = burnRateOf(short.bad, short.total, allowed)
      const longBurn = burnRateOf(long.bad, long.total, allowed)
      return {
        longSeconds: pair.longSeconds,
        shortSeconds: pair.shortSeconds,
        threshold: pair.threshold,
        longBurnRate: longBurn,
        shortBurnRate: shortBurn,
        // 两个窗口同时超阈值才报 —— 这就是「多窗口」的含义
        alerting:
          longBurn !== null &&
          shortBurn !== null &&
          longBurn > pair.threshold &&
          shortBurn > pair.threshold
      }
    })
  }

  // ==========================================================
  // 内部
  // ==========================================================

  /**
   * 按步聚合错误数与请求数。
   *
   * ⚠️ 两边的时间列不一样：错误用 `occurred_at`（发生时间），
   *    请求用 `started_at`（开始时间）—— 各用它自己的语义。
   */
  private async stepAggregates(
    projectId: number,
    since: number,
    until: number,
    stepMs: number
  ): Promise<{ errors: Map<number, number>; transactions: Map<number, number> }> {
    const errorRows = await this.db.all<{ bucket: number; n: number }>(
      `SELECT ${bucketExpr('occurred_at', stepMs)} AS bucket, COUNT(*) AS n
       FROM issue_events
       WHERE project_id = ? AND occurred_at >= ? AND occurred_at < ?
       GROUP BY bucket`,
      [projectId, since, until]
    )
    const txRows = await this.db.all<{ bucket: number; n: number }>(
      `SELECT ${bucketExpr('started_at', stepMs)} AS bucket, COUNT(*) AS n
       FROM transactions
       WHERE project_id = ? AND started_at >= ? AND started_at < ?
       GROUP BY bucket`,
      [projectId, since, until]
    )

    return {
      errors: new Map(errorRows.map((r) => [r.bucket, r.n])),
      transactions: new Map(txRows.map((r) => [r.bucket, r.n]))
    }
  }
}

// ============================================================
// 类型与常量
// ============================================================

interface SloRow {
  id: number
  project_id: number
  name: string
  metric: string
  target: number
  window_seconds: number
  step_seconds: number
  enabled: number | boolean
  created_at: number
  updated_at: number
}

export interface SloBurnRateWindow {
  /** 长窗口长度（秒） */
  longSeconds: number
  /** 短窗口长度（秒） */
  shortSeconds: number
  /** 燃烧率阈值 */
  threshold: number
  longBurnRate: number | null
  shortBurnRate: number | null
  /** 两个窗口同时超阈值 */
  alerting: boolean
}

/**
 * 长短窗口配对与阈值。
 *
 * 阈值来自 SRE 手册：短窗口的燃烧率要**大得多**才算紧急
 * —— 1 小时烧掉 14.4 倍预算，也就是「1 天烧完 1 个月预算」的速度。
 */
const BURNRATE_PAIRS: Array<{
  longSeconds: number
  shortSeconds: number
  threshold: number
}> = [
  { longSeconds: 3 * 86400, shortSeconds: 6 * 3600, threshold: 1 },
  { longSeconds: 86400, shortSeconds: 2 * 3600, threshold: 3 },
  { longSeconds: 6 * 3600, shortSeconds: 30 * 60, threshold: 6 },
  { longSeconds: 3600, shortSeconds: 5 * 60, threshold: 14.4 }
]

/** 燃烧率窗口配对里最长的窗口 */
const LONGEST_WINDOW_SECONDS = 3 * 86400
/** 燃烧率计算用的分桶粒度（5 分钟） */
const BURNRATE_STEP_SECONDS = 300

function toSlo(row: SloRow): Slo {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    metric: row.metric as SloMetric,
    target: row.target,
    windowSeconds: row.window_seconds,
    stepSeconds: row.step_seconds,
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 目标值必须在 (0, 1] 之间 —— 0 会让预算除零 */
function clampTarget(target: number): number {
  if (!Number.isFinite(target) || target <= 0 || target > 1) {
    throw AppError.badRequest('SLO 目标值必须在 (0, 1] 之间')
  }
  return target
}

/** 窗口至少 5 分钟，最多 90 天 */
function clampWindow(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 300 || seconds > 90 * 86400) {
    throw AppError.badRequest('SLO 窗口必须在 5 分钟到 90 天之间')
  }
  return Math.round(seconds)
}

/** 步长必须整除窗口，否则尾部会剩半步 */
function normalizeStep(stepSeconds: number, windowSeconds: number): number {
  if (!Number.isFinite(stepSeconds) || stepSeconds < 60) {
    throw AppError.badRequest('SLO 步长至少 1 分钟')
  }
  const step = Math.round(stepSeconds)
  if (windowSeconds % step !== 0) {
    throw AppError.badRequest('SLO 步长必须整除窗口长度')
  }
  return step
}

/** 默认步长：窗口的 1/720，至少 1 分钟 —— 720 步是「偶发一次只掉 0.14%」的经验值 */
function defaultStep(windowSeconds: number): number {
  const raw = windowSeconds / 720
  const min = 60
  // 向下取到能整除窗口的步长
  let step = Math.max(min, Math.floor(raw))
  while (windowSeconds % step !== 0 && step > min) step--
  return step
}

/** 燃烧率：实际错误率 / 允许错误率 */
function burnRateOf(bad: number, total: number, allowed: number): number | null {
  if (total === 0 || allowed <= 0) return null
  return bad / total / allowed
}

/**
 * 状态判定。
 *
 * - **exhausted**：预算用完了（消耗超过允许）
 * - **at_risk**：要么 SLI 没达标，要么烧得比预期快
 * - **healthy**：其余
 */
function statusOf(input: {
  slo: Slo
  sli: number | null
  burnRate: number | null
  budgetRemaining: number
  bad: number
}): SloStatus {
  if (input.bad > 0 && input.budgetRemaining <= 0) return 'exhausted'
  if (input.sli !== null && input.sli < input.slo.target) return 'at_risk'
  if (input.burnRate !== null && input.burnRate > 1) return 'at_risk'
  return 'healthy'
}
