import type { ReplayEvent } from '@vigil/protocol'

/**
 * 回放事件缓冲区策略（纯函数）。
 *
 * ## 为什么单独抽出来
 *
 * 录制器要在浏览器里跑（rrweb 需要真实 DOM），但**缓冲区策略**本身
 * 是个纯函数：给定「当前缓冲 + 新事件」，算出「下一个缓冲」。
 *
 * 把它抽出来不是为了好看 —— 是因为这个策略里藏着整个回放模块的
 * **命门**：增量链必须从全量快照开始。一旦这里写错，
 * 回放**不会报错**，只会静默地播不出来（没有报错 = 监控面板自己坏了）。
 *
 * 抽成纯函数才能用单元测试把这条不变量钉死。
 */

/**
 * rrweb 的全量快照事件类型。
 *
 * ⚠️ 编号不是随手写的：`@rrweb/types` 的 `EventType` 是
 * `DomContentLoaded=0 / Load=1 / FullSnapshot=2 / IncrementalSnapshot=3 / Meta=4`。
 *
 * 写成 0 会导致**缓冲区永远不重置** —— 增量链可能从一个没有快照的
 * 增量事件开始，后面的增量全部对不上，回放直接废掉。
 */
export const FULL_SNAPSHOT_TYPE = 2

/**
 * rrweb 的 Meta 事件类型。
 *
 * Meta 带的是**原始视口尺寸**（`width` / `height`）。
 * 播放器靠它把内容按比例缩放到容器里 —— 没有 Meta，回放会被裁切。
 *
 * 所以全量快照重置缓冲时，**Meta 要留下来**。
 */
export const META_TYPE = 4

/** 缓冲区的当前状态 */
export interface ReplayBufferState {
  /** 缓冲的事件流（按录制顺序） */
  events: ReplayEvent[]
  /** 已占用的估算字节数 */
  bytes: number
  /** 因为超预算被丢弃的段数 */
  droppedSegments: number
}

/** 初始状态 */
export function emptyBuffer(): ReplayBufferState {
  return { events: [], bytes: 0, droppedSegments: 0 }
}

/** 一次事件处理的结果 */
export interface BufferResult {
  /** 处理后的状态 */
  state: ReplayBufferState
  /**
   * 是否因为超预算被截断。
   *
   * 为 true 时调用方**必须重新取一次全量快照**（重新 record），
   * 不能简单地丢掉这一段 —— 增量链会断。
   */
  overflow: boolean
}

/**
 * 把一个事件应用到缓冲区上。
 *
 * ## 三条规则
 *
 * 1. **全量快照 → 重置缓冲（但保留 Meta）。** 新的快照比旧的增量更完整，
 *    保留旧增量只会让链更长。
 *    Meta 必须留 —— 播放器靠它定视口尺寸，丢了回放会被裁切。
 * 2. **超预算 → 清空并要求重新取快照。** 不能只丢最后一段：
 *    丢中间会让后面的增量全部对不上。
 * 3. **正常事件 → 追加。**
 */
export function applyReplayEvent(
  state: ReplayBufferState,
  event: ReplayEvent,
  maxBytes: number,
  sizeOf: (event: ReplayEvent) => number = estimateSize
): BufferResult {
  const size = sizeOf(event)

  // 规则 1：全量快照重置缓冲
  if (event.type === FULL_SNAPSHOT_TYPE) {
    // 只保留 Meta（最多一个），其余旧增量全部作废
    const metas = state.events.filter((e) => e.type === META_TYPE).slice(-1)
    const kept = [...metas, event]
    const bytes = kept.reduce((sum, e) => sum + sizeOf(e), 0)

    return {
      state: {
        events: kept,
        bytes,
        droppedSegments: state.droppedSegments
      },
      overflow: false
    }
  }

  // 规则 2：超预算 → 整体作废，要求重新取快照
  if (state.bytes + size > maxBytes) {
    return {
      state: {
        events: [],
        bytes: 0,
        droppedSegments: state.droppedSegments + 1
      },
      overflow: true
    }
  }

  // 规则 3：追加
  return {
    state: {
      events: [...state.events, event],
      bytes: state.bytes + size,
      droppedSegments: state.droppedSegments
    },
    overflow: false
  }
}

/**
 * 估算事件大小。
 *
 * 用 JSON.stringify 是最准的，但全量快照可能有几十 KB ——
 * 那个开销只在快照时出现一次，可以接受。
 */
export function estimateSize(event: ReplayEvent): number {
  try {
    return JSON.stringify(event).length
  } catch {
    return 1024
  }
}
