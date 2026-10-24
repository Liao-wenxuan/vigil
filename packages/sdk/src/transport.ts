import type { CollectEnvelope, ErrorEvent } from '@vigil/protocol'
import { SDK_NAME, SDK_VERSION } from './version'

/**
 * 上报传输层。
 *
 * 这里有两个**不能用同一套代码**的通道，原因是浏览器的硬约束：
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ sendBeacon                                                 │
 * │   ✓ 页面卸载时也能把请求发出去                              │
 * │   ✗ **不能自定义 header**                                   │
 * │   ✗ payload 有大小上限（各浏览器 64KB 左右）                 │
 * │   ✗ 拿不到响应（fire-and-forget）                            │
 * ├─────────────────────────────────────────────────────────────┤
 * │ fetch                                                       │
 * │   ✓ 能带 header（token 走这里，不进 body）                  │
 * │   ✓ 拿得到响应，能确认服务端收没收��                          │
 * │   ✗ 页面卸载时可能被浏览器掐掉                             │
 * │   ✗ keepalive 的 body 也有 64KB 上限                        │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 所以：
 * - **正常时**用 fetch —— token 放 header，服务端拿 header 校验，
 *   body 里不出现 token，就不会进访问日志。
 * - **页面要卸载时**用 sendBeacon —— 反正拿不到响应，就把 token 放进 body。
 *   服务端两条路都接受。
 *
 * 64KB 上限不是厂商吹的：Chromium 的 sendBeacon 和 fetch keepalive
 * 都是这个量级。所以 maxPayloadBytes 默认取 48KB，留出信封开销的余量。
 */
export interface TransportOptions {
  /** 采集接口地址 */
  endpoint: string
  appId: string
  token: string
  /** 单个请求体的字节上限 */
  maxPayloadBytes: number
  /** 单批最多多少条 */
  maxBatchSize: number
  /** 原始 fetch —— 必须在网络采集器打补丁之前抓下来 */
  fetchImpl: typeof fetch
  /** sendBeacon，不支持时留空 */
  beaconImpl?: (url: string, data: Blob) => boolean
}

/** 信封的固定开销估算（appId + token + sdk + JSON 结构） */
const ENVELOPE_OVERHEAD = 512

/**
 * 把事件按体积和条数切批。
 *
 * 为什么要切：一条错误可能带很长的栈和一堆 context，
 * 一批凑一起超过 64KB 就会被浏览器**静默丢弃** —— 不报错、不重试，
 * 数据就这么没了。宁可多发几个小请求，也不能让浏览器替我们做丢弃决策。
 */
export function splitIntoBatches(
  events: ErrorEvent[],
  maxPayloadBytes: number,
  maxBatchSize: number
): ErrorEvent[][] {
  const limit = Math.max(1024, maxPayloadBytes - ENVELOPE_OVERHEAD)
  const batches: ErrorEvent[][] = []

  let current: ErrorEvent[] = []
  let currentSize = 0

  for (const event of events) {
    let size = 0
    try {
      size = JSON.stringify(event).length
    } catch {
      // 循环引用等导致序列化失败 —— 算它 1KB，不让它卡住整批
      size = 1024
    }

    const exceedsSize = current.length > 0 && currentSize + size > limit
    const exceedsCount = current.length >= maxBatchSize

    if (exceedsSize || exceedsCount) {
      batches.push(current)
      current = []
      currentSize = 0
    }

    current.push(event)
    currentSize += size
  }

  if (current.length > 0) batches.push(current)
  return batches
}

/** 构造上报信封 */
export function buildEnvelope(events: ErrorEvent[], appId: string): CollectEnvelope {
  return {
    appId,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    events
  }
}

/**
 * 发一批事件。
 *
 * @param preferBeacon true = 页面正在卸载，优先用 beacon 保住数据
 * @returns 是否成功送达（beacon 只能返回「浏览器收下了」，拿不到服务端确认）
 */
export async function sendBatch(
  events: ErrorEvent[],
  options: TransportOptions,
  preferBeacon = false
): Promise<boolean> {
  if (events.length === 0) return true

  if (preferBeacon && options.beaconImpl && typeof Blob !== 'undefined') {
    try {
      // beacon 不能设 header → token 必须放 body
      const body = JSON.stringify({ ...buildEnvelope(events, options.appId), token: options.token })
      const blob = new Blob([body], { type: 'application/json' })
      if (options.beaconImpl(options.endpoint, blob)) return true
      // beacon 失败（多半是 payload 超限）→ 落到下面的 fetch 重试
    } catch {
      // 落到 fetch
    }
  }

  const body = JSON.stringify(buildEnvelope(events, options.appId))

  try {
    const response = await options.fetchImpl(options.endpoint, {
      method: 'POST',
      body,
      // keepalive 让请求在页面关闭后仍有机会发完
      keepalive: true,
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'X-Vigil-App-Id': options.appId,
        'X-Vigil-Token': options.token
      }
    })
    return response.ok
  } catch {
    return false
  }
}
