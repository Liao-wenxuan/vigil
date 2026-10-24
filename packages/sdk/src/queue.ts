import type { ErrorEvent } from '@vigil/protocol'

/**
 * 事件队列。
 *
 * 为什么要有队列：每条错误单独发一个请求会把上报端打爆 —— 一个页面
 * 出 20 个错就是 20 个请求，而且它们会和你自己的业务请求抢带宽。
 * 攒一批一起发，请求数降一个数量级。
 *
 * 触发刷新的四个时机（缺一不可）：
 *   - 攒够 maxSize 条 —— 不想让用户等太久
 *   - 定时器到 —— 只有一条错误时也要能出去
 *   - 页面切到后台 / 卸载 —— 页面一关，队列里的错误就永远丢了
 *   - 手动 flush()
 */
export interface QueueOptions {
  /** 攒到多少条就立刻发 */
  maxSize: number
  /** 定时刷新间隔 */
  flushIntervalMs: number
  onFlush: (events: ErrorEvent[]) => void | Promise<void>
  onError?: (error: unknown) => void
}

export class EventQueue {
  private items: ErrorEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(private readonly options: QueueOptions) {}

  /** 当前队列长度 */
  get size(): number {
    return this.items.length
  }

  /** 启动定时器 */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.flush()
    }, this.options.flushIntervalMs)
  }

  /** 停止定时器 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 队列入队；攒够了自动触发一次刷新 */
  push(event: ErrorEvent): void {
    this.items.push(event)
    if (this.items.length >= this.options.maxSize) {
      void this.flush()
    }
  }

  /**
   * 取出全部待发事件并交给 onFlush。
   *
   * 先把 items 清空再发 —— 这样即使发送失败或耗时很久，
   * 新进来的错误也能继续入队，不会被卡住。
   */
  async flush(): Promise<void> {
    if (this.flushing) return
    if (this.items.length === 0) return

    this.flushing = true
    const batch = this.items
    this.items = []

    try {
      await this.options.onFlush(batch)
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.flushing = false
    }
  }
}
