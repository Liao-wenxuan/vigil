/**
 * 管理 API 的响应类型 + 领域词汇表。
 *
 * ## 命名不统一是后端现状，不是笔误
 *
 * Collector 的接口有两种返回风格：
 * - **列表/租户类**接口直接返回数据库行 → **snake_case**（`organization_id`、`user_count`）
 * - **详情/告警类**接口返回 protocol 里的 DTO → **camelCase**（`userCount`、`createdAt`）
 *
 * 这里按接口分别建模，不做「统一成一种」的假抽象 ——
 * 统一了反而要在运行时做一次转换，多一层出错的机会。
 */

import type { InjectionKey } from 'vue'

/* ============================================================
 * 租户域
 * ============================================================ */

export interface OrganizationRow {
  id: number
  slug: string
  name: string
  created_at: number
}

export interface ProjectRow {
  id: number
  organization_id: number
  team_id: number | null
  slug: string
  name: string
  platform: string
  retention_days: number
  event_quota: number
  created_at: number
}

export interface EnvironmentRow {
  id: number
  project_id: number
  slug: string
  name: string
  /** 0 | 1 —— 数据库用整型存布尔 */
  is_production: number
  created_at: number
}

export interface ReleaseRow {
  id: number
  project_id: number
  version: string
  commit_sha: string | null
  created_at: number
  deployed_at: number | null
}

/** 新建项目时返回 —— 两把密钥只在这里出现一次 */
export interface CreatedProject {
  project: ProjectRow
  runtimeKey: string
  uploadKey: string
}

export interface ProjectDetail {
  project: ProjectRow
  environments: EnvironmentRow[]
  releases: ReleaseRow[]
}

/* ============================================================
 * 问题域
 * ============================================================ */

export type IssueStatus = 'unresolved' | 'resolved' | 'archived'
export type IssueSubstatus = 'new' | 'ongoing' | 'escalating' | 'regressed'
export type IssueCategory = 'javascript' | 'resource' | 'http'
export type IssueLevel = 'fatal' | 'error' | 'warning' | 'info'
export type IssueSort = 'last_seen' | 'first_seen' | 'count' | 'user_count' | 'priority'
export type ArchiveStrategy = 'forever' | 'until_escalating' | 'until_count' | 'until_user_count'

/** 列表接口返回的行（数据库行，snake_case） */
export interface IssueRow {
  id: number
  project_id: number
  short_id: string
  fingerprint: string
  category: IssueCategory
  kind: string
  title: string
  message: string
  culprit: string | null
  level: IssueLevel
  status: IssueStatus
  substatus: IssueSubstatus
  count: number
  user_count: number
  first_seen: number
  last_seen: number
  resolved_at: number | null
  resolved_in_release: string | null
  archived_at: number | null
  archive_strategy: ArchiveStrategy | null
  assignee_id: number | null
  /** 0 | 1 */
  is_bookmarked: number
  /** 0 | 1 */
  is_subscribed: number
  /** 0 | 1 */
  has_seen: number
  environment: string | null
  release: string | null
  created_at: number
  updated_at: number
}

export interface IssueEventDetail {
  id: number
  occurredAt: number
  receivedAt: number
  eventId: string
  userId?: string
  sessionId?: string
  url?: string
  release?: string
  environment?: string
  /** 报错瞬间的性能快照 */
  vitals?: Record<string, number | undefined>
}

export interface IssueActivityEntry {
  id: number
  action: string
  actorType: 'member' | 'system'
  actorId?: number
  actorName?: string
  reason?: string
  createdAt: number
  data?: Record<string, unknown>
}

export interface IssueComment {
  id: number
  authorId?: number
  authorName?: string
  body: string
  createdAt: number
  updatedAt: number
}

export interface ResolvedFrame {
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
}

/** 详情接口返回（DTO，camelCase） */
export interface IssueDetail {
  id: number
  shortId: string
  projectId: number
  fingerprint: string
  category: IssueCategory
  kind: string
  title: string
  message: string
  culprit?: string
  level: IssueLevel
  status: IssueStatus
  substatus: IssueSubstatus
  count: number
  userCount: number
  firstSeen: number
  lastSeen: number
  resolvedAt?: number
  resolvedInRelease?: string
  assigneeId?: number
  assigneeName?: string
  isBookmarked: boolean
  isSubscribed: boolean
  hasSeen: boolean
  archiveStrategy?: ArchiveStrategy
  archivedAt?: number
  rawStack?: string
  resolvedStack?: ResolvedFrame[]
  tags: Array<{ key: string; value: string }>
  events: IssueEventDetail[]
  activity: IssueActivityEntry[]
  comments: IssueComment[]
}

export interface IssueStats {
  total: number
  unresolved: number
  new: number
  ongoing: number
  regressed: number
  escalating: number
  resolved: number
  archived: number
  occurrences: number
  byCategory: Array<{ category: string; n: number; occurrences: number }>
  byLevel: Array<{ level: string; n: number }>
  topCulprits: Array<{ culprit: string; n: number; occurrences: number }>
}

