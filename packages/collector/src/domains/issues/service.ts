import crypto from 'node:crypto'
import type { Db } from '../../infra/db/client.js'
import { fromBool, readJson, writeJson } from '../../infra/db/dialect.js'
import { AppError } from '../../shared/errors.js'
import { pathOf } from '../../shared/url.js'
import { parseStack } from '../artifacts/parse-stack.js'
import { SourcemapResolver, type ResolvedFrame } from '../artifacts/sourcemap.js'
import {
  transition,
  type ActivityDraft,
  type IssueState,
  type IssueTransition
} from './state-machine.js'
import type {
  ArchiveStrategy,
  ErrorEvent,
  IssueActivityAction,
  IssueBulkAction,
  IssueDetail,
  IssueLevel,
  IssueQuery,
  IssueStatus,
  IssueSubstatus
} from '@vigil/protocol'

/**
 * 问题域。
 *
 * 这里是「错误」变成「问题」的地方 —— 一条错误记录是流水，
 * 一个 Issue 是工单：它有状态、负责人、评论、活动历史，
 * 并且能被标记为已解决、在某个版本上回归。
 */

export interface IssueRow {
  id: number
  project_id: number
  fingerprint: string
  short_id: string
  category: string
  kind: string
  title: string
  message: string
  url: string | null
  url_path: string | null
  raw_stack: string | null
  resolved_stack: string | null
  culprit: string | null
  level: string
  status: string
  substatus: string
  count: number
  user_count: number
  first_seen: number
  last_seen: number
  resolved_at: number | null
  resolved_in_release_id: number | null
  resolved_in_release: string | null
  archived_at: number | null
  archive_strategy: string | null
  archive_until_count: number | null
  archive_until_user_count: number | null
  assignee_id: number | null
  is_bookmarked: number
  is_subscribed: number
  has_seen: number
  metadata_json: string | null
  created_at: number
  updated_at: number
  /**
   * 时间窗口内的发生次数。
   *
   * 只在**给了时间范围**的查询里才有值 —— 没有窗口时它等于累计的 `count`，
   * 但那是两回事：累计值是「这个错误一共发生过几次」，
   * 窗口值是「这段时间里发生了几次」。
   */
  window_count?: number
}

export interface IngestOutcome {
  issueId: number
  shortId: string
  created: boolean
  status: IssueStatus
  substatus: IssueSubstatus
  /** 这次事件是否造成了状态变化 */
  transitioned: boolean
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
  /** 窗口内受影响的用户数（去重）。没有时间范围时是 undefined */
  users?: number
  /** 窗口内首次出现的问题数。没有时间范围时是 undefined */
  newIssues?: number
  /** 生效的时间范围（epoch 毫秒）。没有时间范围时是 undefined */
  since?: number
  until?: number
}

export class IssueService {
  constructor(
    private readonly db: Db,
    private readonly resolver: SourcemapResolver
  ) {}

  // ==========================================================
  // 摄入：事件 → Issue
  // ==========================================================

