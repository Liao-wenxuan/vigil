import type { Db } from '../../infra/db/client.js'
import { fromBool, readJson, writeJson } from '../../infra/db/dialect.js'
import { AppError } from '../../shared/errors.js'
import type { AlertMessage } from './channels.js'
import type {
  AlertConditions,
  AlertDelivery,
  AlertIncident,
  AlertRule,
  ChannelType,
  NotificationChannel
} from '@vigil/protocol'

/**
 * 告警域：规则、通道、触发记录。
 */
export class AlertingService {
  constructor(private readonly db: Db) {}

  // ---- 规则 ----

  async createRule(input: {
    projectId: number
    name: string
    type: AlertRule['type']
    conditions?: AlertConditions
    threshold?: number
    windowSeconds?: number
    channelIds?: number[]
    createdBy?: number
  }): Promise<AlertRule> {
    const now = Date.now()

    const insertedId = await this.db.insert(
      `INSERT INTO alert_rules
         (project_id, name, type, conditions_json, threshold, window_seconds,
          channel_ids_json, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        input.projectId,
        input.name,
        input.type,
        writeJson(input.conditions ?? {}),
        input.threshold ?? 1,
        input.windowSeconds ?? 300,
        writeJson(input.channelIds ?? []),
        input.createdBy ?? null,
        now,
        now
      ]
    )

    return await this.getRule(input.projectId, insertedId)
  }

  /**
   * 取一条告警规则。
   *
   * ⚠️ **必须带 projectId** —— 规则和通道都是「按 id 就能定位到别的项目」的资源，
   *    只按 id 查等于把租户范围交给调用方保证。
   */
  async getRule(projectId: number, id: number): Promise<AlertRule> {
    const row = await this.db.get<{
      id: number
      project_id: number
      name: string
      type: string
      conditions_json: string | null
      threshold: number
      window_seconds: number
      channel_ids_json: string | null
      enabled: number
      created_by: number | null
      created_at: number
      updated_at: number
    }>('SELECT * FROM alert_rules WHERE id = ? AND project_id = ?', [id, projectId])

    if (!row) throw AppError.notFound('告警规则')
    return toRule(row)
  }

  async listRules(projectId: number): Promise<AlertRule[]> {
    return (
      await this.db.all<Parameters<typeof toRule>[0]>(
        'SELECT * FROM alert_rules WHERE project_id = ? ORDER BY id',
        [projectId]
      )
    ).map(toRule)
  }

  async updateRule(
    projectId: number,
    id: number,
    patch: Partial<{
      name: string
      type: AlertRule['type']
      conditions: AlertConditions
      threshold: number
      windowSeconds: number
      channelIds: number[]
      enabled: boolean
    }>
  ): Promise<AlertRule> {
    const current = await this.getRule(projectId, id)
    const now = Date.now()

    await this.db.run(
      `UPDATE alert_rules SET
         name = ?, type = ?, conditions_json = ?, threshold = ?, window_seconds = ?,
         channel_ids_json = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND project_id = ?`,
      [
        patch.name ?? current.name,
        patch.type ?? current.type,
        writeJson(patch.conditions ?? current.conditions),
        patch.threshold ?? current.threshold,
        patch.windowSeconds ?? current.windowSeconds,
        writeJson(patch.channelIds ?? current.channelIds),
        (patch.enabled ?? current.enabled) ? 1 : 0,
        now,
        id,
        projectId
      ]
    )

    return await this.getRule(projectId, id)
  }

  async deleteRule(projectId: number, id: number): Promise<void> {
    await this.db.run('DELETE FROM alert_rules WHERE id = ? AND project_id = ?', [id, projectId])
  }

  // ---- 通道 ----

  async createChannel(input: {
    projectId: number
    name: string
    type: ChannelType
    config: Record<string, unknown>
  }): Promise<NotificationChannel> {
    const insertedId = await this.db.insert(
      'INSERT INTO notification_channels (project_id, name, type, config_json, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [input.projectId, input.name, input.type, writeJson(input.config), Date.now()]
    )
    return await this.getChannel(input.projectId, insertedId)
  }

  /** 取一个通知通道 —— 和规则一样，必须带 projectId */
  async getChannel(projectId: number, id: number): Promise<NotificationChannel> {
    const row = await this.db.get<{
      id: number
      project_id: number
      name: string
      type: string
      config_json: string | null
      enabled: number
      created_at: number
    }>('SELECT * FROM notification_channels WHERE id = ? AND project_id = ?', [id, projectId])

    if (!row) throw AppError.notFound('通知通道')
    return toChannel(row)
  }

  async listChannels(projectId: number): Promise<NotificationChannel[]> {
    return (
      await this.db.all<Parameters<typeof toChannel>[0]>(
        'SELECT * FROM notification_channels WHERE project_id = ? ORDER BY id',
        [projectId]
      )
    ).map(toChannel)
  }

  async updateChannel(
    projectId: number,
    id: number,
    patch: Partial<{
      name: string
      type: ChannelType
      config: Record<string, unknown>
      enabled: boolean
    }>
  ): Promise<NotificationChannel> {
    const current = await this.getChannel(projectId, id)

    await this.db.run(
      `UPDATE notification_channels
       SET name = ?, type = ?, config_json = ?, enabled = ?
       WHERE id = ? AND project_id = ?`,
      [
        patch.name ?? current.name,
        patch.type ?? current.type,
        writeJson(patch.config ?? current.config),
        (patch.enabled ?? current.enabled) ? 1 : 0,
        id,
        projectId
      ]
    )

    return await this.getChannel(projectId, id)
  }

  async deleteChannel(projectId: number, id: number): Promise<void> {
    await this.db.run('DELETE FROM notification_channels WHERE id = ? AND project_id = ?', [
      id,
      projectId
    ])
  }

  // ---- 触发记录 ----

  /**
   * 判断这次触发是否应该被**去重**掉。
   *
   * 告警疲劳是监控系统最大的敌人：同一个错误每分钟报 100 次，
   * 没有人会去看。所以同一个 (规则, 问题, 时间窗) 只发一次。
   *
   * 去重键里带**时间窗编号**，窗口一过就允许重新触发 ——
   * 这正是我们想要的：持续恶化的问题每个窗口都会再提醒一次。
   */
  async shouldTrigger(dedupeKey: string): Promise<boolean> {
    const existing = await this.db.get<{ id: number }>(
      'SELECT id FROM alert_incidents WHERE dedupe_key = ? ORDER BY triggered_at DESC LIMIT 1',
      [dedupeKey]
    )
    return !existing
  }

  async recordIncident(input: {
    ruleId: number
    projectId: number
    issueId?: number
    dedupeKey: string
    payload: Record<string, unknown>
  }): Promise<AlertIncident> {
    const now = Date.now()

    // `RETURNING id` —— SQLite 3.35+ 与 PG 都支持
    const id = await this.db.insert(
      `INSERT INTO alert_incidents
         (rule_id, project_id, issue_id, status, triggered_at, dedupe_key, payload_json)
       VALUES (?, ?, ?, 'triggered', ?, ?, ?)`,
      [
        input.ruleId,
        input.projectId,
        input.issueId ?? null,
        now,
        input.dedupeKey,
        writeJson(input.payload)
      ]
    )

    return {
      id,
      ruleId: input.ruleId,
      projectId: input.projectId,
      issueId: input.issueId,
      status: 'triggered',
      triggeredAt: now,
      dedupeKey: input.dedupeKey,
      payload: input.payload
    }
  }

  async listIncidents(projectId: number, limit = 50): Promise<AlertIncident[]> {
    const rows = await this.db.all<{
      id: number
      rule_id: number
      project_id: number
      issue_id: number | null
      status: string
      triggered_at: number
      resolved_at: number | null
      dedupe_key: string
      payload_json: string | null
    }>('SELECT * FROM alert_incidents WHERE project_id = ? ORDER BY triggered_at DESC LIMIT ?', [
      projectId,
      limit
    ])

    return rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      projectId: row.project_id,
      issueId: row.issue_id ?? undefined,
      status: row.status as AlertIncident['status'],
      triggeredAt: row.triggered_at,
      resolvedAt: row.resolved_at ?? undefined,
      dedupeKey: row.dedupe_key,
      payload: readJson<Record<string, unknown>>(row.payload_json) ?? {}
    }))
  }

  // ---- 投递死信 ----

  /**
   * 记一条**投递失败**的留档。
   *
   * 通道发不出去的消息不能只记一个 `delivered: 0` ——
   * 那等于把通知丢了，事后连「到底为什么没发出去」都查不到。
   * 留档之后才能人工重放。
   */
  async recordDeadDelivery(input: {
    projectId: number
    ruleId: number
    incidentId?: number
    channelId: number
    channelType: ChannelType
    attempts: number
    error?: string
    message: AlertMessage
  }): Promise<number> {
    const now = Date.now()
    return await this.db.insert(
      `INSERT INTO alert_deliveries
         (project_id, rule_id, incident_id, channel_id, channel_type, status,
          attempts, last_error, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'dead', ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        input.ruleId,
        input.incidentId ?? null,
        input.channelId,
        input.channelType,
        input.attempts,
        input.error ?? null,
        writeJson(input.message),
        now,
        now
      ]
    )
  }

