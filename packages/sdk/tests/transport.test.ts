import { describe, expect, it, vi } from 'vitest'
import type { ErrorEvent } from '@vigil/protocol'
import { buildEnvelope, sendBatch, splitIntoBatches, type TransportOptions } from '../src/transport'

/** 造一条最小事件 */
function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    category: 'javascript',
    kind: 'js',
    message: 'boom',
    frames: [],
    fingerprint: 'fp_test',
    url: 'https://a.com/page',
    userAgent: 'test-agent',
    sessionId: 'session-1',
    occurredAt: Date.now(),
    ...overrides
  }
}

/** 造一条体积可控的事件 */
function makeSizedEvent(size: number): ErrorEvent {
  return makeEvent({ message: 'x'.repeat(size) })
}

function makeOptions(overrides: Partial<TransportOptions> = {}): TransportOptions {
  return {
    endpoint: 'https://collector.test/api/v1/collect',
    appId: 'app_test',
    token: 'vsk_secret',
    maxPayloadBytes: 48 * 1024,
    maxBatchSize: 20,
    fetchImpl: vi.fn(async () => ({ ok: true }) as Response),
    ...overrides
  }
}

/**
 * 读 Blob 文本。
 *
 * 用 FileReader 而不是 blob.text() —— jsdom 的 Blob 没实现 text()，
 * 但 FileReader 是完整的。真实浏览器两者都有。
 */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

describe('splitIntoBatches', () => {
  it('按条数上限切批', () => {
    const events = Array.from({ length: 10 }, () => makeEvent())
    const batches = splitIntoBatches(events, 1024 * 1024, 3)
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 3, 1])
  })

  it('按体积上限切批', () => {
    const events = Array.from({ length: 10 }, () => makeSizedEvent(2000))
    const batches = splitIntoBatches(events, 5000, 100)
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0)
    }
    // 所有事件都要还在，一批都不能丢
    expect(batches.flat()).toHaveLength(10)
  })

  it('空数组返回空批次列表', () => {
    expect(splitIntoBatches([], 1000, 10)).toEqual([])
  })

  it('单条超大的事件也自成一批，不会被丢掉', () => {
    const events = [makeSizedEvent(100000)]
    const batches = splitIntoBatches(events, 2000, 10)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
  })
})

describe('buildEnvelope', () => {
  it('带 appId 和 sdk 信息', () => {
    const envelope = buildEnvelope([makeEvent()], 'app_test')
    expect(envelope.appId).toBe('app_test')
    expect(envelope.sdk.name).toBe('@vigil/sdk')
    expect(envelope.events).toHaveLength(1)
  })
})

describe('sendBatch', () => {
  it('beacon 通道把 token 放进 body（beacon 不能自定义 header）', async () => {
    let captured: Blob | undefined
    const options = makeOptions({
      beaconImpl: (_url, data) => {
        captured = data
        return true
      }
    })

    const ok = await sendBatch([makeEvent()], options, true)

    expect(ok).toBe(true)
    const body = JSON.parse(await readBlobText(captured!))
    expect(body.token).toBe('vsk_secret')
  })

  it('fetch 通道把 token 放进 header，body 里不带 token', async () => {
    let capturedInit: RequestInit | undefined
    const options = makeOptions({
      fetchImpl: vi.fn(async (_url, init) => {
        capturedInit = init
        return { ok: true } as Response
      })
    })

    const ok = await sendBatch([makeEvent()], options, false)

    expect(ok).toBe(true)
    const headers = capturedInit!.headers as Record<string, string>
    expect(headers['X-Vigil-Token']).toBe('vsk_secret')
    expect(headers['X-Vigil-App-Id']).toBe('app_test')

    const body = JSON.parse(capturedInit!.body as string)
    expect(body.token).toBeUndefined()
  })

  it('fetch 通道用 keepalive（页面关闭后请求仍有机会发完）', async () => {
    let capturedInit: RequestInit | undefined
    const options = makeOptions({
      fetchImpl: vi.fn(async (_url, init) => {
        capturedInit = init
        return { ok: true } as Response
      })
    })

    await sendBatch([makeEvent()], options, false)
    expect(capturedInit!.keepalive).toBe(true)
  })

  it('beacon 失败时退回 fetch', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response)
    const options = makeOptions({
      fetchImpl,
      beaconImpl: () => false
    })

    const ok = await sendBatch([makeEvent()], options, true)

    expect(ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('请求失败返回 false，不抛异常', async () => {
    const options = makeOptions({
      fetchImpl: vi.fn(async () => {
        throw new Error('network down')
      })
    })

    const ok = await sendBatch([makeEvent()], options, false)
    expect(ok).toBe(false)
  })

  it('空批次直接返回 true', async () => {
    const options = makeOptions()
    expect(await sendBatch([], options, false)).toBe(true)
    expect(options.fetchImpl).not.toHaveBeenCalled()
  })
})