  /**
   * 摄入一条错误事件。
   *
   * 流程：
   *   1. 按指纹找 Issue（找不到就建）
   *   2. 交给状态机判断这次事件会不会改变状态
   *   3. 写 issue_events（原始明细）
   *   4. 写 issue_activity（活动流）
   *   5. 更新 issue 的聚合计数
   */
  async ingestEvent(projectId: number, event: ErrorEvent): Promise<IngestOutcome> {
    const occurredAt = event.occurredAt ?? Date.now()
    const eventId = event.eventId ?? generateEventId(event, occurredAt)

    return await this.db.transaction(async () => {
      let issue = await this.findRow(projectId, event.fingerprint)
      let created = false

      if (!issue) {
        issue = await this.createRow(projectId, event, occurredAt)
        created = true
      }

      // 同一事件重复上报（网络重试）→ 直接忽略，不重复计数
      const duplicate = await this.db.get<{ id: number }>(
        'SELECT id FROM issue_events WHERE project_id = ? AND event_id = ?',
        [projectId, eventId]
      )
      if (duplicate) {
        return {
          issueId: issue.id,
          shortId: issue.short_id,
          created: false,
          status: issue.status as IssueStatus,
          substatus: issue.substatus as IssueSubstatus,
          transitioned: false
        }
      }

      const state = toState(issue)

      // 受影响用户数：同一个人只算一次
      const userId = event.userId
      const userIsNew = userId
        ? !(await this.db.get('SELECT 1 AS x FROM issue_users WHERE issue_id = ? AND user_id = ?', [
            issue.id,
            userId
          ]))
        : false

      const transitions: IssueTransition[] = []

      if (created) {
        transitions.push({ type: 'created', now: occurredAt })
      }

      transitions.push({
        type: 'event_received',
        now: occurredAt,
        release: event.release,
        userId,
        userIsNew
      })

      let finalState = state
      let activities: ActivityDraft[] = []

      for (const t of transitions) {
        const result = transition(finalState, t)
        finalState = result.state
        activities = activities.concat(result.activities)
      }

      // 写明细
      await this.db.run(
        `INSERT INTO issue_events
           (issue_id, project_id, event_id, occurred_at, received_at,
            user_id, session_id, url, release, environment, vitals_json, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          issue.id,
          projectId,
          eventId,
          occurredAt,
          Date.now(),
          userId ?? null,
          event.sessionId ?? null,
          event.url ?? null,
          event.release ?? null,
          event.environment ?? null,
          writeJson(event.vitals ?? null),
          writeJson(event)
        ]
      )

      // 记录受影响用户
      if (userId) {
        if (userIsNew) {
          // `ON CONFLICT DO UPDATE` —— SQLite 3.24+ 与 PG 都支持。
          // ⚠️ 别用 `INSERT OR REPLACE` —— 那是 SQLite 独有的语法，PG 上直接报错。
          await this.db.run(
            `INSERT INTO issue_users (issue_id, user_id, first_seen, last_seen)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (issue_id, user_id) DO UPDATE SET last_seen = excluded.last_seen`,
            [issue.id, userId, occurredAt, occurredAt]
          )
        } else {
          await this.db.run(
            'UPDATE issue_users SET last_seen = ? WHERE issue_id = ? AND user_id = ?',
            [occurredAt, issue.id, userId]
          )
        }
      }

      // 写活动流
      for (const activity of activities) {
        await this.writeActivity(issue.id, activity, occurredAt)
      }

      // 更新聚合计数与状态
      await this.applyChanges(projectId, issue.id, finalState, activities, event, occurredAt)

      return {
        issueId: issue.id,
        shortId: issue.short_id,
        created,
        status: finalState.status,
        substatus: finalState.substatus,
        transitioned: activities.length > 0
      }
    })
  }

  /** 找到 Issue 行 */
  private async findRow(projectId: number, fingerprint: string): Promise<IssueRow | undefined> {
    return await this.db.get<IssueRow>(
      'SELECT * FROM issues WHERE project_id = ? AND fingerprint = ?',
      [projectId, fingerprint]
    )
  }

  /** 新建 Issue 行（计数先记 0，随后由状态机累加） */
  private async createRow(
    projectId: number,
    event: ErrorEvent,
    occurredAt: number
  ): Promise<IssueRow> {
    const title = buildTitle(event)
    const culprit = buildCulprit(event)

    const insertedId = await this.db.insert(
      `INSERT INTO issues
         (project_id, fingerprint, short_id, category, kind, title, message, culprit, level,
          status, substatus, count, user_count, first_seen, last_seen,
          is_bookmarked, is_subscribed, has_seen, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 'unresolved', 'new', 0, 0, ?, ?, 0, 0, 0, ?, ?)`,
      [
        projectId,
        event.fingerprint,
        event.category,
        event.kind,
        title,
        event.message ?? '',
        culprit,
        inferLevel(event),
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt
      ]
    )

    const id = insertedId
    const shortId = `VIG-${id.toString(36).toUpperCase().padStart(5, '0')}`
    await this.db.run('UPDATE issues SET short_id = ? WHERE id = ?', [shortId, id])

    return (await this.db.get<IssueRow>('SELECT * FROM issues WHERE id = ?', [id]))!
  }

  /** 把状态变更写回 issues 表 */
  private async applyChanges(
    projectId: number,
    issueId: number,
    state: IssueState,
    activities: ActivityDraft[],
    event: ErrorEvent,
    now: number
  ): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []

    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }

    push('status', state.status)
    push('substatus', state.substatus)
    push('count', state.count)
    push('user_count', state.userCount)
    push('last_seen', state.lastSeen)
    push('has_seen', state.hasSeen ? 1 : 0)
    push('resolved_at', state.resolvedAt ?? null)
    push('resolved_in_release_id', state.resolvedInReleaseId ?? null)
    push('resolved_in_release', state.resolvedInRelease ?? null)
    push('archived_at', state.archivedAt ?? null)
    push('archive_strategy', state.archiveStrategy ?? null)
    push('archive_until_count', state.archiveUntilCount ?? null)
    push('archive_until_user_count', state.archiveUntilUserCount ?? null)
    push('updated_at', now)

    // 责任点随最新事件更新
    const culprit = buildCulprit(event)
    if (culprit) {
      push('culprit', culprit)
    }

    // 消息与标题随最新事件更新 —— 搜索要用 message
    if (event.message) {
      push('message', event.message)
    }
    if (event.url) {
      push('url', event.url)
      push('url_path', pathOf(event.url))
    }

    // 原始栈 + **还原后的栈**。
    // 还原在入库时做一次：列表页要直接展示还原后的位置，
    // 不能每次查询都重新跑一遍 sourcemap 查找。
    if (event.stack) {
      push('raw_stack', event.stack)
    }
    const resolvedFrames = await this.resolver.resolve(
      projectId,
      event.release,
      event.frames ?? parseStack(event.stack)
    )
    push('resolved_stack', writeJson(resolvedFrames))

    // 环境与版本冗余自最近一次事件 —— 告警规则要按这两个字段过滤
    if (event.environment) {
      push('environment', event.environment)
    }
    if (event.release) {
      push('release', event.release)
    }

    await this.db.run(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`, [...params, issueId])

    // 归档策略变化时，activity 已经写过了（状态机产出），这里不重复写
    void activities
  }

  /** 写活动流，返回刚写入的行 id */
  private async writeActivity(
    issueId: number,
    activity: ActivityDraft,
    now: number
  ): Promise<number> {
    return await this.db.insert(
      `INSERT INTO issue_activity
         (issue_id, actor_type, actor_id, action, reason, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        issueId,
        activity.actorType,
        null,
        activity.action,
        activity.reason ?? null,
        writeJson(activity.data ?? null),
        now
      ]
    )
  }

  // ==========================================================
  // 查询
  // ==========================================================

  /**
   * Issue 列表。
   *
   * 排序支持 `priority` —— 综合「相对量、绝对量、时近性、问题年龄」，
   * 而不是简单的按次数排。见 computePriority 的说明。
   */
  async listIssues(query: IssueQuery): Promise<{ total: number; issues: IssueRow[] }> {
    const conditions: string[] = ['project_id = ?']
    const params: unknown[] = [query.projectId]

    if (query.status) {
      conditions.push('status = ?')
      params.push(query.status)
    }
    if (query.substatus) {
      conditions.push('substatus = ?')
      params.push(query.substatus)
    }
    if (query.category) {
      conditions.push('category = ?')
      params.push(query.category)
    }
    if (query.level) {
      conditions.push('level = ?')
      params.push(query.level)
    }
    if (query.assigneeId !== undefined) {
      conditions.push('assignee_id = ?')
      params.push(query.assigneeId)
    }
    if (query.isBookmarked !== undefined) {
      conditions.push('is_bookmarked = ?')
      params.push(query.isBookmarked ? 1 : 0)
    }
    if (query.query) {
      conditions.push('(title LIKE ? OR message LIKE ? OR culprit LIKE ?)')
      const like = `%${query.query}%`
      params.push(like, like, like)
    }

    const where = conditions.join(' AND ')

    // ---- 时间窗口 ----
    //
    // 给了窗口就只列「窗口内有发生」的问题 —— 这是监控面板的基本要求：
    // 「过去 1 小时有没有新问题」和「历史上共有多少问题」是两个问题。
    const hasWindow = query.since !== undefined || query.until !== undefined
    const windowConditions = ['project_id = ?']
    const windowParams: unknown[] = [query.projectId]
    if (query.since !== undefined) {
      windowConditions.push('occurred_at >= ?')
      windowParams.push(query.since)
    }
    if (query.until !== undefined) {
      windowConditions.push('occurred_at < ?')
      windowParams.push(query.until)
    }
    const windowWhere = windowConditions.join(' AND ')

    const scopedWhere = hasWindow
      ? `${where} AND id IN (SELECT issue_id FROM issue_events WHERE ${windowWhere})`
      : where

    const total = (
      (await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM issues WHERE ${scopedWhere}`, [
        ...params,
        ...(hasWindow ? windowParams : [])
      ])) as { n: number }
    ).n

    const rows = await this.db.all<IssueRow>(`SELECT * FROM issues WHERE ${scopedWhere}`, [
      ...params,
      ...(hasWindow ? windowParams : [])
    ])

    // 窗口内的发生次数：一条 GROUP BY 就够，别按行去查
    if (hasWindow) {
      const counts = await this.db.all<{ issue_id: number; n: number }>(
        `SELECT issue_id, COUNT(*) AS n FROM issue_events
         WHERE ${windowWhere} GROUP BY issue_id`,
        windowParams
      )
      const countMap = new Map(counts.map((row) => [row.issue_id, row.n]))
      for (const row of rows) row.window_count = countMap.get(row.id) ?? 0
    }

    // 有窗口时按**窗口内**的次数排 —— 用户选了「最近 1 小时」，
    // 排序就该按这段时间的量，而不是历史累计。
    const sorted = sortIssues(
      rows,
      query.sort ?? 'priority',
      hasWindow ? (row) => row.window_count ?? 0 : undefined
    )
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0

    return { total, issues: sorted.slice(offset, offset + limit) }
  }

