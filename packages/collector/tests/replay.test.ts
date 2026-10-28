import { describe, expect, it } from 'vitest'
import { setupDb } from './helpers.js'
import type { BehaviorEvent, ReplayEvent } from '@vigil/protocol'

/**
 * 会话回放与用户行为的服务测试。
 *
 * 这里守的是回放域的**顺序不变式**：
 * **回放比行为汇总先到是常态** —— 错误是立即上报的，
 * 行为汇总要等攒批或页面卸载。
 *
 * 如果会话行只在行为到达时才建，那么「先有回放」的场景下
 * 这一行永远建不出来，结果是：回放事件躺在库里，
 * 但会话列表里**看不到它** —— 用户完全不知道有回放可看。
 */

/** rrweb 事件编号 */
const FULL_SNAPSHOT = 2
const INCREMENTAL = 3
const META = 4

function replayStream(): ReplayEvent[] {
  const base = Date.now() - 60_000
  return [
    {
      type: META,
      timestamp: base,
      data: { href: 'https://shop.example.com/cart', width: 1440, height: 900 }
    },
    {
      type: FULL_SNAPSHOT,
      timestamp: base,
      data: {
        node: { type: 0, id: 1, childNodes: [] },
        initialOffset: { left: 0, top: 0 }
      }
    },
    {
      type: INCREMENTAL,
      timestamp: base + 1000,
      data: { source: 0, adds: [], removes: [], text: '购物车' }
    }
  ]
}

function behaviorEvent(overrides: Partial<BehaviorEvent> = {}): BehaviorEvent {
  return {
    type: 'pageview',
    name: '/cart',
    url: 'https://shop.example.com/cart',
    timestamp: Date.now(),
    ...overrides
  }
}

describe('回放服务', () => {
  it('回放先到时也会建出会话行（否则会话列表里看不到回放）', () => {
    const { replay, project } = setupDb()

    // 只写回放，不写行为汇总
    replay.saveReplay(project.id, 'sess-1', { events: replayStream(), bytes: 120 })

    const sessions = replay.listSessions(project.id)
    expect(sessions.total).toBe(1)
    expect(sessions.sessions[0].hasReplay).toBe(true)
    expect(sessions.sessions[0].replayEvents).toBe(3)
  })

  it('行为先到、回放后到也能标记有回放', () => {
    const { replay, project } = setupDb()

    replay.ingestBehavior(project.id, {
      appId: 'app',
      sdk: { name: '@vigil/sdk', version: '0.1.0' },
      events: [behaviorEvent()],
      session: {
        sessionId: 'sess-2',
        startedAt: Date.now() - 5000,
        endedAt: Date.now(),
        durationMs: 5000,
        pageViews: 1,
        path: ['/cart']
      }
    })

    replay.saveReplay(project.id, 'sess-2', { events: replayStream(), bytes: 120 })

    const sessions = replay.listSessions(project.id)
    expect(sessions.total).toBe(1)
    expect(sessions.sessions[0].hasReplay).toBe(true)
    expect(sessions.sessions[0].replayEvents).toBe(3)
  })

  it('回放后到的行为汇总不会把回放标记冲掉', () => {
    const { replay, project } = setupDb()

    replay.saveReplay(project.id, 'sess-3', { events: replayStream(), bytes: 120 })
    replay.upsertSession(project.id, {
      sessionId: 'sess-3',
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      durationMs: 5000,
      pageViews: 2,
      path: ['/', '/cart']
    })

    const sessions = replay.listSessions(project.id)
    expect(sessions.sessions[0].hasReplay).toBe(true)
    expect(sessions.sessions[0].pageViews).toBe(2)
  })

  it('同一会话存两份回放，只保留最新一份', () => {
    const { replay, project } = setupDb()

    replay.saveReplay(project.id, 'sess-4', { events: replayStream(), bytes: 120 })
    const longer = [...replayStream(), { type: INCREMENTAL, timestamp: Date.now(), data: {} }]
    replay.saveReplay(project.id, 'sess-4', { events: longer, bytes: 200 })

    const stream = replay.getReplay(project.id, 'sess-4')
    expect(stream).toHaveLength(4)
  })

  it('回放事件流按 seq 顺序返回（播放器要求连续）', () => {
    const { replay, project } = setupDb()

    replay.saveReplay(project.id, 'sess-5', { events: replayStream(), bytes: 120 })

    const stream = replay.getReplay(project.id, 'sess-5')
    expect(stream.map((e) => e.type)).toEqual([META, FULL_SNAPSHOT, INCREMENTAL])
  })

  it('会话错误数累加', () => {
    const { replay, project } = setupDb()

    replay.upsertSession(project.id, {
      sessionId: 'sess-6',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 1000,
      pageViews: 1
    })
    replay.incrementSessionError(project.id, 'sess-6')
    replay.incrementSessionError(project.id, 'sess-6')

    const sessions = replay.listSessions(project.id)
    expect(sessions.sessions[0].errorCount).toBe(2)
  })
})

describe('行为服务', () => {
  it('行为事件入库并能按类型聚合', () => {
    const { replay, project } = setupDb()

    replay.ingestBehavior(project.id, {
      appId: 'app',
      sdk: { name: '@vigil/sdk', version: '0.1.0' },
      events: [
        behaviorEvent({ type: 'pageview', name: '/cart' }),
        behaviorEvent({ type: 'click', name: 'button:去结算' })
      ]
    })

    const summary = replay.summary(project.id)
    expect(summary.pageViews).toBe(1)
    expect(summary.sessions).toBe(1)
    expect(summary.clicks[0]?.name).toBe('button:去结算')
  })

  it('行为事件带上会话归属', () => {
    const { replay, project } = setupDb()

    replay.ingestBehavior(project.id, {
      appId: 'app',
      sdk: { name: '@vigil/sdk', version: '0.1.0' },
      events: [behaviorEvent({ type: 'route', name: '/checkout' })],
      session: {
        sessionId: 'sess-7',
        startedAt: Date.now() - 1000,
        endedAt: Date.now(),
        durationMs: 1000,
        pageViews: 1
      }
    })

    const events = replay.listSessionEvents(project.id, 'sess-7')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('route')
  })
})
