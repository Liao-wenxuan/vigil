/**
 * 租户域的线上契约。
 *
 * 层级：**组织 → 团队 → 项目**。
 * 项目才是真正被监控的对象（一个前端应用）。
 * 一个组织可以有多个团队，一个团队负责多个项目。
 */

/** 组织级角色 */
export type MemberRole = 'owner' | 'admin' | 'member'

/** 项目级角色 */
export type ProjectRole = 'owner' | 'writer' | 'reader'

/**
 * 项目密钥类型。
 *
 * 两种密钥严格分离：
 * - `runtime`：进前端代码，用于上报
 * - `upload`：只在 CI 里，用于上传 sourcemap
 *
 * 拿��� runtime 密钥只能刷错误数据；拿到 upload 密钥就能污染别人项目的错误栈。
 */
export type ProjectKeyKind = 'runtime' | 'upload'

/** 通知通道类型 */
export type ChannelType = 'webhook' | 'feishu' | 'dingtalk' | 'email' | 'slack'

/** 告警规则类型 */
export type AlertRuleType =
  /** 出现新问题 */
  | 'issue.new'
  /** 某个问题的发生次数超阈值 */
  | 'issue.count'
  /** 某个问题的发生次数突增 */
  | 'issue.spike'
  /** 项目错误率超阈值 */
  | 'metric.error_rate'
  /** 项目错误总数超阈值 */
  | 'metric.error_count'
  /** LCP P95 超阈值 */
  | 'metric.lcp_p95'

/** 告警规则的条件（全部为 AND 关系） */
export interface AlertConditions {
  environment?: string[]
  release?: string[]
  category?: string[]
  level?: string[]
  /** 只看这些标签 */
  tags?: Array<{ key: string; value: string }>
  /** 只看这些负责人 */
  assigneeIds?: number[]
}

export interface AlertRule {
  id: number
  projectId: number
  name: string
  type: AlertRuleType
  conditions: AlertConditions
  /** 阈值：次数 / 错误率 / 毫秒 */
  threshold: number
  /** 评估窗口（秒） */
  windowSeconds: number
  /** 通知通道 ID */
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
  /** 类型相关的配置：webhook URL、飞书机器人 webhook、钉钉机器人、SMTP 收件人 */
  config: Record<string, unknown>
  createdAt: number
}

export type AlertIncidentStatus = 'triggered' | 'resolved' | 'muted'

export interface AlertIncident {
  id: number
  ruleId: number
  projectId: number
  issueId?: number
  status: AlertIncidentStatus
  triggeredAt: number
  resolvedAt?: number
  /** 去重键：同一个键在窗口内不重复告警 */
  dedupeKey: string
  /** 触发时的上下文快照 */
  payload: Record<string, unknown>
}

export interface Organization {
  id: number
  slug: string
  name: string
  createdAt: number
  memberCount?: number
  projectCount?: number
}

export interface Team {
  id: number
  organizationId: number
  slug: string
  name: string
  createdAt: number
  memberCount?: number
}

export interface Member {
  id: number
  organizationId: number
  email: string
  name: string
  role: MemberRole
  createdAt: number
}

export interface Project {
  id: number
  organizationId: number
  teamId?: number
  slug: string
  name: string
  /** 平台：javascript / typescript / vue / react … */
  platform: string
  createdAt: number
  /** 数据保留天数 */
  retentionDays: number
  /** 事件配额（超出后拒绝摄入） */
  eventQuota: number
  memberCount?: number
}

export interface Environment {
  id: number
  projectId: number
  slug: string
  name: string
  /** 生产环境标记 —— 告警规则常按这个筛 */
  isProduction: boolean
  createdAt: number
}

export interface Release {
  id: number
  projectId: number
  version: string
  commitSha?: string
  createdAt: number
  deployedAt?: number
  /** 该版本引入的问题数 */
  introducedIssues?: number
}