  /** Issue 详情 */
  async getIssue(projectId: number, issueId: number): Promise<IssueDetail> {
    const row = await this.db.get<IssueRow>(
      'SELECT * FROM issues WHERE id = ? AND project_id = ?',
      [issueId, projectId]
    )
    if (!row) throw AppError.notFound('问题')
    return await this.toDetail(row)
  }

  /** 按指纹取详情 */
  async getIssueByFingerprint(projectId: number, fingerprint: string): Promise<IssueDetail> {
    const row = await this.findRow(projectId, fingerprint)
    if (!row) throw AppError.notFound('问题')
    return await this.toDetail(row)
  }

  private async toDetail(row: IssueRow): Promise<IssueDetail> {
    const events = await this.db.all<{
      id: number
      occurred_at: number
      received_at: number
      event_id: string
      user_id: string | null
      session_id: string | null
      url: string | null
      release: string | null
      environment: string | null
      vitals_json: string | null
      payload_json: string | null
    }>(
      `SELECT id, occurred_at, received_at, event_id, user_id, session_id, url,
              release, environment, vitals_json, payload_json
       FROM issue_events WHERE issue_id = ? ORDER BY occurred_at DESC LIMIT 20`,
      [row.id]
    )

    const activity = await this.db.all<{
      id: number
      action: string
      actor_type: string
      actor_id: number | null
      reason: string | null
      data_json: string | null
      created_at: number
    }>(
      `SELECT id, action, actor_type, actor_id, reason, data_json, created_at
       FROM issue_activity WHERE issue_id = ? ORDER BY created_at DESC LIMIT 50`,
      [row.id]
    )

    const comments = await this.db.all<{
      id: number
      author_id: number | null
      body: string
      created_at: number
      updated_at: number
    }>(
      `SELECT id, author_id, body, created_at, updated_at
       FROM issue_comments WHERE issue_id = ? ORDER BY created_at DESC`,
      [row.id]
    )

    const tags = await this.db.all<{ key: string; value: string }>(
      'SELECT key, value FROM issue_tags WHERE issue_id = ?',
      [row.id]
    )

    const latest = events[0]
    const latestPayload = latest
      ? readJson<Record<string, unknown>>(latest.payload_json)
      : undefined

    const assignee = row.assignee_id
      ? await this.db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [
          row.assignee_id
        ])
      : undefined

