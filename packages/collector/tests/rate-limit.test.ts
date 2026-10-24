import { afterEach, describe, expect, it, vi } from 'vitest'
import { TokenBucketLimiter } from '../src/rate-limit.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('TokenBucketLimiter', () => {
  it('容量之内放行，超出拒绝', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 0 })

    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(false)
  })

  it('不同 key 互不影响（一个应用打满不牵连别的应用）', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0 })

    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(false)
    expect(limiter.take('app_b')).toBe(true)
  })

  it('随时间补充令牌', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 })

    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(false)

    // 2 秒后补充 2 个令牌
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'))
    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(false)
  })

  it('补充不会超过容量上限（否则空闲久了会攒出巨大突发）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 100 })

    limiter.take('app_a')
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))

    // 60 秒 × 100/s 远超容量，但仍只能拿到 2 个
    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(true)
    expect(limiter.take('app_a')).toBe(false)
  })

  it('sweep 清理长时间没活动的桶', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0 })

    limiter.take('app_a')
    limiter.take('app_b')
    expect(limiter.size).toBe(2)

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'))
    expect(limiter.sweep()).toBe(2)
    expect(limiter.size).toBe(0)
  })
})
