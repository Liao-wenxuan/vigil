import type { Db } from '../../infra/db/client.js'

/**
 * 保留策略执行器。
 *
 * ## 为什么必须有
 *
 * `projects.retention_days` 之前只是个字段：建项目时写进去，之后没人读。
 * 结果是一张只增不减的表 —— 回放单会话几百 KB，
 * 一天一千个会话就是 GB 级增长，三个月后不是「查询变慢」，是磁盘满。
 *
 * 企业级产品的第一条硬指标是**存储有界**：给它一个天数，
 * 它就必须保证超过天数的数据真的会消失。
 *
 * ## 三个必须守住的点
 *
 * 1. **分批删**：一条 `DELETE` 删十万行会长时间持锁，
 *    期间上报全部排队。按批删，每批之间让出执行权。
 * 2. **每轮有上限**：积压了半年数据时，一轮清理不能把 CPU 吃干。
 *    跑不完下一轮继续，反正每小时都跑。
 * 3. **不允许重入**：上一轮还没跑完（大库可能跑几分钟），
 *    下一次定时器触发必须直接跳过，否则会叠出一堆并发删除。
 */
const DAY_MS = 24 * 3600_000

/** 要被裁剪的表。表名是**内部常量**，不接受外部输入 —— 这里没有注入面 */
const TARGETS = [
  { key: 'issueEvents', table: 'issue_events', column: 'occurred_at' },
  { key: 'replayEvents', table: 'replay_events', column: 'timestamp' },
  { key: 'behaviorEvents', table: 'behavior_events', column: 'timestamp' },
  { key: 'transactions', table: 'transactions', column: 'started_at' },
  { key: 'sessions', table: 'replay_sessions', column: 'started_at' }
] as const

export type RetentionTarget = (typeof TARGETS)[number]['key']

export interface RetentionReport {
  /** 实际清理的项目数（retention_days <= 0 的不算） */
  projects: number
  deleted: Record<RetentionTarget, number>
  durationMs: number
  /** 上一轮还在跑，本轮直接跳过 */
  skipped: boolean
}

export interface RetentionOptions {
  /** 单条 DELETE 的批大小 */
  batchSize?: number
  /** 每张表每轮最多跑几批（防止积压时长时间占用） */
  maxBatches?: number
  /** 注入时间源，测试用 */
  now?: () => number
}

const EMPTY_DELETED = (): Record<RetentionTarget, number> => ({
  issueEvents: 0,
  replayEvents: 0,
  behaviorEvents: 0,
  transactions: 0,
  sessions: 0
})

export class RetentionService {
  private readonly batchSize: number
  private readonly maxBatches: number
  private readonly now: () => number

  /** 重入闸门：定时器不会等上一轮跑完 */
  private running = false

  constructor(
    private readonly db: Db,
    options: RetentionOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 5000
    this.maxBatches = options.maxBatches ?? 20
    this.now = options.now ?? Date.now
  }

  /** 全量扫一遍：按每个项目自己的 retention_days 裁剪 */
  async sweep(): Promise<RetentionReport> {
    if (this.running) {
      return { projects: 0, deleted: EMPTY_DELETED(), durationMs: 0, skipped: true }
    }

    this.running = true
    const startedAt = Date.now()

    try {
      const projects = await this.db.all<{ id: number; retention_days: number }>(
        'SELECT id, retention_days FROM projects'
      )

      const deleted = EMPTY_DELETED()
      let swept = 0
      const now = this.now()

      for (const project of projects) {
        const days = Number(project.retention_days)
        // <= 0 表示「永久保留」，这是明确的语义，不是漏配
        if (!Number.isFinite(days) || days <= 0) continue

        const cutoff = now - days * DAY_MS
        const counts = await this.sweepProject(Number(project.id), cutoff)

        for (const target of TARGETS) deleted[target.key] += counts[target.key]
        swept++
      }

      return { projects: swept, deleted, durationMs: Date.now() - startedAt, skipped: false }
    } finally {
      this.running = false
    }
  }

  /**
   * 裁掉单个项目里早于 cutoff 的数据。
   *
   * 单独暴露是因为测试要能精确控制 cutoff ——
   * 靠 `sweep()` 只能按项目配置的天数走，测不出边界。
   */
  async sweepProject(projectId: number, cutoff: number): Promise<Record<RetentionTarget, number>> {
    const deleted = EMPTY_DELETED()

    for (const target of TARGETS) {
      deleted[target.key] = await this.deleteBatched(target.table, target.column, projectId, cutoff)
    }

    return deleted
  }

  /**
   * 分批删。
   *
   * ⚠️ 用 `id IN (SELECT ... LIMIT ?)` 而不是 `DELETE ... LIMIT ?` ——
   *    后者是 SQLite 的编译期可选特性，PG 根本不支持。
   *    子查询里的 LIMIT 是标准 SQL，两边都认。
   */
  private async deleteBatched(
    table: string,
    column: string,
    projectId: number,
    cutoff: number
  ): Promise<number> {
    let total = 0

    for (let round = 0; round < this.maxBatches; round++) {
      const result = await this.db.run(
        `DELETE FROM ${table} WHERE id IN (
           SELECT id FROM ${table} WHERE project_id = ? AND ${column} < ? LIMIT ?
         )`,
        [projectId, cutoff, this.batchSize]
      )

      total += result.changes
      // 没删满一批说明已经清完了，不用再跑一轮空查询
      if (result.changes < this.batchSize) break
    }

    return total
  }
}
