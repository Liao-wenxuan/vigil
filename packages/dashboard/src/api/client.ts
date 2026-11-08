/**
 * 类型化管理 API 客户端。
 *
 * ## 鉴权
 *
 * 管理员 token（超级管理员）**不在前端** —— 由 nginx 在通过 Basic Auth 后
 * 注入到 `/api` 请求头（见 deploy/nginx/）。这里只负责**成员凭据**
 * （`vmk_…`，含只读演示令牌）：
 *
 * - 用户在面板里登录的令牌存在 localStorage（`MEMBER_TOKEN_STORAGE`）
 * - 部署时注入的只读演示令牌存在 `window.VIGIL_DEMO_MEMBER_TOKEN`
 *
 * 两者都没有时，请求不带成员头，由 nginx 决定是否要求 Basic Auth。
 *
 * ## 错误
 *
 * 所有错误统一抛 `ApiError`，页面层用 `ElMessage.error` 兜住 ——
 * 监控面板自己静默失败是最糟的情况。
 */

import type {
  AlertConditions,
  AlertDelivery,
  AlertEvaluationResult,
  AlertIncident,
  AlertRule,
  AlertRuleType,
  ArchiveStrategy,
  BehaviorEventRow,
  BehaviorSummary,
  ChannelType,
  CreatedProject,
  EnvironmentRow,
  ErrorPerformanceRow,
  ErrorTrend,
  IssueBulkAction,
  IssueDetail,
  IssueQueryParams,
  IssueRow,
  IssueStats,
  NotificationChannel,
  OrganizationRow,
  PerformanceSummary,
  ProjectDetail,
  ProjectRow,
  ReleaseRow,
  ReplayStreamEvent,
  SessionRow,
  Slo,
  SloBurnRateWindow,
  SloBudgetPoint,
  SloEvaluation,
  SloWithEvaluation,
  TransactionRow
} from '../types'

const BASE = '/api/v1'

/**
 * 成员凭据（vmk_…）来源，按优先级：
 *
 * 1. 用户自己在面板里登录的令牌（localStorage `vigil.memberToken`）
 * 2. 部署时注入的**只读演示令牌**（`window.VIGIL_DEMO_MEMBER_TOKEN`，
 *    由 nginx 启动脚本写进 /config.js）—— 让访客免登录即可看演示数据
 *
 * 管理员走的是另一套：nginx 在通过 Basic Auth 后注入 `x-vigil-admin-token`，
 * 前端不碰它。所以这里只负责「成员 / 演示」这一类凭据。
 */
export const MEMBER_TOKEN_STORAGE = 'vigil.memberToken'

function resolveMemberToken(): string | null {
  const user = localStorage.getItem(MEMBER_TOKEN_STORAGE)
  if (user && user.length > 0) return user
  const demo = (window as unknown as { VIGIL_DEMO_MEMBER_TOKEN?: string }).VIGIL_DEMO_MEMBER_TOKEN
  return demo && demo.length > 0 ? demo : null
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface ApiEnvelope {
  ok?: boolean
  error?: string
  code?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    const memberToken = resolveMemberToken()
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(memberToken ? { 'x-vigil-member-token': memberToken } : {}),
        ...(init?.headers ?? {})
      }
    })
  } catch (error) {
    throw new ApiError(`网络请求失败：${error instanceof Error ? error.message : String(error)}`, 0)
  }

  const text = await response.text()
  let body: ApiEnvelope & Partial<T>
  try {
    body = text ? (JSON.parse(text) as ApiEnvelope & Partial<T>) : {}
  } catch {
    throw new ApiError(`响应不是合法 JSON（HTTP ${response.status}）`, response.status)
  }

  if (!response.ok || body.ok === false) {
    throw new ApiError(body.error ?? `请求失败（HTTP ${response.status}）`, response.status)
  }

  return body as T
}

function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === '') continue
    query.set(key, String(value))
  }
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request<T>(`${path}${suffix}`)
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

/* ============================================================
 * 组织与项目
 * ============================================================ */

