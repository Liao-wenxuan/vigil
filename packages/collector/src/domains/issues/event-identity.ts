import { createHash } from 'node:crypto'
import type { ErrorEvent } from '@vigil/protocol'

/**
 * 事件身份：一条错误事件的唯一 ID。
 *
 * ## 这个 ID 是干什么的
 *
 * 服务端用它**去重**：SDK 因为网络重试把同一条事件发了两遍时，
 * 第二遍要被认出来并丢掉，否则 Issue 的 count 会虚高。
 *
 * ## 判据：内容相同才算同一条
 *
 * 哈希必须覆盖**所有能区分事件的内容**。
 *
 * ⚠️ 之前只哈希了「指纹 + 时间 + 用户 + 会话 + URL」，漏掉了 release。
 *    后果不是「偶尔去重多了」，而是**回归检测被绕过**：
 *    同一毫秒内、同一个会话、同一个 URL 的同一条错误，
 *    但来自不同版本 —— 两条会算出同一个 ID，第二条被当成重试丢掉。
 *    于是「1.4.3 修好的问题在 1.4.4 重新出现」根本进不了状态机，
 *    Issue 一直停在 resolved，永远不会变成 regressed。
 *
 *    这个 bug 极难被发现：它只在「两次上报落在同一毫秒」时触发，
 *    表现为**偶发**的测试失败，而且失败信息指向状态机，跟去重毫无关系。
 *
 * ## 为什么序列化要排序键
 *
 * 客户端的 JSON 序列化方式不统一（有人按键排序，有人不排）。
 * 如果直接 `JSON.stringify(event)`，同一条事件的两次重传
 * 可能因为键顺序不同算出两个 ID —— 去重就失效了，count 会虚高。
 *
 * 排序后：
 * - **键顺序不影响结果** → 换序列化方式也不会把重试变成新事件
 * - **内容有任何不同 → ID 就不同** → 不会误判成重试
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * 没有 eventId 时生成一个可去重的 ID。
 *
 * 客户端自己带了 `eventId` 就用客户端的（SDK 用的是随机 UUID）。
 * 只有直接调 API、没带 ID 的客户端才走这里。
 *
 * @param occurredAt 服务端认定的发生时间（事件自带时用自带的，否则用当前时间）
 */
export function generateEventId(event: ErrorEvent, occurredAt: number): string {
  return createHash('sha256')
    .update(`${occurredAt}|${canonicalJson(event)}`)
    .digest('hex')
    .slice(0, 32)
}
