import { describe, expect, it } from 'vitest'
import {
  applyReplayEvent,
  emptyBuffer,
  estimateSize,
  FULL_SNAPSHOT_TYPE
} from '../src/replay/buffer'
import type { ReplayEvent } from '@vigil/protocol'

/**
 * 回放缓冲区策略的测试。
 *
 * 这里守的是整个回放模块的**命门**：
 * 增量链必须从全量快照开始。
 *
 * 之前 `FULL_SNAPSHOT_TYPE` 写成了 0（而 rrweb 的 `EventType.FullSnapshot`
 * 是 2），导致缓冲区永远不重置 —— 增量链可能从一个没有快照的增量事件开始。
 * 这种 bug **不会报错**，只会让回放静默地播不出来，
 * 所以必须用测试把它钉死。
 */

function event(type: number, timestamp = 0): ReplayEvent {
  return { type, timestamp, data: { payload: 'x'.repeat(10) } }
}

describe('FULL_SNAPSHOT_TYPE', () => {
  it('是 rrweb 的全量快照编号 2', () => {
    // @rrweb/types 的 EventType：DomContentLoaded=0 / Load=1 /
    // FullSnapshot=2 / IncrementalSnapshot=3 / Meta=4
    expect(FULL_SNAPSHOT_TYPE).toBe(2)
  })
})

describe('applyReplayEvent', () => {
  it('全量快照会重置缓冲，只留快照本身', () => {
    const size = estimateSize(event(3))
    const state = { events: [event(3)], bytes: size, droppedSegments: 0 }

    const result = applyReplayEvent(state, event(FULL_SNAPSHOT_TYPE), 10_000)

    expect(result.overflow).toBe(false)
    expect(result.state.events).toHaveLength(1)
    expect(result.state.events[0].type).toBe(FULL_SNAPSHOT_TYPE)
    expect(result.state.bytes).toBe(estimateSize(event(FULL_SNAPSHOT_TYPE)))
  })

  it('普通增量事件追加到缓冲尾部', () => {
    const first = applyReplayEvent(emptyBuffer(), event(3), 10_000)
    const second = applyReplayEvent(first.state, event(3), 10_000)

    expect(second.state.events).toHaveLength(2)
    expect(second.state.bytes).toBeGreaterThan(first.state.bytes)
    expect(second.overflow).toBe(false)
  })

  it('超预算时整体作废并要求重新取快照', () => {
    const state = { events: [event(3), event(3)], bytes: 100, droppedSegments: 0 }

    const result = applyReplayEvent(state, event(3), 50)

    // 关键：不是「丢掉这一段」，而是整体清空 ——
    // 丢中间会让后面的增量全部对不上。
    expect(result.overflow).toBe(true)
    expect(result.state.events).toHaveLength(0)
    expect(result.state.bytes).toBe(0)
    expect(result.state.droppedSegments).toBe(1)
  })

  it('全量快照不受预算限制（否则大页面永远录不进来）', () => {
    const big = { type: FULL_SNAPSHOT_TYPE, timestamp: 0, data: 'x'.repeat(50_000) }

    const result = applyReplayEvent(emptyBuffer(), big, 1_000)

    expect(result.overflow).toBe(false)
    expect(result.state.events).toHaveLength(1)
  })

  it('快照重置不会清掉丢弃计数（数据有缺口的事实要如实上报）', () => {
    const state = { events: [], bytes: 0, droppedSegments: 3 }

    const result = applyReplayEvent(state, event(FULL_SNAPSHOT_TYPE), 10_000)

    expect(result.state.droppedSegments).toBe(3)
  })

  it('增量链必须从快照开始 —— 没有快照时不该攒出一串增量', () => {
    // 这是那条不变量的直接表述：
    // 缓冲里如果出现过增量，就必须已经有全量快照垫底。
    let state = emptyBuffer()
    const events = [event(3), event(3), event(FULL_SNAPSHOT_TYPE), event(3)]

    for (const e of events) {
      state = applyReplayEvent(state, e, 10_000).state
    }

    const firstSnapshot = state.events.findIndex((e) => e.type === FULL_SNAPSHOT_TYPE)
    const firstIncremental = state.events.findIndex((e) => e.type !== FULL_SNAPSHOT_TYPE)

    expect(firstSnapshot).toBeGreaterThanOrEqual(0)
    expect(firstSnapshot).toBeLessThan(firstIncremental)
  })
})
