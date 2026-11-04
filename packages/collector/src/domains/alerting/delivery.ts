import type { AlertDelivery } from '@vigil/protocol'
import { getSender, type ChannelConfig } from './channels.js'
import type { AlertingService } from './service.js'

/**
 * 告警投递 worker。
 *
 * ## 为什么要有独立的 worker
 *
 * 告警评估是**同步**的 —— 它要扫规则、算窗口、判触发。
 * 如果评估还要**等通道把 HTTP 请求发完**，那么：
 * - 一个卡住的 webhook（对方不响应）会把整轮评估拖住
 * - 规则一多、通道一慢，告警引擎就整体卡死
 * - 更糟的是：**评估被拖住 → 下一轮也排不上 → 告警彻底停摆**
 *
 * 所以评估只做两件事：判触发、**入队**。真正的发送交给这个 worker，
 * 它有自己的循环，慢了也只影响自己。
 *
 * ## 重试策略
 *
 * 两层，各管各的：
 * - **发送内部**（`channels.ts`）：几秒内的抖动，立刻重试 —— 95% 的临时故障在这层就恢复了
 * - **worker 跨轮**（这里）：几分钟以上的 outages，排到后面再试 —— 重试**持久化**在库里，
 *   进程重启也不会丢
 *
 * 退避：1 分钟 → 5 分钟 → 30 分钟 → 2 小时 → 12 小时，用完就是死信。
 */

/** 跨轮重试的退避序列（毫秒） */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000]

/** 最多试几轮（1 次首发 + 5 次重试） */
const MAX_ATTEMPTS = BACKOFF_MS.length + 1

export interface DispatchReport {
  /** 成功送达 */
  sent: number
  /** 失败但还会再试 */
  retrying: number
  /** 重试用尽，转死信 */
  dead: number
  /** 通道已不存在，直接转死信 */
  orphaned: number
}

export class DeliveryWorker {
  constructor(private readonly alerting: AlertingService) {}

  /**
   * 跑一轮投递。
   *
   * @param now 当前时间（测试可以传固定值）
   * @param limit 一轮最多处理多少条
   */
  async runOnce(now: number = Date.now(), limit = 20): Promise<DispatchReport> {
    const report: DispatchReport = { sent: 0, retrying: 0, dead: 0, orphaned: 0 }

    const pending = await this.alerting.listPendingDeliveries(now, limit)
    for (const delivery of pending) {
      const outcome = await this.deliver(delivery, now)
      report[outcome]++
    }

    return report
  }

  private async deliver(
    delivery: AlertDelivery,
    now: number
  ): Promise<'sent' | 'retrying' | 'dead' | 'orphaned'> {
    // 通道被删了 → 直接死信，别无限重试
    if (delivery.channelId === undefined) {
      await this.alerting.markDelivery(delivery.id, 'dead', '通道已被删除，无法投递')
      return 'orphaned'
    }

    let channel
    try {
      channel = await this.alerting.getChannel(delivery.projectId, delivery.channelId)
    } catch {
      await this.alerting.markDelivery(delivery.id, 'dead', '通道已被删除，无法投递')
      return 'orphaned'
    }

    if (!delivery.message) {
      await this.alerting.markDelivery(delivery.id, 'dead', '投递记录缺少消息内容')
      return 'dead'
    }

    const result = await getSender(channel.type).send(
      channel.config as ChannelConfig,
      delivery.message
    )

    if (result.ok) {
      await this.alerting.markDelivery(delivery.id, 'sent')
      return 'sent'
    }

    // 失败：按退避排下一次；用完就是死信
    const attempts = delivery.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await this.alerting.markDelivery(delivery.id, 'dead', result.error, { attempts })
      return 'dead'
    }

    const backoff = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
    await this.alerting.markDelivery(delivery.id, 'pending', result.error, {
      attempts,
      nextAttemptAt: now + backoff
    })
    return 'retrying'
  }
}