/** 列表查询参数 —— 与 `GET /issues` 的 query 一一对应 */
export interface IssueQueryParams {
  status?: IssueStatus
  substatus?: IssueSubstatus
  category?: IssueCategory
  level?: IssueLevel
  environment?: string
  release?: string
  q?: string
  limit?: number
  offset?: number
  sort?: IssueSort
}

export type IssueBulkAction =
  'resolve' | 'archive' | 'unarchive' | 'bookmark' | 'unbookmark' | 'mark_seen'

/* ============================================================
 * 性能域
 * ============================================================ */

export interface Percentiles {
  count: number
  p50: number
  p75: number
  p95: number
  p99: number
  min: number
  max: number
  avg: number
}

export interface PerformanceSummary {
  transactions: number
  vitals: {
    fcp: Percentiles
    lcp: Percentiles
    cls: Percentiles
    inp: Percentiles
    ttfb: Percentiles
    duration: Percentiles
  }
  byName: Array<{
    name: string
    transactions: number
    lcp: Percentiles
    duration: Percentiles
  }>
  topSpans: Array<{
    name: string
    type: string
    count: number
    avg: number
    max: number
    p95: number
  }>
  slowTransactions: Array<{
    id: number
    name: string
    duration_ms: number
    lcp: number | null
    page_url: string | null
  }>
}

export interface TransactionRow {
  id: number
  name: string
  type: string
  duration_ms: number
  fcp: number | null
  lcp: number | null
  cls: number | null
  inp: number | null
  ttfb: number | null
  tbt: number | null
  long_task_count: number
  resource_count: number
  transfer_size: number
  page_url: string | null
  browser: string | null
  os: string | null
  device: string | null
  session_id: string | null
  release: string | null
  environment: string | null
  started_at: number
  received_at: number
}

export interface ErrorPerformanceRow {
  fingerprint: string
  title: string
  count: number
  avgLcp: number | null
}

/* ============================================================
 * 告警域
 * ============================================================ */

export type AlertRuleType =
  | 'issue.new'
  | 'issue.count'
  | 'issue.spike'
  | 'metric.error_count'
  | 'metric.error_rate'
  | 'metric.lcp_p95'

export type ChannelType = 'webhook' | 'feishu' | 'dingtalk' | 'email' | 'slack'

export interface AlertConditions {
  environment?: string[]
  release?: string[]
  category?: string[]
  level?: string[]
  tags?: Array<{ key: string; value: string }>
  assigneeIds?: number[]
}

export interface AlertRule {
  id: number
  projectId: number
  name: string
  type: AlertRuleType
  conditions: AlertConditions
  threshold: number
  windowSeconds: number
  channelIds: number[]
  enabled: boolean
  createdBy?: number
  createdAt: number
  updatedAt: number
}

export interface NotificationChannel {
  id: number
  projectId: number
  name: string
  type: ChannelType
  enabled: boolean
  config: Record<string, unknown>
  createdAt: number
}

export interface AlertIncident {
  id: number
  ruleId: number
  projectId: number
  issueId?: number
  status: 'triggered' | 'resolved' | 'muted'
  triggeredAt: number
  resolvedAt?: number
  dedupeKey: string
  payload: Record<string, unknown>
}

export interface AlertEvaluationResult {
  evaluated: number
  triggered: number
  skipped: number
  failed: number
}

/* ============================================================
 * 回放与行为域
 * ============================================================ */

/**
 * 一个会话的汇总。
 *
 * 回放**按会话**存最新一份 —— 客户端的缓冲区是滚动窗口，
 * 每个错误都存一份就是大量重复数据。
 * 代价是回放展示的是「最近一次快照」，不精确对应每个错误的时间点。
 */
export interface SessionRow {
  sessionId: string
  userId?: string
  startedAt: number
  endedAt: number
  durationMs: number
  pageViews: number
  entryPage?: string
  exitPage?: string
  /** 访问路径 */
  path: string[]
  browser?: string
  os?: string
  device?: string
  referrer?: string
  /** 该会话的错误数 */
  errorCount: number
  /** 有没有回放流 */
  hasReplay: boolean
  /** 回放事件数 */
  replayEvents: number
  /** 回放字节数 */
  replayBytes: number
  replayUpdatedAt?: number
}

/**
 * 一条 rrweb 事件。
 *
 * `type` 是 rrweb 的事件编号：
 * 2 = 全量快照、3 = 增量快照、4 = Meta。
 * 播放器按编号分派，**编号错了就静默播不出来**。
 */
export interface ReplayStreamEvent {
  type: number
  timestamp: number
  data: unknown
}

export type BehaviorEventType = 'pageview' | 'route' | 'click' | 'blur' | 'focus'

