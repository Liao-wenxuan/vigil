import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ErrorEvent } from '@vigil/protocol'
import { EventQueue } from '../src/queue'

function makeEvent(message = 'boom'): ErrorEvent {
  return {
    category: 'javascript',
    kind: 'js',
    message,
    frames: [],
    fingerprint: 'fp',
    url: 'https://a.com/',
    userAgent: 'ua',
    sessionId: 's',
    occurredAt: Date.now()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('EventQueue', () => {
  it('攒够 maxSize 自动刷新', async () => {
    const onFlush = vi.fn()
    const queue = new EventQueue({ maxSize: 3, flushIntervalMs: 10000, onFlush })

    queue.push(makeEvent('1'))
    queue.push(makeEvent('2'))
    expect(onFlush).not.toHaveBeenCalled()

    queue.push(makeEvent('3'))
    await vi.waitFor(() => expect(onFlush).toHaveBeenCalledTimes(1))
    expect(onFlush.mock.calls[0][0]).toHaveLength(3)
  })

  it('定时器到点刷新', async () => {
    vi.useFakeTimers()
    const onFlush = vi.fn()
    const queue = new EventQueue({ maxSize: 100, flushIntervalMs: 1000, onFlush })

    queue.start()
    queue.push(makeEvent())

    await vi.advanceTimersByTimeAsync(1000)
    expect(onFlush).toHaveBeenCalledTimes(1)
    queue.stop()
  })

  it('flush 把队列清空', async () => {
    const onFlush = vi.fn()
    const queue = new EventQueue({ maxSize: 100, flushIntervalMs: 10000, onFlush })

    queue.push(makeEvent('1'))
    queue.push(makeEvent('2'))
    expect(queue.size).toBe(2)

    await queue.flush()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(queue.size).toBe(0)
  })

  it('空队列 flush 不触发回调', async () => {
    const onFlush = vi.fn()
    const queue = new EventQueue({ maxSize: 100, flushIntervalMs: 10000, onFlush })
    await queue.flush()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('发送失败不影响后续入队（onError 被调用，队列不卡死）', async () => {
    const onError = vi.fn()
    const queue = new EventQueue({
      maxSize: 100,
      flushIntervalMs: 10000,
      onFlush: () => {
        throw new Error('network down')
      },
      onError
    })

    queue.push(makeEvent())
    await queue.flush()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(queue.size).toBe(0)
  })
})
