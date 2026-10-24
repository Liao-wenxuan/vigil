/**
 * 令牌桶限流。
 *
 * 为什么按应用限流而不是按 IP：
 * 上报请求来自**用户的浏览器**，IP 是用户的不是应用的。
 * 同一公司出口 IP 后面可能有几百个用户，按 IP 限流会误伤；
 * 而一个失控的应用（比如死循环抛异常）会打爆整个采集服务。
 * 按 appId 限流才能精确隔离「谁把服务打满了」。
 *
 * 为什么用令牌桶而不是固定窗口：
 * 固定窗口在窗口边界会出现双倍流量（末尾打满 + 开头打满）。
 * 令牌桶允许一定程度的突发，同时把长期速率钉死。
 *
 * ⚠️ 内存实现：进程重启后计数清零，且多实例部署时各算各的。
 *    单机部署够用；要横向扩展得换成 Redis 之类的共享存储。
 */
export interface RateLimitOptions {
  /** 桶容量：允许的突发量 */
  capacity: number
  /** 每秒补充速率 */
  refillPerSecond: number
}

interface Bucket {
  tokens: number
  last: number
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly options: RateLimitOptions) {}

  /**
   * 尝试取用令牌。
   *
   * @returns true = 放行，false = 超出配额，调用方应该丢弃或降级
   */
  take(key: string, cost = 1): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.options.capacity, last: now }

    const elapsedSeconds = (now - bucket.last) / 1000
    bucket.tokens = Math.min(
      this.options.capacity,
      bucket.tokens + elapsedSeconds * this.options.refillPerSecond
    )
    bucket.last = now

    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket)
      return false
    }

    bucket.tokens -= cost
    this.buckets.set(key, bucket)
    return true
  }

  /** 清理长时间没活动的桶，防止 Map 无限增长 */
  sweep(maxIdleMs = 10 * 60 * 1000): number {
    const now = Date.now()
    let removed = 0
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last > maxIdleMs) {
        this.buckets.delete(key)
        removed++
      }
    }
    return removed
  }

  /** 当前桶数量（测试用） */
  get size(): number {
    return this.buckets.size
  }
}
