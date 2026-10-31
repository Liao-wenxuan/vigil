import type {
  ArchiveStrategy,
  IssueActivityAction,
  IssueStatus,
  IssueSubstatus
} from '@vigil/protocol'

/**
 * Issue 状态机。
 *
 * ## 为什么是纯函数
 *
 * 状态流转的规则很容易写成一堆 if，散落在服务层各处。
 * 那样做的后果是：**没人能说清一个 Issue 在什么条件下会变成什么状态**，
 * 改一条规则很容易漏掉另一处。
 *
 * 做成纯函数（状态 + 事件 → 新状态 + 变更 + 活动流）的好处：
 *   - 规则集中在一处，可以穷举测试
 *   - 每次流转产生什么活动流，是函数的一部分，不靠调用方记得写
 *   - 能直接回答「这个 Issue 现在为什么是 regressed」
 *
 * ## 状态模型
 *
 * 主状态（status）—— 一次只能有一个：
 *   unresolved  未解决
 *   resolved    已解决
 *   archived    已归档
 *
 * 子状态（substatus）—— 主状态下的细分：
 *   new        7 天内新建
 *   ongoing    超过 7 天 / 人工已阅
 *   escalating 归档中的错误量突增，被自动升回
 *   regressed  已解决的错误在新版本又出现
 *
 * 拆两层是因为「未解决」不是一个状态 —— 新建的、看了很久没动静的、
 * 归档后突然爆发的，排优先级时必须分开。
 */

/** Issue 的当前状态快照 */
export interface IssueState {
  status: IssueStatus
  substatus: IssueSubstatus
  count: number
  userCount: number
  firstSeen: number
  lastSeen: number
  hasSeen: boolean
  resolvedAt?: number
  resolvedInReleaseId?: number
  resolvedInRelease?: string
  archivedAt?: number
  archiveStrategy?: ArchiveStrategy
  archiveUntilCount?: number
  archiveUntilUserCount?: number
}

/** 触发状态流转的事件 */
export type IssueTransition =
  /** 新建 */
  | { type: 'created'; now: number }
  /** 收到一次新的错误发生 */
  | {
      type: 'event_received'
      now: number
      /** 事件所属的版本（用于回归判定） */
      release?: string
      /** 事件所属用户（用于累计受影响用户数） */
      userId?: string
      /** 该用户此前是否已经计入过 */
      userIsNew: boolean
    }
  /** 人工标记已解决 */
  | { type: 'resolve'; now: number; release?: string; releaseId?: number }
  /** 人工归档 */
  | {
      type: 'archive'
      now: number
      strategy: ArchiveStrategy
      untilCount?: number
      untilUserCount?: number
    }
  /** 解除归档 */
  | { type: 'unarchive'; now: number }
  /** 标记为「已阅」—— 人工看过就不再是 new */
  | { type: 'mark_seen'; now: number }
  /** 归档中的错误量突增，自动升回 */
  | { type: 'escalate'; now: number }
  /** 时间到了：new 转 ongoing */
  | { type: 'auto_ongoing'; now: number }

/** 活动流条目（尚未落库） */
export interface ActivityDraft {
  action: IssueActivityAction
  actorType: 'member' | 'system'
  reason?: string
  data?: Record<string, unknown>
}

/** 状态流转的结果 */
export interface TransitionResult {
  state: IssueState
  /** 需要写回 issues 表的字段变更（部分更新） */
  changes: Partial<
    Pick<
      IssueState,
      | 'status'
      | 'substatus'
      | 'count'
      | 'userCount'
      | 'lastSeen'
      | 'hasSeen'
      | 'resolvedAt'
      | 'resolvedInReleaseId'
      | 'resolvedInRelease'
      | 'archivedAt'
      | 'archiveStrategy'
      | 'archiveUntilCount'
      | 'archiveUntilUserCount'
    >
  >
  /** 需要写入 issue_activity 的条目 */
  activities: ActivityDraft[]
}

/** 「未解决」多久算「看过很久没动静」 */
export const NEW_ISSUE_WINDOW_MS = 7 * 24 * 3600 * 1000

