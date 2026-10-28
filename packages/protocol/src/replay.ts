/**
 * 会话回放与用户行为的线上契约。
 *
 * ## 为什么回放是独立的一套类型，不复用错误事件
 *
 * 回放事件流是**rrweb 的格式**（事实标准，别的回放工具也认），
 * 它的体积比错误事件大两个数量级。
 * 混在一起的话：错误事件的采样、保留、批量策略会被回放拖垮。
 *
 * 所以：回放和错误**分开上报**，只在「某次错误发生时」关联起来。
 */

/**
 * 一条 rrweb 事件。
 *
 * rrweb 的事件是判别联合（type + data），这里保持原样透传，
 * 不做二次建模 —— 建模就等于把自己绑死在 rrweb 的某个版本上。
 */
export interface ReplayEvent {
  type: number
  data: unknown
  timestamp: number
}

/**
 * 一次错误发生时的回放快照。
 *
 * 关键点：事件流是**连续**的（一个 full snapshot + 后续增量），
 * 中间不能丢 —— 丢一段后面全播不了。所以缓冲区满了只能**重新取快照**，
 * 不能丢中间的。
 */
export interface ReplayPayload {
  /** 事件流 */
  events: ReplayEvent[]
  /** 因为超预算被丢弃的段数（数据有缺口，要如实告知） */
  droppedSegments?: number
  /** 序列化后的大致字节数 */
  bytes?: number
}

/** 行为事件类型 */
export type BehaviorType = 'pageview' | 'route' | 'click' | 'blur' | 'focus'

/**
 * 一条用户行为事件。
 *
 * 注意**不记录输入内容** —— 只记「点了某个按钮」，
 * 不记「在搜索框里输入了 xxx」。隐私边界画在这里。
 */
export interface BehaviorEvent {
  type: BehaviorType
  /** 事件名：路由路径、元素标签、路由名 */
  name: string
  /** 触发时的页面地址 */
  url: string
  timestamp: number
  /** 停留时长（pageview 的下一次事件间隔） */
  durationMs?: number
  /** 所属会话 —— 服务端按它归属到会话 */
  sessionId?: string
  /** 用户标识 */
  userId?: string
  data?: Record<string, unknown>
}

/** 一次会话的汇总 */
export interface SessionSummary {
  sessionId: string
  userId?: string
  startedAt: number
  endedAt: number
  durationMs: number
  pageViews: number
  /** 该会话的错误数 */
  errorCount?: number
  /** 首次进入的页面 */
  entryPage?: string
  /** 最后离开的页面 */
  exitPage?: string
  /** 访问路径 */
  path?: string[]
  /**
   * 原始 UA。
   *
   * 浏览器 / 系统 / 设备由**服务端**解析 —— SDK 里再实现一份 UA 解析
   * 只会带来两份实现漂移的风险，而服务端本来就要解析（给 Issue 用）。
   */
  userAgent?: string
  referrer?: string
}

/** 行为上报信封 */
export interface BehaviorEnvelope {
  appId: string
  token?: string
  sdk: { name: string; version: string }
  events: BehaviorEvent[]
  session?: SessionSummary
}

/** 行为汇总（服务端算好的，给面板直接用） */
export interface BehaviorSummary {
  /** 总访问次数 */
  pageViews: number
  /** 去重会话数 */
  sessions: number
  /** 去重用户数 */
  users: number
  /** 平均停留时长 */
  avgDurationMs: number
  /** 按页面聚合 */
  topPages: Array<{ path: string; views: number; avgDurationMs: number; bounceRate: number }>
  /** 入口页 / 出口页 */
  entryPages: Array<{ path: string; count: number }>
  exitPages: Array<{ path: string; count: number }>
  /** 访问路径（前 N 步） */
  topPaths: Array<{ path: string[]; count: number }>
  /** 点击分布 */
  clicks: Array<{ name: string; count: number }>
  /** 按天分桶的趋势 */
  trend: Array<{ date: string; views: number; sessions: number }>
}
