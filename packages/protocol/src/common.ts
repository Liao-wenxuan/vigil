/**
 * 通用基础类型。
 */

/** 视口尺寸 */
export interface Viewport {
  width: number
  height: number
}

/** 网络连接信息（Navigator.connection 不在标准 DOM 类型里） */
export interface ConnectionInfo {
  effectiveType?: string
  downlink?: number
  rtt?: number
  type?: string
}

/** 通用上下文：任何事件都带的那部分 */
export interface EventContext {
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
}

/**
 * 自定义标签。
 *
 * 标签是**可搜索、可过滤**的结构化数据 —— 与 context（不可搜索的补充信息）
 * 的区别就在这里。企业级平台的价值在于「能筛」，
 * 所以标签必须是一等公民，不能塞进 context 里当字符串。
 */
export interface Tag {
  key: string
  value: string
}
