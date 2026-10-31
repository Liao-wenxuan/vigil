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
  it('回放先到时也会建出会话行（否则会话列表里看不到回放）', async () => {
    const { replay, project } = await setupDb()

    // 只写回放，不写行为汇总
    await replay.saveReplay(project.id, 'sess-1', { events: replayStream(), bytes: 120 })

    const sessions = await replay.listSessions(project.id)
    expect(sessions.total).toBe(1)
    expect(sessions.sessions[0].hasReplay).toBe(true)
    expect(sessions.sessions[0].replayEvents).toBe(3)
  })

  it('行为先到、回放后到也能标记有回放', async () => {
    const { replay, project } = await setupDb()

    await replay.ingestBehavior(project.id, {
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

    await replay.saveReplay(project.id, 'sess-2', { events: replayStream(), bytes: 120 })

    const sessions = await replay.listSessions(project.id)
    expect(sessions.total).toBe(1)
    expect(sessions.sessions[0].hasReplay).toBe(true)
    expect(sessions.sessions[0].replayEvents).toBe(3)
  })

  it('回放后到的行为汇总不会把回放标记冲掉', async () => {
    const { replay, project } = await setupDb()

    await replay.saveReplay(project.id, 'sess-3', { events: replayStream(), bytes: 120 })
    await replay.upsertSession(project.id, {
      sessionId: 'sess-3',
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      durationMs: 5000,
      pageViews: 2,
      path: ['/', '/cart']
    })

    const sessions = await replay.listSessions(project.id)
    expect(sessions.sessions[0].hasReplay).toBe(true)
    expect(sessions.sessions[0].pageViews).toBe(2)
  })

  it('同一会话存两份回放，只保留最新一份', async () => {
    const { replay, project } = await setupDb()

    await replay.saveReplay(project.id, 'sess-4', { events: replayStream(), bytes: 120 })
    const longer = [...replayStream(), { type: INCREMENTAL, timestamp: Date.now(), data: {} }]
    await replay.saveReplay(project.id, 'sess-4', { events: longer, bytes: 200 })

    const stream = await replay.getReplay(project.id, 'sess-4')
    expect(stream).toHaveLength(4)
  })

  it('回放事件流按 seq 顺序返回（播放器要求连续）', async () => {
    const { replay, project } = await setupDb()

    await replay.saveReplay(project.id, 'sess-5', { events: replayStream(), bytes: 120 })

    const stream = await replay.getReplay(project.id, 'sess-5')
    expect(stream.map((e) => e.type)).toEqual([META, FULL_SNAPSHOT, INCREMENTAL])
  })

  it('会话错误数累加', async () => {
    const { replay, project } = await setupDb()

    await replay.upsertSession(project.id, {
      sessionId: 'sess-6',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 1000,
      pageViews: 1
    })
    await replay.incrementSessionError(project.id, 'sess-6')
    await replay.incrementSessionError(project.id, 'sess-6')

    const sessions = await replay.listSessions(project.id)
    expect(sessions.sessions[0].errorCount).toBe(2)
  })
})

describe('回放增量写入', () => {
  /** 用固定的 base 造链 —— 每次调用 replayStream() 会取新的 Date.now()，
   *  那样每次都是「新快照」，测不出增量写入 */
  function chain(base: number, increments: number): ReplayEvent[] {
    const events: ReplayEvent[] = [
      { type: META, timestamp: base, data: { href: '/cart', width: 1440, height: 900 } },
      { type: FULL_SNAPSHOT, timestamp: base, data: { node: { type: 0, id: 1 } } }
    ]
    for (let i = 1; i <= increments; i++) {
      events.push({ type: INCREMENTAL, timestamp: base + i * 1000, data: { text: `step-${i}` } })
    }
    return events
  }

  async function seqZeroId(
    db: Awaited<ReturnType<typeof setupDb>>['db'],
    projectId: number,
    sessionId: string
  ): Promise<number | undefined> {
    const row = await db.get<{ id: number }>(
      'SELECT id FROM replay_events WHERE project_id = ? AND session_id = ? AND seq = 0',
      [projectId, sessionId]
    )
    return row?.id
  }

  it('同一条链的更长窗口只追加尾部，不重写历史', async () => {
    const { db, replay, project } = await setupDb()
    const base = Date.now() - 60_000

    await replay.saveReplay(project.id, 'chain-1', { events: chain(base, 1), bytes: 100 })
    const anchorBefore = await seqZeroId(db, project.id, 'chain-1')

    const longer = await replay.saveReplay(project.id, 'chain-1', {
      events: chain(base, 4),
      bytes: 200
    })
    const anchorAfter = await seqZeroId(db, project.id, 'chain-1')

    // 第 0 行的自增 id 没变 ⇒ 旧流没被删掉重建（那是 O(n²) 的来源）
    expect(anchorAfter).toBe(anchorBefore)
    expect(longer.events).toBe(6)
    expect(await replay.getReplay(project.id, 'chain-1')).toHaveLength(6)
  })

  it('客户端重新取快照 → 旧链整体作废，不会拼出新快照 + 旧增量的混合流', async () => {
    const { replay, project } = await setupDb()
    const base = Date.now() - 60_000

    await replay.saveReplay(project.id, 'chain-2', { events: chain(base, 4), bytes: 100 })
    // 第二个参数是新的 base ⇒ seq 0 的 timestamp 变了 ⇒ 换了条链
    await replay.saveReplay(project.id, 'chain-2', { events: chain(base + 30_000, 1), bytes: 60 })

    const stream = await replay.getReplay(project.id, 'chain-2')
    expect(stream).toHaveLength(3)
    // 首帧必须是最新那条链的快照
    expect(stream[0].timestamp).toBe(base + 30_000)
  })

  it('重复上报同一窗口不产生重复行', async () => {
    const { replay, project } = await setupDb()
    const base = Date.now() - 60_000
    const events = chain(base, 3)

    await replay.saveReplay(project.id, 'chain-3', { events, bytes: 100 })
    await replay.saveReplay(project.id, 'chain-3', { events, bytes: 100 })

    expect(await replay.getReplay(project.id, 'chain-3')).toHaveLength(5)
  })

  it('这次送的窗口比已存的短，会话计数不会虚高', async () => {
    const { replay, project } = await setupDb()
    const base = Date.now() - 60_000

    await replay.saveReplay(project.id, 'chain-4', { events: chain(base, 5), bytes: 100 })
    const result = await replay.saveReplay(project.id, 'chain-4', {
      events: chain(base, 1),
      bytes: 100
    })

    // 库里还是 7 条（1 条 meta + 1 快照 + 5 增量），不能被截成 3
    expect(result.events).toBe(7)
    expect(await replay.getReplay(project.id, 'chain-4')).toHaveLength(7)
  })
})

describe('行为服务', () => {
  it('行为事件入库并能按类型聚合', async () => {
    const { replay, project } = await setupDb()

    await replay.ingestBehavior(project.id, {
      appId: 'app',
      sdk: { name: '@vigil/sdk', version: '0.1.0' },
      events: [
        behaviorEvent({ type: 'pageview', name: '/cart' }),
        behaviorEvent({ type: 'click', name: 'button:去结算' })
      ]
    })

    const summary = await replay.summary(project.id)
    expect(summary.pageViews).toBe(1)
    expect(summary.sessions).toBe(1)
    expect(summary.clicks[0]?.name).toBe('button:去结算')
  })

  it('行为事件带上会话归属', async () => {
    const { replay, project } = await setupDb()

    await replay.ingestBehavior(project.id, {
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

    const events = await replay.listSessionEvents(project.id, 'sess-7')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('route')
  })
})