/** 一条行为事件（会话时间线） */
export interface BehaviorEventRow {
  type: BehaviorEventType
  name: string
  url: string
  timestamp: number
  durationMs?: number
  data?: Record<string, unknown>
}

/** 行为汇总（服务端算好的） */
export interface BehaviorSummary {
  pageViews: number
  sessions: number
  users: number
  avgDurationMs: number
  topPages: Array<{ path: string; views: number; avgDurationMs: number; bounceRate: number }>
  entryPages: Array<{ path: string; count: number }>
  exitPages: Array<{ path: string; count: number }>
  topPaths: Array<{ path: string[]; count: number }>
  clicks: Array<{ name: string; count: number }>
  trend: Array<{ date: string; views: number; sessions: number }>
}

/* ============================================================
 * 领域词汇表 —— 中文标签
 * ============================================================ */

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  unresolved: '待处理',
  resolved: '已解决',
  archived: '已归档'
}

export const ISSUE_SUBSTATUS_LABELS: Record<IssueSubstatus, string> = {
  new: '新建',
  ongoing: '处理中',
  escalating: '升级中',
  regressed: '回归'
}

export const ISSUE_LEVEL_LABELS: Record<IssueLevel, string> = {
  fatal: '致命',
  error: '错误',
  warning: '警告',
  info: '提示'
}

export const ARCHIVE_STRATEGY_LABELS: Record<ArchiveStrategy, string> = {
  forever: '永久归档',
  until_escalating: '直到错误量突增',
  until_count: '直到发生 N 次',
  until_user_count: '直到影响 N 个用户'
}

export const ALERT_RULE_TYPE_LABELS: Record<AlertRuleType, { label: string; hint: string }> = {
  'issue.new': {
    label: '出现新问题',
    hint: '一旦有新的问题（指纹）上报就通知。适合发现新引入的线上故障。'
  },
  'issue.count': {
    label: '问题发生次数超阈值',
    hint: '同一条问题的累计发生次数超过阈值时通知。阈值单位是「次」。'
  },
  'issue.spike': {
    label: '问题发生次数突增',
    hint: '与历史窗口相比发生次数突然上涨时通知。适合抓突然爆发的错误。'
  },
  'metric.error_count': {
    label: '项目错误总数超阈值',
    hint: '整个项目在窗口内的错误总数超过阈值时通知。阈值单位是「次」。'
  },
  'metric.error_rate': {
    label: '项目错误率超阈值',
    hint: '错误数 / 事务数 超过阈值时通知。阈值是比率，如 0.05 表示 5%。'
  },
  'metric.lcp_p95': {
    label: 'LCP P95 超阈值',
    hint: '页面最大内容绘制的 P95 超过阈值时通知。阈值单位是「毫秒」。'
  }
}

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  webhook: 'Webhook',
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
  email: '邮件',
  slack: 'Slack'
}

export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  created: '创建',
  assigned: '分配负责人',
  unassigned: '取消分配',
  resolved: '已解决',
  archived: '已归档',
  unarchived: '解除归档',
  escalated: '自动升级',
  regressed: '回归',
  reviewed: '已阅',
  commented: '评论',
  bookmarked: '收藏',
  unbookmarked: '取消收藏',
  subscribed: '订阅',
  unsubscribed: '取消订阅',
  tag_added: '添加标签',
  tag_removed: '移除标签',
  level_changed: '级别变更',
  release_linked: '关联版本'
}

export const ACTOR_TYPE_LABELS: Record<'member' | 'system', string> = {
  member: '成员',
  system: '系统'
}

export const INCIDENT_STATUS_LABELS: Record<AlertIncident['status'], string> = {
  triggered: '已触发',
  resolved: '已恢复',
  muted: '已静默'
}

export const BEHAVIOR_TYPE_LABELS: Record<BehaviorEventType, string> = {
  pageview: '页面访问',
  route: '路由切换',
  click: '点击',
  blur: '失焦',
  focus: '聚焦'
}

/* ============================================================
 * 面板共享上下文
 * ============================================================ */

/**
 * 面板的共享上下文。
 *
 * 面板是「单项目上下文」—— 侧边栏选中的项目决定了所有页面看的是哪份数据，
 * 所以这份状态由 AppLayout 持有，通过 provide/inject 分发。
 */
export interface PanelContext {
  organizations: OrganizationRow[]
  projects: ProjectRow[]
  organizationId: number | null
  projectId: number | null
  project: ProjectRow | null
  loadingProjects: boolean
  projectsError: string
  /** 自动刷新计数：顶栏每 10 秒 +1，页面 watch 它来重载数据 */
  refreshToken: number
  selectOrganization(id: number): void
  selectProject(id: number): void
  requestRefresh(): void
}

export const PANEL_CONTEXT: InjectionKey<PanelContext> = Symbol('vigil-panel-context')
