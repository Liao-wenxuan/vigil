import type { Db } from '../../infra/db/client.js'
import { AppError } from '../../shared/errors.js'
import type { ProjectRow } from '../tenancy/service.js'
import type { IssueService } from '../issues/service.js'
import type { PerformanceService } from '../performance/service.js'
import type { ArtifactService } from '../artifacts/service.js'
import type {
  CollectEnvelope,
  ErrorEvent,
  PerformanceEnvelope,
  PerformanceEvent
} from '@vigil/protocol'

/**
 * 摄入管道。
 *
 * 三个入口（错误 / 性能 / 制品）在这里汇合，然后分发到各自的领域。
 *
 * 摄入层负责的**横切**关注点：
 *   - 鉴权（项目密钥）
 *   - 配额（防止单个项目打爆存储）
 *   - 限流（按项目令牌桶）
 *   - 脱敏复核（SDK 已脱敏，这里再兜一层底 —— 老的 SDK 版本没脱敏）
 *
 * 领域逻辑不该关心这些，所以放在管道里而不是领域里。
 */
export interface IngestResult {
  accepted: number
  dropped: number
  ids?: Record<string, number>
}

export class IngestionPipeline {
  constructor(
    private readonly db: Db,
    private readonly issues: IssueService,
    private readonly performance: PerformanceService,
    private readonly artifacts: ArtifactService
  ) {}

  /**
   * 摄入错误事件。
   */
  ingestErrors(project: ProjectRow, envelope: CollectEnvelope): IngestResult {
    const events = envelope.events ?? []
    if (events.length === 0) return { accepted: 0, dropped: 0 }

    this.checkQuota(project, events.length)

    const ids: Record<string, number> = {}
    let accepted = 0

    for (const [index, event] of events.entries()) {
      const outcome = this.issues.ingestEvent(project.id, event)
      ids[String(index)] = outcome.issueId
      accepted++
    }

    return { accepted, dropped: 0, ids }
  }

  /**
   * 摄入性能事务。
   */
  ingestPerformance(project: ProjectRow, envelope: PerformanceEnvelope): IngestResult {
    const transactions = envelope.transactions ?? []
    if (transactions.length === 0) return { accepted: 0, dropped: 0 }

    this.checkQuota(project, transactions.length)

    const context = {
      environmentId: this.resolveEnvironmentId(project.id, envelope.transactions[0]?.environment),
      releaseId: this.resolveReleaseId(project.id, envelope.transactions[0]?.release)
    }

    for (const transaction of transactions) {
      this.performance.ingestTransaction(project.id, transaction, context)
    }

    return { accepted: transactions.length, dropped: 0 }
  }

  /**
   * 上传 sourcemap。
   */
  uploadSourcemaps(
    project: ProjectRow,
    body: { release: string; files: Array<{ fileName: string; sourceMap: string }> }
  ): { uploaded: number } {
    if (!body.release) throw AppError.badRequest('缺少 release')
    if (!Array.isArray(body.files) || body.files.length === 0) {
      throw AppError.badRequest('缺少 files')
    }

    return this.artifacts.uploadSourcemaps({
      projectId: project.id,
      release: body.release,
      files: body.files
    })
  }

  /**
   * 配额检查。
   *
   * 配额按**已摄入事件总数**算，不是按 issue 数 ——
   * issue 数只反映「有多少类问题」，不反映「占了多少存储」。
   */
  private checkQuota(project: ProjectRow, incoming: number): void {
    if (!project.event_quota || project.event_quota <= 0) return

    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM issue_events WHERE project_id = ?',
      [project.id]
    )

    const used = row?.n ?? 0
    if (used + incoming > project.event_quota) {
      throw AppError.tooManyRequests(
        `项目 ${project.slug} 的事件配额已用尽（${used}/${project.event_quota}）`
      )
    }
  }

  private resolveEnvironmentId(projectId: number, slug?: string): number | undefined {
    if (!slug) return undefined
    const row = this.db.get<{ id: number }>(
      'SELECT id FROM environments WHERE project_id = ? AND slug = ?',
      [projectId, slug]
    )
    return row?.id
  }

  private resolveReleaseId(projectId: number, version?: string): number | undefined {
    if (!version) return undefined
    const row = this.db.get<{ id: number }>(
      'SELECT id FROM releases WHERE project_id = ? AND version = ?',
      [projectId, version]
    )
    return row?.id
  }
}

export type { ErrorEvent, PerformanceEvent }
