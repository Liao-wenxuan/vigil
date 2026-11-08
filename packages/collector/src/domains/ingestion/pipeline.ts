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
   *
   * ## 整批一个事务，每条事件一个 SAVEPOINT
   *
   * 一批最多 20 条事件。逐条开事务意味着 **20 次提交** ——
   * SQLite 上是 20 次 WAL 追加，PG 上是 20 次网络往返。
   * 实测（文件库，20 条一批）：逐条 4.3 ms，整批 1.1 ms。
   *
   * ⚠️ 但不能直接「一个大事务包住所有事件」就完事：
   *    PG 里**一条语句失败会中止整个事务**，
   *    一条坏事件会把另外 19 条好的一起带走。
   *    所以每条事件再套一层 SAVEPOINT —— 失败只回滚那一条。
   */
  async ingestErrors(project: ProjectRow, envelope: CollectEnvelope): Promise<IngestResult> {
    const events = envelope.events ?? []
    if (events.length === 0) return { accepted: 0, dropped: 0 }

    await this.usage.assertWithinQuota(project, events.length)

    const ids: Record<string, number> = {}
    let accepted = 0
    let dropped = 0
    let firstError: unknown = null

    await this.db.transaction(async () => {
      for (const [index, event] of events.entries()) {
        let issueId = 0
        try {
          await this.db.savepoint(`ev_${index}`, async () => {
            const outcome = await this.issues.ingestEvent(project.id, event)
            issueId = outcome.issueId
            accepted++

            // 会话回放：随错误一起送来的事件流
            if (event.replay && event.sessionId) {
              await this.replay.saveReplay(project.id, event.sessionId, event.replay, {
                userId: event.userId,
                occurredAt: event.occurredAt
              })
              await this.replay.incrementSessionError(project.id, event.sessionId)
            }
          })
          // ⚠️ 放在 savepoint **外面**赋值 ——
          //    万一这条事件回滚了，ids 里不能留一个指向已回滚行的 id
          ids[String(index)] = issueId
        } catch (error) {
          // 单条失败不影响整批
          dropped++
          if (firstError === null) firstError = error
          console.error(`[vigil] 第 ${index} 条事件摄入失败:`, error)
        }
      }
    })

    // ⚠️ 整批都失败 → 这是**系统性故障**（数据库不可用之类），不是单条坏数据。
    //    必须抛出去 —— 返回 200 会让客户端以为一切正常，数据就静默丢了。
    if (accepted === 0 && firstError !== null) {
      throw firstError
    }

    // 用量按**受理的条数**累加（含被 event_id 去重的事件 —— 上报即消耗配额）。
    //
    // ⚠️ 这里不在事务里：万一循环中途抛错，本条请求的用量会少记。
    //    这是有意的取舍 —— 配额是软闸门（防止打爆存储，不是计费单），
    //    为它把 200 条事件塞进一个大事务，代价远大于收益。
    await this.usage.addEvents(project.id, accepted)

    return { accepted, dropped, ids }
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
   *
   * ## 整批一个事务，每条一个 SAVEPOINT
   *
   * 旧实现逐条调 `PerformanceService.ingestTransaction`，而领域方法内部
   * 自带 `db.transaction` —— 一批 20 条就是 **20 次 COMMIT**。
   * 在 PostgreSQL 部署下每次提交都是一次网络往返 + 一次 fsync。
   *
   * 这里在外层包一个事务，`Db.transaction` 检测到嵌套会自动降级为
   * 「直接跑、靠外层提交」（SQLite 与 PG 两种实现都支持），
   * 于是整批只剩 1 次提交。每条仍套 SAVEPOINT，
   * 保证一条坏事务不会把同批其余事务一起带走。
   *
   * ## 环境 / 版本按每条自身解析，但相同值只查一次库
   *
   * 旧实现把**第一条**的 context 套给整批，一批里混了不同环境或版本
   * 就会记错维度。改成逐条解析，再用 Map 去重 —— 一批通常只有一两种值，
   * 所以 DB 往返数不变（每批最多 2 次），正确性却回来了。
   */
  async ingestPerformance(
    project: ProjectRow,
    envelope: PerformanceEnvelope
  ): Promise<IngestResult> {
    const transactions = envelope.transactions ?? []
    if (transactions.length === 0) return { accepted: 0, dropped: 0 }

    await this.usage.assertWithinQuota(project, transactions.length)

    let accepted = 0
    let dropped = 0
    let firstError: unknown = null

    await this.db.transaction(async () => {
      const environments = new Map<string, number | undefined>()
      const releases = new Map<string, number | undefined>()

      for (const [index, transaction] of transactions.entries()) {
        try {
          await this.db.savepoint(`tx_${index}`, async () => {
            const context = {
              environmentId: await this.resolveCached(
                environments,
                transaction.environment,
                (slug) => this.resolveEnvironmentId(project.id, slug)
              ),
              releaseId: await this.resolveCached(releases, transaction.release, (version) =>
                this.resolveReleaseId(project.id, version)
              )
            }
            await this.performance.ingestTransaction(project.id, transaction, context)
            accepted++
          })
        } catch (error) {
          // 单条失败不影响整批
          dropped++
          if (firstError === null) firstError = error
          console.error(`[vigil] 第 ${index} 条性能事务摄入失败:`, error)
        }
      }
    })

    // 整批都失败是系统性故障，不能回 200 让客户端以为数据落库了
    if (accepted === 0 && firstError !== null) throw firstError

    return { accepted, dropped }
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

  /**
   * 同一批里重复的 slug 只查一次库。
   *
   * 用 `has()` 而不是 `get()` 判空 —— 查不到的值（undefined）也要缓存，
   * 否则一批 20 条都带同一个未知环境时会重复查 20 次。
   */
  private async resolveCached(
    cache: Map<string, number | undefined>,
    key: string | undefined,
    lookup: (key: string) => Promise<number | undefined>
  ): Promise<number | undefined> {
    if (!key) return undefined
    if (cache.has(key)) return cache.get(key)
    const id = await lookup(key)
    cache.set(key, id)
    return id
  }
}

export type { ErrorEvent, PerformanceEvent }
