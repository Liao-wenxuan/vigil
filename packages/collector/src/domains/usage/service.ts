import type { Db } from '../../infra/db/client.js'
import { AppError } from '../../shared/errors.js'
import type { ProjectRow } from '../tenancy/service.js'

/**
 * 项目用量。
 *
 * ## 为什么要有这张表
 *
 * 配额检查在**每一个上报请求**的热路径上。之前的实现是
 * `SELECT COUNT(*) FROM issue_events WHERE project_id = ?` ——
 * 那条语句的成本随事件数线性增长，而它会被最频繁的接口调用。
 *
 * 一次主键点查是 O(1)，`COUNT(*)` 是 O(n)。这是「能不能扛住流量」
 * 和「不能」的区别，不是风格问题。
 *
 * ## 为什么单调递增
 *
 * 保留策略会删掉过期事件。如果配额看「现存行数」，
 * 项目只要等 retention 跑完配额就自己回来了 —— 配额形同虚设。
 * 所以 `events_total` 只增不减。
 */
export interface UsageSnapshot {
  /** 累计摄入的事件条数 */
  eventsTotal: number
  /** 配额上限，0 表示不限 */
  eventQuota: number
}

export class UsageService {
  constructor(private readonly db: Db) {}

  async snapshot(project: ProjectRow): Promise<UsageSnapshot> {
    return {
      eventsTotal: await this.eventsTotal(project.id),
      eventQuota: project.event_quota
    }
  }

  /**
   * 读累计用量。
   *
   * 行不存在时按现存事件数补建一次 —— 兜住两种漏建：
   * 迁移之前的老库、以及直接用 SQL 插进来的项目（种子脚本）。
   * 补建用 `ON CONFLICT DO NOTHING`，并发下也不会覆盖真实计数。
   */
  async eventsTotal(projectId: number): Promise<number> {
    const row = await this.db.get<{ events_total: number }>(
      'SELECT events_total FROM project_usage WHERE project_id = ?',
      [projectId]
    )
    if (row) return Number(row.events_total)

    await this.db.run(
      `INSERT INTO project_usage (project_id, events_total, updated_at)
       SELECT ?, COUNT(*), ? FROM issue_events WHERE project_id = ?
       ON CONFLICT DO NOTHING`,
      [projectId, Date.now(), projectId]
    )

    const created = await this.db.get<{ events_total: number }>(
      'SELECT events_total FROM project_usage WHERE project_id = ?',
      [projectId]
    )
    return Number(created?.events_total ?? 0)
  }

  /**
   * 累加用量。
   *
   * 用一条 UPSERT 完成，不做「先读后写」——
   * 两个并发上报会读到同一个旧值，各自加一，最后少算一次。
   */
  async addEvents(projectId: number, delta: number): Promise<void> {
    if (delta <= 0) return
    await this.db.run(
      `INSERT INTO project_usage (project_id, events_total, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         events_total = project_usage.events_total + excluded.events_total,
         updated_at = excluded.updated_at`,
      [projectId, delta, Date.now()]
    )
  }

  /** 配额闸门：超限抛 429，由上报接口直接返回给 SDK */
  async assertWithinQuota(project: ProjectRow, incoming: number): Promise<void> {
    if (!project.event_quota || project.event_quota <= 0) return

    const used = await this.eventsTotal(project.id)
    if (used + incoming > project.event_quota) {
      throw AppError.tooManyRequests(
        `项目 ${project.slug} 的事件配额已用尽（${used}/${project.event_quota}）`
      )
    }
  }
}
