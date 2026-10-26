/**
 * Issue 领域的线上契约。
 *
 * Issue 是**聚合后的问题** —— 一类错误的所有发生被并成一条，
 * 并且带着完整的生命周期（谁在什么时候做了什么）。
 *
 * 这与「错误记录」是两种东西：
 * 错误记录是流水，Issue 是工单。
 */

/**
 * Issue 主状态。
 *
 * 一次只能有一个主状态。三个状态各自在干活：
 * - unresolved：默认，待处理
 * - resolved：已解决（在某个 release 上解决的）
 * - archived：已归档（可以是「直到升级」这种条件性的）
 */
export type IssueStatus = 'unresolved' | 'resolved' | 'archived'

/**
 * 子状态 —— 主状态下的细分。
 *
 * 拆成两层是因为「未解决」不是一个状态：新建的、看了很久没动静的、
 * 归档后突然爆发的，需要区分开才能排优先级。
 */
export type IssueSubstatus =
  /** 7 天内新建 */
  | 'new'
  /** 超过 7 天 / 人工已阅 */
  | 'ongoing'
  /** 归档中的错误量突增，自动升回 */
  | 'escalating'
  /** 已解决的错误在新版本又出现 */
  | 'regressed'

/** 严重级别 */
export type IssueLevel = 'fatal' | 'error' | 'warning' | 'info'

/** 活动流的动作类型 */
export type IssueActivityAction =
  | 'created'
  | 'assigned'
  | 'unassigned'
  | 'resolved'
  | 'archived'
  | 'unarchived'
  | 'escalated'
  | 'regressed'
  | 'reviewed'
  | 'commented'
  | 'bookmarked'
  | 'unbookmarked'
  | 'subscribed'
  | 'unsubscribed'
  | 'tag_added'
  | 'tag_removed'
  | 'level_changed'
  | 'release_linked'

/**
 * 操作者类型。
 *
 * 区分「人」和「系统」很重要：系统改自己的主意时（比如归档的错误
 * 因为量突增被升回），也要留下记录，且要能看出是系统干的。
 */
export type ActorType = 'member' | 'system'

/** 归档策略 */
export type ArchiveStrategy =
  /** 永远归档，除非人工解除 */
  | 'forever'
  /** 直到错误量突增 */
  | 'until_escalating'
  /** 直到发生 N 次 */
  | 'until_count'
  /** 直到影响 N 个用户 */
  | 'until_user_count'

/** Issue 摘要（列表用） */
export interface IssueSummary {
  id: number
  shortId: string
  projectId: number
  fingerprint: string
  category: 'javascript' | 'resource' | 'http'
  kind: string
  title: string
  /** 责任点：最像"根因位置"的那一帧 */
  culprit?: string
  level: IssueLevel
  status: IssueStatus
  substatus: IssueSubstatus
  /** 发生次数 */
  count: number
  /** 受影响用户数 */
  userCount: number
  firstSeen: number
  lastSeen: number
  /** 已解决时间 */
  resolvedAt?: number
  /** 在哪个版本上解决的 —— 回归判定的锚 */
  resolvedInRelease?: string
  /** 负责人 */
  assigneeId?: number
  assigneeName?: string
  isBookmarked: boolean
  isSubscribed: boolean
  hasSeen: boolean
  /** 归档策略 */
  archiveStrategy?: ArchiveStrategy
  archivedAt?: number
  /** 自定义标签 */
  tags?: Array<{ key: string; value: string }>
}

/** Issue 详情 */
export interface IssueDetail extends IssueSummary {
  message: string
  /** 最新一次的原始栈 */
  rawStack?: string
  /** 还原后的栈 */
  resolvedStack?: Array<{
    filename: string
    lineno?: number
    colno?: number
    functionName?: string
    original?: {
      filename: string
      lineno: number
      colno: number
      functionName?: string
      source?: string
    }
  }>
  referrer?: string
  userAgent?: string
  browser?: string
  os?: string
  device?: string
  environment?: string
  release?: string
  /** 最近的错误事件 */
  events?: IssueEventDetail[]
  /** 活动流 */
  activity?: IssueActivityEntry[]
  /** 评论 */
  comments?: IssueComment[]
}

/** Issue 的一次发生 */
export interface IssueEventDetail {
  id: number
  occurredAt: number
  receivedAt: number
  /** 事件 ID —— 用来跳到原始上报 */
  eventId: string
  userId?: string
  sessionId?: string
  url?: string
  release?: string
  environment?: string
  /** 报错瞬间的性能快照 */
  vitals?: Record<string, number | undefined>
}

/** 活动流条目 */
export interface IssueActivityEntry {
  id: number
  action: IssueActivityAction
  actorType: ActorType
  /** 人操作的成员 ID；系统操作时为 null */
  actorId?: number
  actorName?: string
  /** 变更原因（人写的说明，或系统给出的判定依据） */
  reason?: string
  createdAt: number
  data?: Record<string, unknown>
}

/** 评论 */
export interface IssueComment {
  id: number
  authorId?: number
  authorName?: string
  body: string
  createdAt: number
  updatedAt: number
}

/** Issue 列表的查询条件 */
export interface IssueQuery {
  projectId: number
  status?: IssueStatus
  substatus?: IssueSubstatus
  category?: string
  level?: IssueLevel
  environment?: string
  release?: string
  assigneeId?: number
  isBookmarked?: boolean
  /** 关键词：搜标题、消息、路径 */
  query?: string
  limit?: number
  offset?: number
  sort?: 'last_seen' | 'first_seen' | 'count' | 'user_count' | 'priority'
}

/** 批量状态操作 */
export interface IssueBulkAction {
  issueIds: number[]
  action: 'resolve' | 'archive' | 'unarchive' | 'bookmark' | 'unbookmark' | 'mark_seen'
  /** 归档策略 */
  archiveStrategy?: ArchiveStrategy
  /** 归档阈值 */
  archiveUntilCount?: number
  archiveUntilUserCount?: number
  /** 在哪个版本上解决 */
  release?: string
  reason?: string
  actorId?: number
}
