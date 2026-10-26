import type { EventContext, Tag } from './common.js'

/**
 * 性能（RUM）事件的线上契约。
 *
 * 性能数据和错误数据是**两种不同性质**的数据，处理方式也不同：
 *
 * | | 错误 | 性能 |
 * |---|---|---|
 * | 量级 | 少，但每条都重要 | 多，绝大多数是正常的 |
 * | 上报策略 | 实时、不可丢 | 采样 + 节流 |
 * | 聚合方式 | 按指纹聚成 Issue | 按时间桶算分位数 |
 *
 * 所以性能**不能**塞进错误事件里 —— 采样策略、保留周期、聚合方式全都不同。
 */

/** 事务类型 */
export type TransactionType = 'page' | 'route' | 'custom'

/** span 类型 */
export type SpanType = 'http' | 'resource' | 'dom' | 'custom'

/**
 * Core Web Vitals 与辅助指标。
 *
 * - FCP / LCP：加载阶段
 * - CLS / INP：交互阶段（INP 已取代 FID）
 * - TTFB：服务端响应
 * - TBT：主线程阻塞总时长（Long Task 累计）
 */
export interface VitalMetrics {
  /** 首次内容绘制 */
  fcp?: number
  /** 最大内容绘制 */
  lcp?: number
  /** 累计布局偏移 */
  cls?: number
  /** 交互到下次绘制 */
  inp?: number
  /** 首字节时间 */
  ttfb?: number
  /** 总阻塞时间 */
  tbt?: number
  /** 长任务数量 */
  longTaskCount?: number
}

/** 一个 span：一次接口请求、一个资源加载、一段 DOM 操作 */
export interface Span {
  name: string
  type: SpanType
  durationMs: number
  startedAt?: number
  statusCode?: number
  url?: string
  sizeBytes?: number
  /** 资源发起类型：script / link / img / fetch … */
  initiatorType?: string
}

/**
 * 一个性能事务 = 一次页面加载或一次路由切换。
 *
 * 事务是**性能数据的聚合单元**：所有 vitals 和 spans 都挂在一个事务下。
 */
export interface PerformanceEvent {
  /** 事务名，通常是路由路径或页面名 */
  name: string
  type: TransactionType
  /** 事务开始时刻（epoch ms） */
  startedAt: number
  /** 事务总耗时 */
  durationMs: number

  vitals: VitalMetrics
  /** 子 span */
  spans?: Span[]

  /** 资源汇总 */
  resourceCount?: number
  transferSize?: number

  pageUrl: string
  referrer?: string
  userAgent: string
  locale?: string
  timezone?: string
  viewport?: { width: number; height: number }
  connection?: {
    effectiveType?: string
    downlink?: number
    rtt?: number
    type?: string
  }

  sessionId: string
  userId?: string
  release?: string
  environment?: string

  tags?: Tag[]
}

/** 性能上报信封 —— 和错误分开走独立的入口与采样策略 */
export interface PerformanceEnvelope {
  appId: string
  token?: string
  sdk: { name: string; version: string }
  transactions: PerformanceEvent[]
}

export interface PerformanceResponse {
  ok: boolean
  accepted?: number
  dropped?: number
  error?: string
}

/** 分位数结果 */
export interface Percentiles {
  count: number
  p50: number
  p75: number
  p95: number
  p99: number
  min: number
  max: number
  avg: number
}

/** 性能汇总行 */
export interface PerformanceSummary extends EventContext {
  projectId?: number
  environment?: string
}
