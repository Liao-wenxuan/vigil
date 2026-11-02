/**
 * SLO（服务水平目标）与错误预算的线上契约。
 *
 * ## 这套模型在回答什么
 *
 * 「错误率涨了」是**症状**；「这个月还能不能发布」是**决策**。
 * SLO 就是把后者变成可计算的：
 *
 * - **目标（SLO）**：这段时间内，这个指标要达到什么水平
 * - **SLI**：实际达到了多少（窗口内的达标比例）
 * - **错误预算**：还允许出多少错（= (1 - 目标) × 请求数）
 * - **燃烧率**：预算烧得比预期快多少倍（> 1 就是超额消耗）
 *
 * ## 为什么 SLI 要**分步**判定
 *
 * 朴素做法是「窗口内总错误数 / 总请求数」。但那样一来，
 * 窗口里 99.99% 的时间完全正常、最后 1 分钟全崩，SLI 看起来还是 99.99% ——
 * 而用户那 1 分钟全在挨骂。
 *
 * 标准做法（Google SRE 手册）是**把窗口切成小步，每步单独判定达标**，
 * 整体 SLI = 达标步数 / 总步数。这样「最后 1 分钟全崩」会被如实反映。
 *
 * ## 无数据的步怎么算
 *
 * 一步里**没有任何流量**时，这一步既不算达标也不算不达标 ——
 * 直接跳过。理由：没流量的时候「错误率是 0」和「没访问过」是两回事
 * （与趋势域的 `errorRate: null` 是同一个原则）。
 *
 * ## 时间范围
 *
 * SLO 的窗口是**滑动**的：`[now - windowSeconds, now)`。
 * 与普通查询不同，SLO 的窗口**总是有界**的 ——
 * 「全部时间」没有预算可言。
 */

/** SLO 指标类型 */
export type SloMetric = 'error_rate'

/** SLO 的健康状态 */
export type SloStatus = 'healthy' | 'at_risk' | 'exhausted'

/** 一条 SLO 定义 */
export interface Slo {
  id: number
  projectId: number
  /** 展示名 */
  name: string
  /** 指标类型 */
  metric: SloMetric
  /**
   * 目标值（0~1）。
   *
   * `0.999` 表示「99.9% 的请求要正常」。
   */
  target: number
  /** 评估窗口长度（秒）。滑动窗口 */
  windowSeconds: number
  /**
   * 分步粒度（秒）。
   *
   * 窗口被切成 `windowSeconds / stepSeconds` 步，每步单独判定达标。
   */
  stepSeconds: number
  /** 是否启用 */
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** SLO 的当前状态（评估结果） */
export interface SloEvaluation {
  sloId: number
  /** 健康状态 */
  status: SloStatus
  /** 评估窗口起点（epoch 毫秒，左闭） */
  windowStart: number
  /** 评估窗口终点（epoch 毫秒，右开） */
  windowEnd: number
  /** 窗口内参与判定的步数（跳过无流量���步） */
  evaluatedSteps: number
  /** 窗口内跳过的步数（无流量） */
  skippedSteps: number
  /** 达标步数 */
  goodSteps: number
  /** 窗口内的页面访问总数（错误率的分母） */
  total: number
  /** 窗口内的错误发生总数 */
  bad: number
  /**
   * 服务水平指标（0~1）—— 达标步数 / 参与判定的步数。
   *
   * 这是**时间口径**：窗口里有多少比例的时间是达标的。
   * 没有可判定的步时是 `null`（不是 1）。
   */
  sli: number | null
  /**
   * 整体错误率（0~1+）—— 窗口内错误数 / 请求数。
   *
   * 这是**事件口径**。和 `sli` 是同一份数据的两个视角：
   * `sli` 关心「有多少比例的时间没问题」，错误率关心「平均有多糟」。
   * 预算与燃烧率用的是这个（事件口径）。
   */
  errorRatio: number | null
  /** 错误预算总量（允许的错误数） */
  budgetTotal: number
  /** 剩余预算（可为负） */
  budgetRemaining: number
  /** 预算消耗比例（0~1+）。没有请求时是 null */
  budgetConsumedRatio: number | null
  /**
   * 燃烧率 —— 错误率 / (1 - 目标)。
   *
   * 1 表示「正好按预期速度消耗预算」，> 1 表示烧得更快。
   * 没有请求时是 `null`。
   */
  burnRate: number | null
}

/** 预算消耗趋势的一个点（按分步粒度） */
export interface SloBudgetPoint {
  /** 该步的起始时间（epoch 毫秒） */
  timestamp: number
  /** 该步内的页面访问数 */
  total: number
  /** 该步内的错误发生数 */
  bad: number
  /** 该步的错误率（分母为 0 时是 null） */
  errorRate: number | null
  /** 该步是否达标 */
  compliant: boolean
  /** 该步结束时的累计预算消耗比例 */
  consumedRatio: number | null
}

/** 预算消耗趋势 */
export interface SloBudgetSeries {
  sloId: number
  points: SloBudgetPoint[]
}