export async function listOrganizations(): Promise<OrganizationRow[]> {
  const body = await get<{ organizations: OrganizationRow[] }>('/organizations')
  return body.organizations ?? []
}

/** 当前身份。用来在界面上说明「你现在是谁、能干什么」。 */
export interface CurrentPrincipal {
  kind: 'superadmin' | 'member'
  actorType: 'system' | 'member'
  organizationId: number | null
  email: string | null
  orgRole: 'owner' | 'admin' | 'member'
}

/**
 * 问后端「我是谁」。
 *
 * 三条通道会给出三种答案：
 *   - 匿名 + 只读演示令牌 → member（orgRole=member，只有读权限）
 *   - 成员令牌           → member（orgRole 取决于该成员的组织角色）
 *   - 面板登录           → superadmin
 *
 * 失败（401/403）时返回 null —— 没登录也是合法状态，别抛异常。
 */
export async function fetchCurrentPrincipal(): Promise<CurrentPrincipal | null> {
  try {
    const body = await get<{ principal: CurrentPrincipal | null }>('/me')
    return body.principal ?? null
  } catch {
    return null
  }
}

export function createOrganization(name: string): Promise<OrganizationRow> {
  return post<{ organization: OrganizationRow }>('/organizations', { name }).then(
    (body) => body.organization
  )
}

export async function listProjects(organizationId: number): Promise<ProjectRow[]> {
  const body = await get<{ projects: ProjectRow[] }>(`/organizations/${organizationId}/projects`)
  return body.projects ?? []
}

export function createProject(
  organizationId: number,
  input: {
    name: string
    slug?: string
    teamId?: number
    platform?: string
    retentionDays?: number
    eventQuota?: number
  }
): Promise<CreatedProject> {
  return post<{ project: ProjectRow; runtimeKey: string; uploadKey: string }>(
    `/organizations/${organizationId}/projects`,
    input
  ).then((body) => ({
    project: body.project,
    runtimeKey: body.runtimeKey,
    uploadKey: body.uploadKey
  }))
}

export async function getProject(projectId: number): Promise<ProjectDetail> {
  const body = await get<{
    project: ProjectRow
    environments: EnvironmentRow[]
    releases: ReleaseRow[]
  }>(`/projects/${projectId}`)
  return {
    project: body.project,
    environments: body.environments ?? [],
    releases: body.releases ?? []
  }
}

export function createEnvironment(
  projectId: number,
  input: { slug: string; name: string; isProduction?: boolean }
): Promise<EnvironmentRow> {
  return post<{ environment: EnvironmentRow }>(`/projects/${projectId}/environments`, input).then(
    (body) => body.environment
  )
}

export function createRelease(
  projectId: number,
  input: { version: string; commitSha?: string }
): Promise<ReleaseRow> {
  return post<{ release: ReleaseRow }>(`/projects/${projectId}/releases`, input).then(
    (body) => body.release
  )
}

export function rotateProjectKey(
  projectId: number,
  kind: 'runtime' | 'upload'
): Promise<{ kind: 'runtime' | 'upload'; key: string }> {
  return post<{ kind: 'runtime' | 'upload'; key: string }>(`/projects/${projectId}/keys/rotate`, {
    kind
  })
}

/* ============================================================
 * 问题
 * ============================================================ */

export async function listIssues(
  projectId: number,
  params: IssueQueryParams = {}
): Promise<{ total: number; issues: IssueRow[] }> {
  const body = await get<{ total: number; issues: IssueRow[] }>(`/projects/${projectId}/issues`, {
    status: params.status,
    substatus: params.substatus,
    category: params.category,
    level: params.level,
    environment: params.environment,
    release: params.release,
    q: params.q,
    limit: params.limit,
    offset: params.offset,
    sort: params.sort,
    since: params.since,
    until: params.until
  })
  return { total: body.total ?? 0, issues: body.issues ?? [] }
}

export async function getIssue(projectId: number, issueId: number): Promise<IssueDetail> {
  const body = await get<{ issue: IssueDetail }>(`/projects/${projectId}/issues/${issueId}`)
  return body.issue
}

