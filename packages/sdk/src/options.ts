import type { HttpErrorPolicy } from './collectors/network'

/**
 * SDK 配置项。
 *
 * 单独抽出来是为了让 `plugin.ts` 也能引用而不产生循环依赖
 * （plugin → options，index → plugin + options）。
 */

/** 默认参数 */
export const DEFAULTS = {
  /** 会话采样率。默认 1 = 全量 */
  sampleRate: 1,
  /**
   * 性能采样率。默认 0.1 = 只上报 10% 的页面加载。
   *
   * 性能数据和错误数据的性质完全不同：错误少但每条都重要，
   * 性能多且绝大多数正常 —— 全量上报会打爆存储和带宽。
   */
  performanceSampleRate: 0.1,
  /** 是否采集性能数据 */
  enablePerformance: true,
  /** 白屏判定超时（毫秒） */
  blankScreenTimeoutMs: 3000,
  /** 最多保留多少条面包屑 */
  maxBreadcrumbs: 30,
  /** 定时上报间隔 */
  flushIntervalMs: 5000,
  /** 一批最多几条 */
  maxBatchSize: 20,
  /** 单请求体上限。浏览器对 beacon / keepalive 的限制都是 64KB 量级 */
  maxPayloadBytes: 48 * 1024,
  /** 哪些 HTTP 状态算错误 */
  httpErrorPolicy: '5xx' as HttpErrorPolicy,
  /** 是否采集 console 输出作为面包屑 */
  captureConsoleBreadcrumbs: true,
  /** 开关 */
  enabled: true,
  debug: false
}

export interface VigilOptions {
  /** 采集接口完整地址，例如 https://collector.example.com/api/v1/collect */
  endpoint: string
  /** 应用 ID */
  appId: string
  /** 运行时 token */
  token: string
  /** 发布版本，用于区分「这个错误是哪个版本引入的」 */
  release?: string
  /** 运行环境：production / staging / development */
  environment?: string
  /** 当前用户 ID（可后续用 setUser 更新） */
  userId?: string
  /**
   * 会话采样率（0~1）。
   *
   * 采样是**按会话**决定的，不按单条事件随机抽 —— 随机抽事件会得到
   * 「同一个用户只上报了部分错误」的残缺上下文，比不采样更误导。
   * 整个会话要么全采要么全不采，采中的会话里每一条错误都在。
   */
  sampleRate?: number
  /**
   * 性能采样率（0~1），默认 0.1。
   *
   * 性能数据量大且绝大多数正常，必须采样；错误数据则默认全量。
   */
  performanceSampleRate?: number
  /** 是否采集性能数据，默认 true */
  enablePerformance?: boolean
  /** 白屏判定超时（毫秒），默认 3000 */
  blankScreenTimeoutMs?: number
  maxBreadcrumbs?: number
  flushIntervalMs?: number
  maxBatchSize?: number
  maxPayloadBytes?: number
  httpErrorPolicy?: HttpErrorPolicy
  captureConsoleBreadcrumbs?: boolean
  enabled?: boolean
  debug?: boolean
  /**
   * 插件列表。
   *
   * 会话回放、用户行为都是插件 —— 核心不含它们的代码，
   * 用户按需引入独立入口。
   */
  plugins?: import('./plugin.js').VigilPlugin[]
}

export interface ResolvedOptions {
  endpoint: string
  appId: string
  token: string
  release?: string
  environment?: string
  userId?: string
  sampleRate: number
  performanceSampleRate: number
  enablePerformance: boolean
  blankScreenTimeoutMs: number
  maxBreadcrumbs: number
  flushIntervalMs: number
  maxBatchSize: number
  maxPayloadBytes: number
  httpErrorPolicy: HttpErrorPolicy
  captureConsoleBreadcrumbs: boolean
  enabled: boolean
  debug: boolean
  plugins: import('./plugin.js').VigilPlugin[]
}