    return {
      id: row.id,
      shortId: row.short_id,
      projectId: row.project_id,
      fingerprint: row.fingerprint,
      category: row.category as IssueDetail['category'],
      kind: row.kind,
      title: row.title,
      culprit: row.culprit ?? undefined,
      level: row.level as IssueLevel,
      status: row.status as IssueStatus,
      substatus: row.substatus as IssueSubstatus,
      count: row.count,
      userCount: row.user_count,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedInRelease: row.resolved_in_release ?? undefined,
      assigneeId: row.assignee_id ?? undefined,
      assigneeName: assignee?.name,
      isBookmarked: fromBool(row.is_bookmarked),
      isSubscribed: fromBool(row.is_subscribed),
      hasSeen: fromBool(row.has_seen),
      archiveStrategy: (row.archive_strategy as ArchiveStrategy) ?? undefined,
      archivedAt: row.archived_at ?? undefined,
      message: latestPayload?.message ? String(latestPayload.message) : row.title,
      rawStack: row.raw_stack ?? undefined,
      resolvedStack: readJson<ResolvedFrame[]>(row.resolved_stack) ?? undefined,
      tags,
      events: events.map((e) => ({
        id: e.id,
        occurredAt: e.occurred_at,
        receivedAt: e.received_at,
        eventId: e.event_id,
        userId: e.user_id ?? undefined,
        sessionId: e.session_id ?? undefined,
        url: e.url ?? undefined,
        release: e.release ?? undefined,
        environment: e.environment ?? undefined,
        vitals: readJson<Record<string, number | undefined>>(e.vitals_json)
      })),
      activity: activity.map((a) => ({
        id: a.id,
        action: a.action as IssueActivityAction,
        actorType: a.actor_type as 'member' | 'system',
        actorId: a.actor_id ?? undefined,
        reason: a.reason ?? undefined,
        createdAt: a.created_at,
        data: readJson<Record<string, unknown>>(a.data_json)
      })),
      comments: comments.map((c) => ({
        id: c.id,
        authorId: c.author_id ?? undefined,
        body: c.body,
        createdAt: c.created_at,
        updatedAt: c.updated_at
      }))
    }
  }

  // ==========================================================
  // 人工操作
  // ==========================================================

  /** 标记已解决 */
  async resolve(
    projectId: number,
    issueId: number,
    options: { release?: string; reason?: string; actorId?: number }
  ): Promise<IssueDetail> {
    const issue = await this.requireRow(projectId, issueId)
    const result = transition(toState(issue), {
      type: 'resolve',
      now: Date.now(),
      release: options.release,
      releaseId: options.release ? await this.findReleaseId(projectId, options.release) : undefined
    })

    await this.persistManual(issue, result, options.actorId, options.reason)
    return await this.getIssue(projectId, issueId)
  }

  /** 归档 */
  async archive(
    projectId: number,
    issueId: number,
    options: {
      strategy: ArchiveStrategy
      untilCount?: number
      untilUserCount?: number
      reason?: string
      actorId?: number
    }
  ): Promise<IssueDetail> {
    const issue = await this.requireRow(projectId, issueId)
    const result = transition(toState(issue), {
      type: 'archive',
      now: Date.now(),
      strategy: options.strategy,
      untilCount: options.untilCount,
      untilUserCount: options.untilUserCount
    })

    await this.persistManual(issue, result, options.actorId, options.reason)
    return await this.getIssue(projectId, issueId)
  }

  /** 解除归档 */
  async unarchive(
    projectId: number,
    issueId: number,
    options: { reason?: string; actorId?: number } = {}
  ): Promise<IssueDetail> {
    const issue = await this.requireRow(projectId, issueId)
    const result = transition(toState(issue), { type: 'unarchive', now: Date.now() })
    await this.persistManual(issue, result, options.actorId, options.reason)
    return await this.getIssue(projectId, issueId)
  }

  /** 标记已阅 */
  async markSeen(
    projectId: number,
    issueId: number,
    options: { reason?: string; actorId?: number } = {}
  ): Promise<IssueDetail> {
    const issue = await this.requireRow(projectId, issueId)
    const result = transition(toState(issue), { type: 'mark_seen', now: Date.now() })
    await this.persistManual(issue, result, options.actorId, options.reason)
    return await this.getIssue(projectId, issueId)
  }

  /** 分配负责人 */
  async assign(
    projectId: number,
    issueId: number,
    memberId: number | null,
    options: { reason?: string; actorId?: number } = {}
  ): Promise<IssueDetail> {
    await this.requireRow(projectId, issueId)
    const now = Date.now()

    await this.db.run('UPDATE issues SET assignee_id = ?, updated_at = ? WHERE id = ?', [
      memberId,
      now,
      issueId
    ])

    await this.writeActivity(
      issueId,
      {
        action: memberId ? 'assigned' : 'unassigned',
        actorType: 'member',
        reason: options.reason,
        data: memberId ? { assigneeId: memberId } : undefined
      },
      now
    )

    return await this.getIssue(projectId, issueId)
  }

  /** 添加评论 */
  async comment(
    projectId: number,
    issueId: number,
    authorId: number | undefined,
    body: string
  ): Promise<IssueDetail> {
    await this.requireRow(projectId, issueId)
    const now = Date.now()

    await this.db.run(
      'INSERT INTO issue_comments (issue_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [issueId, authorId ?? null, body, now, now]
    )

    await this.writeActivity(issueId, { action: 'commented', actorType: 'member' }, now)
    return await this.getIssue(projectId, issueId)
  }

  /** 收藏 */
  async setBookmarked(
    projectId: number,
    issueId: number,
    bookmarked: boolean
  ): Promise<IssueDetail> {
    await this.requireRow(projectId, issueId)
    const now = Date.now()

    await this.db.run('UPDATE issues SET is_bookmarked = ?, updated_at = ? WHERE id = ?', [
      bookmarked ? 1 : 0,
      now,
      issueId
    ])

    await this.writeActivity(
      issueId,
      { action: bookmarked ? 'bookmarked' : 'unbookmarked', actorType: 'member' },
      now
    )

    return await this.getIssue(projectId, issueId)
  }

  /** 批量操作 */
  async bulkAction(projectId: number, action: IssueBulkAction): Promise<number> {
    let affected = 0

    for (const issueId of action.issueIds) {
      try {
        switch (action.action) {
          case 'resolve':
            await this.resolve(projectId, issueId, {
              release: action.release,
              reason: action.reason,
              actorId: action.actorId
            })
            break
          case 'archive':
            await this.archive(projectId, issueId, {
              strategy: action.archiveStrategy ?? 'forever',
              untilCount: action.archiveUntilCount,
              untilUserCount: action.archiveUntilUserCount,
              reason: action.reason,
              actorId: action.actorId
            })
            break
          case 'unarchive':
            await this.unarchive(projectId, issueId, {
              reason: action.reason,
              actorId: action.actorId
            })
            break
          case 'bookmark':
            await this.setBookmarked(projectId, issueId, true)
            break
          case 'unbookmark':
            await this.setBookmarked(projectId, issueId, false)
            break
          case 'mark_seen':
            await this.markSeen(projectId, issueId, {
              reason: action.reason,
              actorId: action.actorId
            })
            break
        }
        affected++
      } catch {
        // 单个失败不影响整批
      }
    }

    return affected
  }

  // ==========================================================
  // 统计
  // ==========================================================

  /**
   * 统计。
   *
   * ## 有时间窗口时看的是**窗口内发生**的问题
   *
   * 「过去 24 小时有多少个问题在冒」和「历史上共有多少个问题」
   * 是两个完全不同的问题。监控面板要能回答前者。
   *
   * 没有窗口时行为和以前完全一致（读 issues 表的全量快照）。
   */
  async stats(
    projectId: number,
    range: { since?: number; until?: number } = {}
  ): Promise<IssueStats> {
    const hasWindow = range.since !== undefined || range.until !== undefined
    if (hasWindow) return await this.windowStats(projectId, range)
    return await this.allTimeStats(projectId)
  }

  /** 全量统计：直接读 issues 表（问题表本身就是一个累计快照） */
  private async allTimeStats(projectId: number): Promise<IssueStats> {
    const totals = (await this.db.get<{
      total: number
      occurrences: number
      unresolved: number
      new_count: number
      ongoing: number
      regressed: number
      escalating: number
      resolved: number
      archived: number
    }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(count), 0) AS occurrences,
              COALESCE(SUM(CASE WHEN status = 'unresolved' THEN 1 ELSE 0 END), 0) AS unresolved,
              COALESCE(SUM(CASE WHEN substatus = 'new' THEN 1 ELSE 0 END), 0) AS new_count,
              COALESCE(SUM(CASE WHEN substatus = 'ongoing' THEN 1 ELSE 0 END), 0) AS ongoing,
              COALESCE(SUM(CASE WHEN substatus = 'regressed' THEN 1 ELSE 0 END), 0) AS regressed,
              COALESCE(SUM(CASE WHEN substatus = 'escalating' THEN 1 ELSE 0 END), 0) AS escalating,
              COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved,
              COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived
       FROM issues WHERE project_id = ?`,
      [projectId]
    ))!

    const byCategory = await this.db.all<{ category: string; n: number; occurrences: number }>(
      `SELECT category, COUNT(*) AS n, COALESCE(SUM(count), 0) AS occurrences
       FROM issues WHERE project_id = ? GROUP BY category ORDER BY occurrences DESC`,
      [projectId]
    )

    const byLevel = await this.db.all<{ level: string; n: number }>(
      `SELECT level, COUNT(*) AS n FROM issues WHERE project_id = ? GROUP BY level ORDER BY n DESC`,
      [projectId]
    )

    const topCulprits = await this.db.all<{ culprit: string; n: number; occurrences: number }>(
      `SELECT culprit, COUNT(*) AS n, COALESCE(SUM(count), 0) AS occurrences
       FROM issues WHERE project_id = ? AND culprit IS NOT NULL
       GROUP BY culprit ORDER BY occurrences DESC LIMIT 10`,
      [projectId]
    )

    return {
      total: totals.total,
      unresolved: totals.unresolved,
      new: totals.new_count,
      ongoing: totals.ongoing,
      regressed: totals.regressed,
      escalating: totals.escalating,
      resolved: totals.resolved,
      archived: totals.archived,
      occurrences: totals.occurrences,
      byCategory,
      byLevel,
      topCulprits
    }
  }

  /**
   * 窗口统计：从 issue_events 出发。
   *
   * 状态分布用的是问题**当前**的状态 ——
   * 「过去 1 小时还在冒且现在仍未解决」是用户真正想问的。
   */
  private async windowStats(
    projectId: number,
    range: { since?: number; until?: number }
  ): Promise<IssueStats> {
    const conditions = ['e.project_id = ?']
    const params: unknown[] = [projectId]
    if (range.since !== undefined) {
      conditions.push('e.occurred_at >= ?')
      params.push(range.since)
    }
    if (range.until !== undefined) {
      conditions.push('e.occurred_at < ?')
      params.push(range.until)
    }
    const where = conditions.join(' AND ')

    const totals = (await this.db.get<{
      issues: number
      occurrences: number
      users: number
    }>(
      `SELECT COUNT(DISTINCT e.issue_id) AS issues,
              COUNT(*) AS occurrences,
              COUNT(DISTINCT e.user_id) AS users
       FROM issue_events e WHERE ${where}`,
      params
    ))!

    // 状态分布：窗口内有发生的问题，它们的**当前**状态
    const byStatus = (await this.db.all<{ status: string; substatus: string; n: number }>(
      `SELECT i.status, i.substatus, COUNT(DISTINCT i.id) AS n
       FROM issues i
       WHERE i.project_id = ?
         AND i.id IN (SELECT e.issue_id FROM issue_events e WHERE ${where})
       GROUP BY i.status, i.substatus`,
      [projectId, ...params]
    ))!

    const count = (predicate: (row: { status: string; substatus: string }) => boolean): number =>
      byStatus.filter(predicate).reduce((sum, row) => sum + row.n, 0)

    // 新增问题：窗口内**首次出现**的问题
    const newConditions = ['project_id = ?']
    const newParams: unknown[] = [projectId]
    if (range.since !== undefined) {
      newConditions.push('first_seen >= ?')
      newParams.push(range.since)
    }
    if (range.until !== undefined) {
      newConditions.push('first_seen < ?')
      newParams.push(range.until)
    }
    const newIssues = (
      (await this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM issues WHERE ${newConditions.join(' AND ')}`,
        newParams
      )) as { n: number }
    ).n

    const byCategory = await this.db.all<{ category: string; n: number; occurrences: number }>(
      `SELECT i.category, COUNT(DISTINCT i.id) AS n, COUNT(e.id) AS occurrences
       FROM issue_events e JOIN issues i ON i.id = e.issue_id
       WHERE ${where}
       GROUP BY i.category ORDER BY occurrences DESC`,
      params
    )

    const byLevel = await this.db.all<{ level: string; n: number }>(
      `SELECT i.level, COUNT(DISTINCT i.id) AS n
       FROM issue_events e JOIN issues i ON i.id = e.issue_id
       WHERE ${where}
       GROUP BY i.level ORDER BY n DESC`,
      params
    )

    const topCulprits = await this.db.all<{ culprit: string; n: number; occurrences: number }>(
      `SELECT i.culprit, COUNT(DISTINCT i.id) AS n, COUNT(e.id) AS occurrences
       FROM issue_events e JOIN issues i ON i.id = e.issue_id
       WHERE ${where} AND i.culprit IS NOT NULL
       GROUP BY i.culprit ORDER BY occurrences DESC LIMIT 10`,
      params
    )

    return {
      total: totals.issues,
      unresolved: count((r) => r.status === 'unresolved'),
      new: count((r) => r.substatus === 'new'),
      ongoing: count((r) => r.substatus === 'ongoing'),
      regressed: count((r) => r.substatus === 'regressed'),
      escalating: count((r) => r.substatus === 'escalating'),
      resolved: count((r) => r.status === 'resolved'),
      archived: count((r) => r.status === 'archived'),
      occurrences: totals.occurrences,
      byCategory,
      byLevel,
      topCulprits,
      users: totals.users,
      newIssues,
      since: range.since,
      until: range.until
    }
  }

  // ==========================================================
  // 内部
  // ==========================================================

  private async requireRow(projectId: number, issueId: number): Promise<IssueRow> {
    const row = await this.db.get<IssueRow>(
      'SELECT * FROM issues WHERE id = ? AND project_id = ?',
      [issueId, projectId]
    )
    if (!row) throw AppError.notFound('问题')
    return row
  }

  private async findReleaseId(projectId: number, version: string): Promise<number | undefined> {
    const row = await this.db.get<{ id: number }>(
      'SELECT id FROM releases WHERE project_id = ? AND version = ?',
      [projectId, version]
    )
    return row?.id
  }

  /** 人工操作落库：写状态 + 写活动流 */
  private async persistManual(
    issue: IssueRow,
    result: { state: IssueState; changes: Record<string, unknown>; activities: ActivityDraft[] },
    actorId: number | undefined,
    reason: string | undefined
  ): Promise<void> {
    const now = Date.now()
    const sets: string[] = []
    const params: unknown[] = []

    for (const [key, value] of Object.entries(result.changes)) {
      // 状态机用的是**领域字段名**（camelCase），数据库列是 snake_case。
      // 映射表放这里 —— 写死列名的话，状态机加一个字段就得改两处。
      const column = STATE_KEY_TO_COLUMN[key]
      if (!column) continue
      sets.push(`${column} = ?`)
      params.push(value)
    }
    sets.push('updated_at = ?')
    params.push(now)

    await this.db.run(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`, [...params, issue.id])

    for (const activity of result.activities) {
      const activityId = await this.writeActivity(
        issue.id,
        { ...activity, reason: activity.reason ?? reason },
        now
      )
      // 人工操作要记录是谁干的
      if (activity.actorType === 'member' && actorId) {
        await this.db.run('UPDATE issue_activity SET actor_id = ? WHERE issue_id = ? AND id = ?', [
          actorId,
          issue.id,
          activityId
        ])
      }
    }
  }
}

// ==========================================================
// 辅助
// ==========================================================

/**
 * 状态机字段名 → 数据库列名。
 *
 * 状态机工作在**领域语言**里（camelCase），数据库是 snake_case。
 * 映射表放一处，写死列名的话状态机加字段要改两个地方。
 */
const STATE_KEY_TO_COLUMN: Record<string, string> = {
  status: 'status',
  substatus: 'substatus',
  count: 'count',
  userCount: 'user_count',
  lastSeen: 'last_seen',
  hasSeen: 'has_seen',
  resolvedAt: 'resolved_at',
  resolvedInReleaseId: 'resolved_in_release_id',
  resolvedInRelease: 'resolved_in_release',
  archivedAt: 'archived_at',
  archiveStrategy: 'archive_strategy',
  archiveUntilCount: 'archive_until_count',
  archiveUntilUserCount: 'archive_until_user_count'
}

/** 数据库行 → 状态机输入 */
export function toState(row: IssueRow): IssueState {
  return {
    status: row.status as IssueStatus,
    substatus: row.substatus as IssueSubstatus,
    count: row.count,
    userCount: row.user_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    hasSeen: fromBool(row.has_seen),
    resolvedAt: row.resolved_at ?? undefined,
    resolvedInReleaseId: row.resolved_in_release_id ?? undefined,
    resolvedInRelease: row.resolved_in_release ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    archiveStrategy: (row.archive_strategy as ArchiveStrategy) ?? undefined,
    archiveUntilCount: row.archive_until_count ?? undefined,
    archiveUntilUserCount: row.archive_until_user_count ?? undefined
  }
}

/** 生成 Issue 标题 */
export function buildTitle(event: ErrorEvent): string {
  const name = event.name ?? event.kind
  const message = (event.message ?? '').replace(/\s+/g, ' ').trim()
  return `${name}: ${message}`.slice(0, 200)
}

/** 生成责任点：最接近根因的那一帧 */
export function buildCulprit(event: ErrorEvent): string | null {
  const frame = event.frames?.[0]
  if (!frame) {
    if (event.http) return `${event.http.method} ${event.http.url}`
    if (event.resource) return event.resource.src
    return null
  }

  const name = frame.functionName ?? '(匿名)'
  const file = frame.filename.split('/').pop() ?? frame.filename
  return `${name} @ ${file}`
}

/** 推断严重级别 */
export function inferLevel(event: ErrorEvent): IssueLevel {
  if (event.http) {
    if (event.http.status >= 500) return 'fatal'
    if (event.http.status >= 400) return 'warning'
  }
  return 'error'
}

/** 没有 eventId 时生成一个可去重的 ID */
function generateEventId(event: ErrorEvent, occurredAt: number): string {
  return crypto
    .createHash('sha256')
    .update(
      `${event.fingerprint}|${occurredAt}|${event.userId ?? ''}|${event.sessionId ?? ''}|${event.url ?? ''}`
    )
    .digest('hex')
    .slice(0, 32)
}

/**
 * 优先级排序。
 *
 * 简单地按次数排会漏掉真正该先修的问题：
 * 一个今天刚冒出来、正在暴涨的新错误，应该排在
 * 一个一年前就存在、每天稳定报 5 次的老错误前面。
 *
 * 所以综合四个维度（参考 Sentry 的 Priority 排序思路）：
 *   - 绝对量：log(次数) —— 用对数，避免单个噪音问题霸榜
 *   - 受影响用户：log(用户数)，权重更高 —— 影响人比影响次数重要
 *   - 时近性：越近越优先，指数衰减
 *   - 问题年龄：越新越优先
 *   - 状态：escalating / regressed 的优先级显著更高
 */
export function computePriority(issue: IssueRow, now: number): number {
  const volumeScore = Math.log1p(issue.count)
  const userScore = Math.log1p(issue.user_count) * 1.5

  // 时近性：半衰期约 17 小时
  const ageHours = Math.max(0, (now - issue.last_seen) / 3600000)
  const recencyScore = 4 * Math.exp(-ageHours / 24)

  // 问题年龄：越新越优先
  const issueAgeHours = Math.max(0, (now - issue.first_seen) / 3600000)
  const newnessScore = 3 * Math.exp(-issueAgeHours / 72)

  const statusScore = statePriority(issue.status, issue.substatus)

  return volumeScore + userScore + recencyScore + newnessScore + statusScore
}

function statePriority(status: string, substatus: string): number {
  if (status === 'archived') return -100
  if (status === 'resolved') return -50

  switch (substatus) {
    case 'escalating':
      return 40
    case 'regressed':
      return 30
    case 'new':
      return 20
    default:
      return 0
  }
}

/**
 * 排序。
 *
 * `countOf` 让调用方决定「发生次数」看哪个口径：
 * 有时间窗口时看窗口内的次数，没有时看累计次数。
 * 两者混用会让「选了最近 1 小时却按历史总量排序」这种怪事发生。
 */
export function sortIssues(
  rows: IssueRow[],
  sort: NonNullable<IssueQuery['sort']>,
  countOf?: (row: IssueRow) => number
): IssueRow[] {
  const now = Date.now()
  const count = countOf ?? ((row: IssueRow) => row.count)

  const sorted = [...rows]
  switch (sort) {
    case 'last_seen':
      sorted.sort((a, b) => b.last_seen - a.last_seen)
      break
    case 'first_seen':
      sorted.sort((a, b) => b.first_seen - a.first_seen)
      break
    case 'count':
      sorted.sort((a, b) => count(b) - count(a))
      break
    case 'user_count':
      sorted.sort((a, b) => b.user_count - a.user_count)
      break
    case 'priority':
    default:
      sorted.sort((a, b) => computePriority(b, now) - computePriority(a, now))
      break
  }
  return sorted
}
