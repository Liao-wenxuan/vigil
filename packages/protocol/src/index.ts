/**
 * Vigil 上报协议（wire format）
 *
 * 这个包**只有类型，没有运行时值**。SDK 和 Collector 都从这里 import type，
 * 编译后完全擦除 —— 所以：
 *   - 不会给 SDK 增加任何产物体积
 *   - 不会引入构建顺序依赖（protocol 不需要 build）
 *   - 但两边对「一条错误长什么样」的理解永远一致
 *
 * ⚠️ 改动这里 = 改动线上协议。Collector 侧必须同步改解析逻辑，
 *    否则老 SDK 上报的数据会解析失败。
 */

/**
 * 错误分类 —— 决定指纹怎么算、后台怎么分组。
 *
 * 与 ErrorKind 的区别是**分组维度**：
 * 一个 Vue 组件里抛出的错误，kind 是 'vue'，category 是 'javascript'。
 * 如果 kind 进了指纹，同一个 bug 走 Vue 捕获和走全局捕获会分成两条。
 */
export type ErrorCategory = 'javascript' | 'resource' | 'http'

/**
 * 采集来源 —— 只用于说明「这条是谁抓到的」，**不参与指纹计算**。
 */
export type ErrorKind = 'js' | 'promise' | 'resource' | 'http' | 'vue' | 'manual'

export type BreadcrumbType = 'navigation' | 'click' | 'console' | 'xhr' | 'fetch' | 'custom' | 'vue'

export interface Breadcrumb {
  type: BreadcrumbType
  category: string
  message?: string
  data?: Record<string, unknown>
  timestamp: number
}

/** 上报前解析出来的栈帧（未做 sourcemap 还原） */
export interface StackFrame {
  filename: string
  lineno?: number
  colno?: number
  functionName?: string
}

/** Collector 用 sourcemap 还原后的原始位置 */
export interface ResolvedPosition {
  filename: string
  lineno: number
  colno: number
  functionName?: string
  source?: string
}

export interface Viewport {
  width: number
  height: number
}

export interface ConnectionInfo {
  effectiveType?: string
  downlink?: number
  rtt?: number
  type?: string
}

export interface ResourceInfo {
  /** 标签名：img / script / link / video … */
  tag: string
  /** 已脱敏的资源地址 */
  src: string
  /** 推断出的资源类型：script / stylesheet / image / media / font */
  type: string
}

export interface HttpInfo {
  method: string
  /** 已脱敏的请求地址（不含 query） */
  url: string
  status: number
  durationMs?: number
  /** 请求体摘要（已脱敏、已截断） */
  requestBody?: string
  /** 响应体摘要（已脱敏、已截断） */
  responseBody?: string
}

/**
 * 一条错误事件。
 *
 * 设计取舍：
 * - `stack` 保留**原始字符串**，服务端用它做 sourcemap 还原。
 *   浏览器端的栈是压缩过的（index-abc123.js:1:2345），不还原等于没有栈。
 * - `frames` 是尽力解析出来的结构化帧，作为没有 sourcemap 时的降级展示。
 * - 所有可能含用户数据的字段（url / referrer / message / stack）都已在 SDK 侧脱敏。
 */
export interface ErrorEvent {
  category: ErrorCategory
  kind: ErrorKind
  /** 错误名，如 TypeError / ReferenceError */
  name?: string
  message: string
  stack?: string
  frames: StackFrame[]
  /** 客户端算好的指纹，服务端直接用它做聚合键 */
  fingerprint: string

  /** 触发时的页面地址（已脱敏） */
  url: string
  referrer?: string
  userAgent: string
  locale?: string
  timezone?: string
  viewport?: Viewport
  screen?: Viewport
  connection?: ConnectionInfo

  /** 会话 ID：同一个标签页内跨路由保持不变 */
  sessionId: string
  userId?: string
  release?: string
  environment?: string

  /** 事件发生时刻（epoch ms） */
  occurredAt: number

  /** 业务自定义上下文 */
  context?: Record<string, unknown>
  /** 出错前的操作轨迹 */
  breadcrumbs?: Breadcrumb[]
  extra?: Record<string, unknown>

  resource?: ResourceInfo
  http?: HttpInfo
}

/** 上报信封 */
export interface CollectEnvelope {
  appId: string
  /**
   * 运行时 token。
   *
   * 只有 beacon 通道才会出现在 body 里 —— beacon 不能自定义 header。
   * fetch 通道把它放在 header，不进 body，避免被服务端访问日志记下来。
   */
  token?: string
  sdk: {
    name: string
    version: string
  }
  events: ErrorEvent[]
}

/** Collector 返回给 SDK 的响应 */
export interface CollectResponse {
  ok: boolean
  /** 成功入库的事件数 */
  accepted?: number
  /** 因限流被丢弃的事件数 */
  dropped?: number
  /** 事件 id → 服务端错误 id 的映射，方便「上报后立刻跳详情」 */
  ids?: Record<string, number>
  error?: string
}