  /** 列死信（按时间倒序） */
  async listDeadDeliveries(projectId: number, limit = 50): Promise<AlertDelivery[]> {
    const rows = await this.db.all<{
      id: number
      rule_id: number | null
      incident_id: number | null
      channel_id: number | null
      channel_type: string
      status: string
      attempts: number
      last_error: string | null
      payload_json: string | null
      created_at: number
      updated_at: number
    }>(
      `SELECT * FROM alert_deliveries
       WHERE project_id = ? AND status = 'dead'
       ORDER BY updated_at DESC LIMIT ?`,
      [projectId, limit]
    )

    return rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id ?? undefined,
      incidentId: row.incident_id ?? undefined,
      channelId: row.channel_id ?? undefined,
      channelType: row.channel_type as ChannelType,
      status: row.status as AlertDelivery['status'],
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      message: readJson<AlertMessage>(row.payload_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  /** 取一条死信（重放用） */
  async getDelivery(projectId: number, id: number): Promise<AlertDelivery | undefined> {
    const rows = await this.db.all<{
      id: number
      rule_id: number | null
      incident_id: number | null
      channel_id: number | null
      channel_type: string
      status: string
      attempts: number
      last_error: string | null
      payload_json: string | null
      created_at: number
      updated_at: number
    }>('SELECT * FROM alert_deliveries WHERE id = ? AND project_id = ?', [id, projectId])
    const row = rows[0]
    if (!row) return undefined
    return {
      id: row.id,
      ruleId: row.rule_id ?? undefined,
      incidentId: row.incident_id ?? undefined,
      channelId: row.channel_id ?? undefined,
      channelType: row.channel_type as ChannelType,
      status: row.status as AlertDelivery['status'],
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      message: readJson<AlertMessage>(row.payload_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  /** 重放结果写回（成功 → sent；仍失败 → 继续 dead，错误更新） */
  async markDelivery(id: number, ok: boolean, error?: string): Promise<void> {
    await this.db.run(
      `UPDATE alert_deliveries
       SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [ok ? 'sent' : 'dead', error ?? null, Date.now(), id]
    )
  }
}

function toRule(row: {
  id: number
  project_id: number
  name: string
  type: string
  conditions_json: string | null
  threshold: number
  window_seconds: number
  channel_ids_json: string | null
  enabled: number
  created_by: number | null
  created_at: number
  updated_at: number
}): AlertRule {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type as AlertRule['type'],
    conditions: readJson<AlertConditions>(row.conditions_json) ?? {},
    threshold: row.threshold,
    windowSeconds: row.window_seconds,
    channelIds: readJson<number[]>(row.channel_ids_json) ?? [],
    enabled: fromBool(row.enabled),
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toChannel(row: {
  id: number
  project_id: number
  name: string
  type: string
  config_json: string | null
  enabled: number
  created_at: number
}): NotificationChannel {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type as ChannelType,
    enabled: fromBool(row.enabled),
    config: readJson<Record<string, unknown>>(row.config_json) ?? {},
    createdAt: row.created_at
  }
}