export function resolveIssue(
  projectId: number,
  issueId: number,
  input: { release?: string; reason?: string; actorId?: number }
): Promise<IssueDetail> {
  return post<{ issue: IssueDetail }>(
    `/projects/${projectId}/issues/${issueId}/resolve`,
    input
  ).then((body) => body.issue)
}

export function archiveIssue(
  projectId: number,
  issueId: number,
  input: {
    strategy?: ArchiveStrategy
    untilCount?: number
    untilUserCount?: number
    reason?: string
  }
): Promise<IssueDetail> {
  return post<{ issue: IssueDetail }>(
    `/projects/${projectId}/issues/${issueId}/archive`,
    input
  ).then((body) => body.issue)
}

export function unarchiveIssue(
  projectId: number,
  issueId: number,
  input: { reason?: string } = {}
): Promise<IssueDetail> {
  return post<{ issue: IssueDetail }>(
    `/projects/${projectId}/issues/${issueId}/unarchive`,
    input
  ).then((body) => body.issue)
}

export function markIssueSeen(
  projectId: number,
  issueId: number,
  input: { reason?: string } = {}
): Promise<IssueDetail> {
  return post<{ issue: IssueDetail }>(`/projects/${projectId}/issues/${issueId}/seen`, input).then(
    (body) => body.issue
  )
}

export function assignIssue(
  projectId: number,
  issueId: number,
  input: { memberId: number; reason?: string }
): Promise<IssueDetail> {
  return post<{ issue: IssueDetail }>(
    `/projects/${projectId}/issues/${issueId}/assign`,
    input
  ).then((body) => body.issue)
}

export function commentIssue(
  projectId: number,
  issueId: number,
  body: string
): Promise<IssueDetail> {
  return post<{ issue: IssueDetail }>(`/projects/${projectId}/issues/${issueId}/comments`, {
    body
  }).then((body) => body.issue)
}

export function setIssueBookmark(
  projectId: number,
  issueId: number,
  bookmarked: boolean
): Promise<IssueDetail> {
  return post<{ issue: IssueDetail }>(`/projects/${projectId}/issues/${issueId}/bookmark`, {
    bookmarked
  }).then((body) => body.issue)
}

export function bulkIssueAction(
  projectId: number,
  input: {
    issueIds: number[]
    action: IssueBulkAction
    archiveStrategy?: ArchiveStrategy
    release?: string
    reason?: string
  }
): Promise<number> {
  return post<{ affected: number }>(`/projects/${projectId}/issues/bulk`, input).then(
    (body) => body.affected ?? 0
  )
}

export async function getIssueStats(
  projectId: number,
  params: { since?: number; until?: number } = {}
): Promise<IssueStats> {
  const body = await get<{ stats: IssueStats }>(`/projects/${projectId}/stats`, params)
  return body.stats
}

/**
 * 错误趋势。
 *
 * `tzOffset` 让「按天」的桶边界对齐用户本地午夜 ——
 * 不传的话会按 UTC 切，中国用户看到的「今天」要到早上 8 点才开始。
 */
export async function getErrorTrend(
  projectId: number,
  params: { since?: number; until?: number; bucket?: 'hour' | 'day'; tzOffset?: number }
): Promise<ErrorTrend> {
  const body = await get<{ trend: ErrorTrend }>(`/projects/${projectId}/issues/trend`, {
    since: params.since,
    until: params.until,
    bucket: params.bucket,
    tzOffset: params.tzOffset
  })
  return body.trend
}

/* ============================================================
 * 性能
 * ============================================================ */

export async function getPerformanceSummary(
  projectId: number,
  params: { environment?: string; release?: string; since?: number; until?: number } = {}
): Promise<PerformanceSummary> {
  const body = await get<{ summary: PerformanceSummary }>(
    `/projects/${projectId}/performance`,
    params
  )
  return body.summary
}