/**
 * 比较两个版本号，判断后者是否更新。
 *
 * 按语义化版本比较，而不是字符串比较 ——
 * 字符串比较下 '1.4.10' < '1.4.3'（因为 '1' < '3'），
 * 那样「1.4.3 修好的问题在 1.4.10 出现」就不会被判成回归。
 *
 * 非标准版本（'main'、'abc123'）无法比较语义，
 * 此时**保守地认为无法判定** —— 宁可漏判回归，也不要误报。
 */
export function isNewerVersion(
  candidate: string | undefined,
  baseline: string | undefined
): boolean {
  if (!candidate || !baseline) return false
  if (candidate === baseline) return false

  const parse = (version: string): number[] | null => {
    // 去掉 v 前缀和构建元数据
    const core = version.replace(/^v/i, '').split('+')[0].split('-')[0]
    const parts = core.split('.')
    if (parts.length === 0) return null
    const numbers: number[] = []
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null
      numbers.push(Number(part))
    }
    return numbers
  }

  const a = parse(candidate)
  const b = parse(baseline)
  if (!a || !b) return false

  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }

  return false
}

/**
 * 状态流转的**唯一入口**。
 *
 * 返回新状态、要改的字段、以及要写的活动流。
 * 调用方不需要判断「这次要不要写活动」—— 函数已经决定了。
 */
export function transition(state: IssueState, event: IssueTransition): TransitionResult {
  switch (event.type) {
    case 'created':
      return {
        state: { ...state, status: 'unresolved', substatus: 'new' },
        changes: { status: 'unresolved', substatus: 'new' },
        activities: [{ action: 'created', actorType: 'system' }]
      }

    case 'event_received':
      return onEventReceived(state, event)

    case 'resolve':
      return onResolve(state, event)

    case 'archive':
      return onArchive(state, event)

    case 'unarchive':
      return {
        state: {
          ...state,
          status: 'unresolved',
          substatus: 'ongoing',
          archivedAt: undefined,
          archiveStrategy: undefined,
          archiveUntilCount: undefined,
          archiveUntilUserCount: undefined
        },
        changes: {
          status: 'unresolved',
          substatus: 'ongoing',
          archivedAt: undefined,
          archiveStrategy: undefined,
          archiveUntilCount: undefined,
          archiveUntilUserCount: undefined
        },
        activities: [{ action: 'unarchived', actorType: 'member' }]
      }

    case 'mark_seen':
      return {
        state: {
          ...state,
          hasSeen: true,
          // 人工看过就不再是「新建」
          substatus: state.substatus === 'new' ? 'ongoing' : state.substatus
        },
        changes: {
          hasSeen: true,
          substatus: state.substatus === 'new' ? 'ongoing' : state.substatus
        },
        activities: [{ action: 'reviewed', actorType: 'member' }]
      }

    case 'escalate':
      return {
        state: { ...state, status: 'unresolved', substatus: 'escalating' },
        changes: { status: 'unresolved', substatus: 'escalating' },
        activities: [
          {
            action: 'escalated',
            actorType: 'system',
            reason: '归档中的错误发生量超过基线，自动升回'
          }
        ]
      }

    case 'auto_ongoing':
      // 只在「新建」且超过窗口时转「持续中」
      if (state.substatus !== 'new') {
        return { state, changes: {}, activities: [] }
      }
      if (event.now - state.firstSeen < NEW_ISSUE_WINDOW_MS) {
        return { state, changes: {}, activities: [] }
      }
      return {
        state: { ...state, substatus: 'ongoing' },
        changes: { substatus: 'ongoing' },
        activities: []
      }

    default: {
      // 穷尽性检查：新增 transition 类型而忘了处理，编译期就该报错
      const _exhaustive: never = event
      throw new Error(`未处理的状态流转：${JSON.stringify(_exhaustive)}`)
    }
  }
}

