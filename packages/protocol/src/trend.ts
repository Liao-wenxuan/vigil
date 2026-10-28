/**
 * 时间范围与趋势的线上契约。
 *
 * ## 为什么单独一个文件
 *
 * 趋势是**跨域视图**：错误次数来自问题域，分母（页面访问数）来自性能域。
 * 它既不属于问题域，也不属于性能域 —— 硬塞进任何一个都是把边界搞脏。
 *
 * ## 时间范围的语义
 *
 * `since` / `until` 都是 **epoch 毫秒**，缺省表示「全部」。
 * 区间是**左闭右开** `[since, until)` —— 相邻区间首尾相接不重不漏。
 *
 * ## 错误率的分母
 *
 * 错误率 = 错误发生次数 / 页面访问次数。
 *
 * 分母为 0 时是 `null` 而不是 `0` —— 「没访问过所以错误率 0」和
 * 「真的没错」是两回事，混成一个数就丢掉了信息。
 */

/** 时间范围（epoch 毫秒）。缺省表示「全部」。 */
export interface TimeRange {
  since?: number
  until?: number
}

/** 趋势分桶的粒度 */
export type TrendBucket = 'hour' | 'day'

/** 趋势里的一个时间桶 */
export interface TrendPoint {
  /** 桶的**起始**时间（epoch 毫秒） */
  timestamp: number
  /** 桶内错误发生次数 */
  occurrences: number
  /** 桶内受影响的用户数（去重） */
  users: number
  /** 桶内有发生的问题数（去重） */
  issues: number
  /** 桶内首次出现的问题数 */
  newIssues: number
  /** 桶内的页面访问次数 —— 错误率的分母 */
  transactions: number
  /** 错误率（0~1）。分母为 0 时是 null */
  errorRate: number | null
}

/** 错误趋势 */
export interface ErrorTrend {
  /** 分桶粒度 */
  bucket: TrendBucket
  /** 按时间升序的桶 */
  points: TrendPoint[]
}