export async function listTransactions(
  projectId: number,
  params: {
    limit?: number
    offset?: number
    environment?: string
    release?: string
  } = {}
): Promise<{ total: number; transactions: TransactionRow[] }> {
  const body = await get<{ total: number; transactions: TransactionRow[] }>(
    `/projects/${projectId}/transactions`,
    params
  )
  return { total: body.total ?? 0, transactions: body.transactions ?? [] }
}

export async function getErrorPerformance(
  projectId: number,
  since?: number
): Promise<ErrorPerformanceRow[]> {
  const body = await get<{ rows: ErrorPerformanceRow[] }>(
    `/projects/${projectId}/error-performance`,
    { since }
  )
  return body.rows ?? []
}

/* ============================================================
 * 告警
 * ============================================================ */

export async function listAlertRules(projectId: number): Promise<AlertRule[]> {
  const body = await get<{ rules: AlertRule[] }>(`/projects/${projectId}/alert-rules`)
  return body.rules ?? []
}

export function createAlertRule(
  projectId: number,
  input: {
    name: string
    type: AlertRuleType
    conditions?: AlertConditions
    threshold?: number
    windowSeconds?: number
    channelIds?: number[]
  }
): Promise<AlertRule> {
  return post<{ rule: AlertRule }>(`/projects/${projectId}/alert-rules`, input).then(
    (body) => body.rule
  )
}

export function updateAlertRule(
  projectId: number,
  ruleId: number,
  input: {
    name?: string
    type?: AlertRuleType
    conditions?: AlertConditions
    threshold?: number
    windowSeconds?: number
    channelIds?: number[]
    enabled?: boolean
  }
): Promise<AlertRule> {
  return patch<{ rule: AlertRule }>(`/projects/${projectId}/alert-rules/${ruleId}`, input).then(
    (body) => body.rule
  )
}

export function deleteAlertRule(projectId: number, ruleId: number): Promise<void> {
  return del<{ ok: boolean }>(`/projects/${projectId}/alert-rules/${ruleId}`).then(() => undefined)
}

export async function listChannels(projectId: number): Promise<NotificationChannel[]> {
  const body = await get<{ channels: NotificationChannel[] }>(`/projects/${projectId}/channels`)
  return body.channels ?? []
}

export function createChannel(
  projectId: number,
  input: { name: string; type: ChannelType; config: Record<string, unknown> }
): Promise<NotificationChannel> {
  return post<{ channel: NotificationChannel }>(`/projects/${projectId}/channels`, input).then(
    (body) => body.channel
  )
}

export async function listAlertIncidents(projectId: number): Promise<AlertIncident[]> {
  const body = await get<{ incidents: AlertIncident[] }>(`/projects/${projectId}/alert-incidents`)
  return body.incidents ?? []
}

export async function evaluateAlerts(projectId: number): Promise<AlertEvaluationResult> {
  const body = await post<{ result: AlertEvaluationResult }>(
    `/projects/${projectId}/alerts/evaluate`
  )
  return body.result
}

/* ============================================================
 * 投递死信
 * ============================================================ */

/** 通道发不出去的通知 —— 留档待重放 */
export async function listAlertDeliveries(projectId: number): Promise<AlertDelivery[]> {
  const body = await get<{ deliveries: AlertDelivery[] }>(`/projects/${projectId}/alert-deliveries`)
  return body.deliveries ?? []
}

/** 重放一条死信 */
export async function retryAlertDelivery(
  projectId: number,
  deliveryId: number
): Promise<{ delivered: boolean; error?: string }> {
  const body = await post<{ delivered: boolean; error?: string }>(
    `/projects/${projectId}/alert-deliveries/${deliveryId}/retry`,
    {}
  )
  return body
}

/* ============================================================
 * SLO 与错误预算
 * ============================================================ */

/** 列表 —— 定义和当前状态**一起**返回，省得面板发两次请求再自己拼 */
export async function listSlos(projectId: number): Promise<SloWithEvaluation[]> {
  const body = await get<{ slos: SloWithEvaluation[] }>(`/projects/${projectId}/slos`)
  return body.slos ?? []
}