/** 收到一次新的错误发生 */
function onEventReceived(
  state: IssueState,
  event: Extract<IssueTransition, { type: 'event_received' }>
): TransitionResult {
  const count = state.count + 1
  const userCount = state.userCount + (event.userIsNew ? 1 : 0)

  // ⚠️ `last_seen` 必须是**最大**的发生时间，不能直接赋值成这次的时间。
  //
  // 事件不保证按时间顺序到达：SDK 离线补报、网络重试、客户端时钟偏差，
  // 都会让一条**更早**的事件后到。直接覆盖会把 last_seen 拖回过去 ——
  // 后果是「刚刚还在报错的问题」在按最近发生排序时沉到列表底部，
  // 而且窗口查询（last_seen >= since）会把真正在窗口内发生过的问题漏掉。
  const lastSeen = Math.max(state.lastSeen, event.now)

  const changes: TransitionResult['changes'] = {
    count,
    userCount,
    lastSeen
  }
  const activities: ActivityDraft[] = []
  let next: IssueState = { ...state, count, userCount, lastSeen }

  if (state.status === 'resolved') {
    // 关键判定：**在解决它的那个版本或更早版本**出现 → 算噪音，不重新打开
    // 只有更新版本出现，才算回归。
    const regressed = isNewerVersion(event.release, state.resolvedInRelease)

    if (regressed) {
      next = { ...next, status: 'unresolved', substatus: 'regressed' }
      changes.status = 'unresolved'
      changes.substatus = 'regressed'
      activities.push({
        action: 'regressed',
        actorType: 'system',
        reason: state.resolvedInRelease
          ? `在 ${event.release} 重新出现（${state.resolvedInRelease} 已修复）`
          : '已解决的错误重新出现',
        data: { release: event.release, resolvedInRelease: state.resolvedInRelease }
      })
    }
    // 不是回归 → 保持 resolved，只更新计数
    return { state: next, changes, activities }
  }

  if (state.status === 'archived') {
    // 归档的 issue 仍继续计数 —— 达到阈值时由评估器发起 escalate
    return { state: next, changes, activities }
  }

  // unresolved：计数更新即可，substatus 的流转由时间或人工触发
  return { state: next, changes, activities }
}

/** 人工标记已解决 */
function onResolve(
  state: IssueState,
  event: Extract<IssueTransition, { type: 'resolve' }>
): TransitionResult {
  if (state.status === 'resolved') {
    return { state, changes: {}, activities: [] }
  }

  const changes: TransitionResult['changes'] = {
    status: 'resolved',
    resolvedAt: event.now,
    resolvedInReleaseId: event.releaseId,
    resolvedInRelease: event.release
  }

  return {
    state: {
      ...state,
      status: 'resolved',
      resolvedAt: event.now,
      resolvedInReleaseId: event.releaseId,
      resolvedInRelease: event.release,
      // 归档状态在解决时一并解除
      archivedAt: undefined,
      archiveStrategy: undefined
    },
    changes,
    activities: [
      {
        action: 'resolved',
        actorType: 'member',
        reason: event.release ? `在 ${event.release} 解决` : undefined,
        data: event.release ? { release: event.release } : undefined
      }
    ]
  }
}

/** 人工归档 */
function onArchive(
  state: IssueState,
  event: Extract<IssueTransition, { type: 'archive' }>
): TransitionResult {
  if (state.status === 'archived') {
    return { state, changes: {}, activities: [] }
  }

  const changes: TransitionResult['changes'] = {
    status: 'archived',
    archivedAt: event.now,
    archiveStrategy: event.strategy,
    archiveUntilCount: event.untilCount,
    archiveUntilUserCount: event.untilUserCount
  }

  return {
    state: {
      ...state,
      status: 'archived',
      archivedAt: event.now,
      archiveStrategy: event.strategy,
      archiveUntilCount: event.untilCount,
      archiveUntilUserCount: event.untilUserCount
    },
    changes,
    activities: [
      {
        action: 'archived',
        actorType: 'member',
        reason: archiveReason(event.strategy, event.untilCount, event.untilUserCount),
        data: {
          strategy: event.strategy,
          untilCount: event.untilCount,
          untilUserCount: event.untilUserCount
        }
      }
    ]
  }
}

function archiveReason(
  strategy: ArchiveStrategy,
  untilCount?: number,
  untilUserCount?: number
): string {
  switch (strategy) {
    case 'forever':
      return '永久归档'
    case 'until_escalating':
      return '归档直到错误量突增'
    case 'until_count':
      return `归档直到发生 ${untilCount ?? 0} 次`
    case 'until_user_count':
      return `归档直到影响 ${untilUserCount ?? 0} 个用户`
    default:
      return '已归档'
  }
}
