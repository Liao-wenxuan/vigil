import type { Db } from '../../infra/db/client.js'
import { AppError } from '../../shared/errors.js'
import type { ProjectRow } from '../tenancy/service.js'
import type { IssueService } from '../issues/service.js'
import type { PerformanceService } from '../performance/service.js'
import type { ArtifactService } from '../artifacts/service.js'
import type { ReplayService } from '../replay/service.js'
import type { UsageService } from '../usage/service.js'
import type {
  BehaviorEnvelope,
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
    private readonly artifacts: ArtifactService,
    private readonly replay: ReplayService,
    private readonly usage: UsageService
  ) {}

  /**
   * 摄入错误事件。
   */
  async ingestErrors(project: ProjectRow, envelope: CollectEnvelope): Promise<IngestResult> {
    const events = envelope.events ?? []
    if (events.length === 0) return { accepted: 0, dropped: 0 }

    await this.usage.assertWithinQuota(project, events.length)

    const ids: Record<string, number> = {}
    let accepted = 0

    for (const [index, event] of events.entries()) {
      const outcome = await this.issues.ingestEvent(project.id, event)
      ids[String(index)] = outcome.issueId
      accepted++

      // 会话回放：随错误一起送来的事件流
      if (event.replay && event.sessionId) {
        await this.replay.saveReplay(project.id, event.sessionId, event.replay, {
          userId: event.userId,
          occurredAt: event.occurredAt
        })
        await this.replay.incrementSessionError(project.id, event.sessionId)
      }
    }

    // 用量按**受理的条数**累加（含被 event_id 去重的事件 —— 上报即消耗配额）。
    //
    // ⚠️ 这里不在事务里：万一循环中途抛错，本条请求的用量会少记。
    //    这是有意的取舍 —— 配额是软闸门（防止打爆存储，不是计费单），
    //    为它把 200 条事件塞进一个大事务，代价远大于收益。
    await this.usage.addEvents(project.id, accepted)

    return { accepted, dropped: 0, ids }
  }

  /**
   * 摄入行为事件（PV / 路由 / 点击 + 会话汇总）。
   */
  async ingestBehavior(project: ProjectRow, envelope: BehaviorEnvelope): Promise<IngestResult> {
    const result = await this.replay.ingestBehavior(project.id, envelope)
    return { accepted: result.accepted, dropped: 0 }
  }

  /**
   * 摄入性能事务。
   */
  async ingestPerformance(
    project: ProjectRow,
    envelope: PerformanceEnvelope
  ): Promise<IngestResult> {
    const transactions = envelope.transactions ?? []
    if (transactions.length === 0) return { accepted: 0, dropped: 0 }

    await this.usage.assertWithinQuota(project, transactions.length)

    const context = {
      environmentId: await this.resolveEnvironmentId(
        project.id,
        envelope.transactions[0]?.environment
      ),
      releaseId: await this.resolveReleaseId(project.id, envelope.transactions[0]?.release)
    }

    for (const transaction of transactions) {
      await this.performance.ingestTransaction(project.id, transaction, context)
    }

    return { accepted: transactions.length, dropped: 0 }
  }

  /**
   * 上传 sourcemap。
   */
  async uploadSourcemaps(
    project: ProjectRow,
    body: { release: string; files: Array<{ fileName: string; sourceMap: string }> }
  ): Promise<{ uploaded: number }> {
    if (!body.release) throw AppError.badRequest('缺少 release')
    if (!Array.isArray(body.files) || body.files.length === 0) {
      throw AppError.badRequest('缺少 files')
    }

    return await this.artifacts.uploadSourcemaps({
      projectId: project.id,
      release: body.release,
      files: body.files
    })
  }

  private async resolveEnvironmentId(
    projectId: number,
    slug?: string
  ): Promise<number | undefined> {
    if (!slug) return undefined
    const row = await this.db.get<{ id: number }>(
      'SELECT id FROM environments WHERE project_id = ? AND slug = ?',
      [projectId, slug]
    )
    return row?.id
  }

  private async resolveReleaseId(projectId: number, version?: string): Promise<number | undefined> {
    if (!version) return undefined
    const row = await this.db.get<{ id: number }>(
      'SELECT id FROM releases WHERE project_id = ? AND version = ?',
      [projectId, version]
    )
    return row?.id
  }
}

export type { ErrorEvent, PerformanceEvent }