/** 详情 —— 带燃烧率窗口 */
export async function getSlo(
  projectId: number,
  sloId: number
): Promise<{ slo: Slo; evaluation: SloEvaluation; burnRates: SloBurnRateWindow[] }> {
  return await get<{
    slo: Slo
    evaluation: SloEvaluation
    burnRates: SloBurnRateWindow[]
  }>(`/projects/${projectId}/slos/${sloId}`)
}

export async function getSloBudget(
  projectId: number,
  sloId: number
): Promise<{ sloId: number; points: SloBudgetPoint[] }> {
  return await get<{ sloId: number; points: SloBudgetPoint[] }>(
    `/projects/${projectId}/slos/${sloId}/budget`
  )
}

export function createSlo(
  projectId: number,
  input: {
    name: string
    target: number
    windowSeconds: number
    stepSeconds?: number
    enabled?: boolean
  }
): Promise<Slo> {
  return post<{ slo: Slo }>(`/projects/${projectId}/slos`, input).then((body) => body.slo)
}

export function updateSlo(
  projectId: number,
  sloId: number,
  input: {
    name?: string
    target?: number
    windowSeconds?: number
    stepSeconds?: number
    enabled?: boolean
  }
): Promise<Slo> {
  return patch<{ slo: Slo }>(`/projects/${projectId}/slos/${sloId}`, input).then((body) => body.slo)
}

export function deleteSlo(projectId: number, sloId: number): Promise<void> {
  return del<{ ok: boolean }>(`/projects/${projectId}/slos/${sloId}`).then(() => undefined)
}

/* ============================================================
 * 会话回放
 * ============================================================ */

export async function listSessions(
  projectId: number,
  params: { limit?: number; offset?: number } = {}
): Promise<{ total: number; sessions: SessionRow[] }> {
  const body = await get<{ total: number; sessions: SessionRow[] }>(
    `/projects/${projectId}/sessions`,
    params
  )
  return { total: body.total ?? 0, sessions: body.sessions ?? [] }
}

/**
 * 取某个会话的回放事件流。
 *
 * 流的第一个事件必须是**全量快照**（rrweb 的 type=2）——
 * 播放器靠它建立 DOM 镜像。少了它，增量全部对不上，**静默播不出来**。
 */
export async function getSessionReplay(
  projectId: number,
  sessionId: string
): Promise<{ events: number; stream: ReplayStreamEvent[] }> {
  const body = await get<{ events: number; stream: ReplayStreamEvent[] }>(
    `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/replay`
  )
  return { events: body.events ?? 0, stream: body.stream ?? [] }
}

/** 某个会话的行为时间线 */
export async function getSessionEvents(
  projectId: number,
  sessionId: string
): Promise<BehaviorEventRow[]> {
  const body = await get<{ events: BehaviorEventRow[] }>(
    `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/events`
  )
  return body.events ?? []
}

/**
 * 某个问题最近一次发生所属会话的回放。
 *
 * 回放按会话存最新一份，所以不是每个错误都有精确对应的回放。
 */
export async function getIssueReplay(
  projectId: number,
  issueId: number
): Promise<{
  hasReplay: boolean
  sessionId?: string
  events: number
  stream: ReplayStreamEvent[]
}> {
  const body = await get<{
    hasReplay: boolean
    sessionId?: string
    events: number
    stream: ReplayStreamEvent[]
  }>(`/projects/${projectId}/issues/${issueId}/replay`)
  return {
    hasReplay: body.hasReplay ?? false,
    sessionId: body.sessionId,
    events: body.events ?? 0,
    stream: body.stream ?? []
  }
}

/* ============================================================
 * 用户行为
 * ============================================================ */

export async function getBehaviorSummary(
  projectId: number,
  params: { since?: number; until?: number } = {}
): Promise<BehaviorSummary> {
  const body = await get<{ summary: BehaviorSummary }>(
    `/projects/${projectId}/behavior/summary`,
    params
  )
  return body.summary
}
