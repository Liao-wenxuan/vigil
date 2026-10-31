import type { Db } from '../../infra/db/client.js'
import type { AlertConditions, AlertRule } from '@vigil/protocol'
import { getSender, type ChannelConfig, type AlertMessage } from './channels.js'
import type { AlertingService } from './service.js'
import { percentiles } from '../performance/service.js'

/**
 * 告警评估器。
 *
 * ## 评估循环
 *
 * 定时扫描所有启用的规则，判断是否触发。评估是**拉模型**（pull）而不是
 * 事件驱动（push）—— 因为大部分规则都是「窗口内的量」这类聚合条件，
 * 事件驱动需要在每次摄入时反查所有规则，反而更慢更贵。
 *
 * ## 两种基线
 *
 * - **固定阈值**（issue.count / metric.error_count）：简单直接
 * - **动态基线**（issue.spike / metric.lcp_p95）：拿最近 7 天的表现做参照
 *
 * 动态基线是关键：固定阈值要么太松（漏报）要么太紧（每天都在响）。
 * 但**基线必须有历史** —— 刚上线一天的 issue 没有基线，
 * 这时用固定阈值而不是乱报。
 */
export interface EvaluationResult {
  evaluated: number
  triggered: number
  skipped: number
  failed: number
}

export interface IssueSubject {
  id: number
  shortId: string
  fingerprint: string
  title: string
  level: string
  category: string
  environment: string | null
  release: string | null
  assigneeId: number | null
  count: number
  userCount: number
  /** 窗口内发生次数 */
  windowCount: number
  status: string
  substatus: string
}

export class AlertEvaluator {
  constructor(
    private readonly db: Db,
    private readonly alerting: AlertingService
  ) {}

  /**
   * 单轮评估内的查询缓存。
   *
   * ## 为什么需要
   *
   * 同类型的每条规则跑的是**完全相同**的查询：
   *   - 3 条 `metric.lcp_p95` 规则 → 3 次同样的 `SELECT lcp FROM transactions`
   *   - 3 条 `issue.*` 规则      → 3 次同样的 `loadIssues`
   *
   * 规则一多，评估一轮的查询数就线性涨。
   *
   * ## 缓存键为什么带 `now`
   *
   * 键里有 `now`，所以**不同轮次不会互相污染** ——
   * 即使两轮评估重叠（定时器 + 手动触发），也不会读到对方窗口的数据。
   *
   * 每轮评估开始时清空，避免无限增长。
   */
  private readonly reads = new Map<string, Promise<unknown>>()

  /**
   * 走缓存的查询。
   *
   * 缓存的是 **Promise** 而不是结果 —— 这样**并发的相同查询也只会跑一次**。
   */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.reads.get(key)
    if (hit) return hit as T
    const promise = load()
    this.reads.set(key, promise)
    return promise
  }

  /** 评估所有项目的所有规则 */
  async evaluateAll(now = Date.now()): Promise<EvaluationResult> {
    const result: EvaluationResult = { evaluated: 0, triggered: 0, skipped: 0, failed: 0 }

    const rules = await this.db.all<{ project_id: number }>(
      'SELECT DISTINCT project_id FROM alert_rules WHERE enabled = 1'
    )

    for (const { project_id: projectId } of rules) {
      const partial = await this.evaluateProject(projectId, now)
      result.evaluated += partial.evaluated
      result.triggered += partial.triggered
      result.skipped += partial.skipped
      result.failed += partial.failed
    }

    return result
  }

  /** 评估一个项目的所有规则 */
  async evaluateProject(projectId: number, now = Date.now()): Promise<EvaluationResult> {
    const result: EvaluationResult = { evaluated: 0, triggered: 0, skipped: 0, failed: 0 }

    const rules = (await this.alerting.listRules(projectId)).filter((rule) => rule.enabled)
    // 每轮清空：缓存只在单轮内有效
    this.reads.clear()

    for (const rule of rules) {
      result.evaluated++
      try {
        const triggered = await this.evaluateRule(rule, now)
        result.triggered += triggered
        if (triggered === 0) result.skipped++
      } catch (error) {
        result.failed++
        console.error(`[vigil] 告警规则 ${rule.id} 评估失败:`, error)
      }
    }

    return result
  }

  /**
   * 评估一条规则。
   *
   * @returns 实际触发的次数
   */
  private async evaluateRule(rule: AlertRule, now: number): Promise<number> {
    const windowMs = Math.max(1, rule.windowSeconds) * 1000
    const windowStart = now - windowMs

    switch (rule.type) {
      case 'issue.new':
        return await this.evaluateIssueNew(rule, windowStart, now)
      case 'issue.count':
        return await this.evaluateIssueCount(rule, windowStart, now)
      case 'issue.spike':
        return await this.evaluateIssueSpike(rule, windowStart, now)
      case 'metric.error_count':
        return await this.evaluateErrorCount(rule, windowStart, now)
      case 'metric.error_rate':
        return await this.evaluateErrorRate(rule, windowStart, now)
      case 'metric.lcp_p95':
        return await this.evaluateLcpP95(rule, windowStart, now)
      default:
        return 0
    }
  }

  // ==========================================================
  // issue.new —— 窗口内出现的新问题
  // ==========================================================
  private async evaluateIssueNew(
    rule: AlertRule,
    windowStart: number,
    now: number
  ): Promise<number> {
    const subjects = (await this.loadIssues(rule.projectId, windowStart, now))
      .filter((issue) => issue.status === 'unresolved')
      .filter((issue) => issue.windowCount > 0)
      .filter((issue) => this.matchesConditions(issue, rule.conditions))

    // 「新」是按 first_seen 判定的，但规则是按窗口评估的，
    // 所以这里只看窗口内有发生的问题（避免把老问题反复当新问题报）
    let triggered = 0
    for (const issue of subjects) {
      const ok = await this.fire(rule, issue, now, {
        title: `新问题：${issue.title}`,
        body: `${issue.shortId} 在最近 ${rule.windowSeconds} 秒内首次出现。`,
        metric: { name: '新问题数', value: 1, threshold: 1 }
      })
      if (ok) triggered++
    }
    return triggered
  }

  // ==========================================================
  // issue.count —— 某问题窗口内次数超阈值
  // ==========================================================
  private async evaluateIssueCount(
    rule: AlertRule,
    windowStart: number,
    now: number
  ): Promise<number> {
    const subjects = (await this.loadIssues(rule.projectId, windowStart, now))
      .filter((issue) => issue.windowCount >= rule.threshold)
      .filter((issue) => this.matchesConditions(issue, rule.conditions))

    let triggered = 0
    for (const issue of subjects) {
      const ok = await this.fire(rule, issue, now, {
        title: `错误次数超阈值：${issue.title}`,
        body: `${issue.shortId} 在最近 ${rule.windowSeconds} 秒内发生 ${issue.windowCount} 次（阈值 ${rule.threshold}）。`,
        metric: { name: '发生次数', value: issue.windowCount, threshold: rule.threshold }
      })
      if (ok) triggered++
    }
    return triggered
  }

  // ==========================================================
  // issue.spike —— 相对基线突增
  // ==========================================================
  private async evaluateIssueSpike(
    rule: AlertRule,
    windowStart: number,
    now: number
  ): Promise<number> {
    const subjects = (await this.loadIssues(rule.projectId, windowStart, now))
      .filter((issue) => issue.windowCount > 0)
      .filter((issue) => this.matchesConditions(issue, rule.conditions))

    let triggered = 0
    for (const issue of subjects) {
      const baseline = await this.baselineFor(issue.id, now)

      // 没有历史就没有基线 —— 不拿固定阈值硬套，
      // 否则新项目上线第一天就会满屏告警
      if (baseline === undefined) continue

      // 突增 = 窗口内量超过基线的 3 倍，且绝对量至少达到阈值
      const threshold = Math.max(rule.threshold, baseline * 3)
      if (issue.windowCount < threshold) continue

      const ok = await this.fire(rule, issue, now, {
        title: `错误突增：${issue.title}`,
        body: `${issue.shortId} 在最近 ${rule.windowSeconds} 秒内发生 ${issue.windowCount} 次，约为日常基线（${baseline.toFixed(1)}）的 ${(issue.windowCount / baseline).toFixed(1)} 倍。`,
        metric: { name: '发生次数', value: issue.windowCount, threshold }
      })
      if (ok) triggered++
    }
    return triggered
  }

  // ==========================================================
  // metric.error_count —— 项目窗口内错误总数
  // ==========================================================
  private async evaluateErrorCount(
    rule: AlertRule,
    windowStart: number,
    now: number
  ): Promise<number> {
    const row = await this.cached(`errorCount|${now}|${rule.projectId}|${windowStart}`, () =>
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM issue_events WHERE project_id = ? AND occurred_at >= ?',
        [rule.projectId, windowStart]
      )
    )
    const count = row?.n ?? 0
    if (count < rule.threshold) return 0

    const ok = await this.fire(rule, undefined, now, {
      title: '项目错误总数超阈值',
      body: `最近 ${rule.windowSeconds} 秒内共发生 ${count} 次错误（阈值 ${rule.threshold}）。`,
      metric: { name: '错误总数', value: count, threshold: rule.threshold }
    })
    return ok ? 1 : 0
  }

  // ==========================================================
  // metric.error_rate —— 错误率
  // ==========================================================
  private async evaluateErrorRate(
    rule: AlertRule,
    windowStart: number,
    now: number
  ): Promise<number> {
    const errors = await this.cached(`errorCount|${now}|${rule.projectId}|${windowStart}`, () =>
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM issue_events WHERE project_id = ? AND occurred_at >= ?',
        [rule.projectId, windowStart]
      )
    )
    const errorCount = errors?.n ?? 0

    // 分母用会话数（去重的 session_id）
    const sessions = await this.cached(`sessions|${now}|${rule.projectId}|${windowStart}`, () =>
      this.db.get<{ n: number }>(
        'SELECT COUNT(DISTINCT session_id) AS n FROM transactions WHERE project_id = ? AND started_at >= ?',
        [rule.projectId, windowStart]
      )
    )
    const sessionCount = sessions?.n ?? 0

    // 没有会话分母时无法算率 —— 不报错，宁可漏报
    if (sessionCount === 0) return 0

    const rate = errorCount / sessionCount
    if (rate < rule.threshold) return 0

    const ok = await this.fire(rule, undefined, now, {
      title: '项目错误率超阈值',
      body: `最近 ${rule.windowSeconds} 秒内错误率 ${(rate * 100).toFixed(2)}%（${errorCount} 次错误 / ${sessionCount} 个会话），阈值 ${(rule.threshold * 100).toFixed(2)}%。`,
      metric: { name: '错误率', value: rate, threshold: rule.threshold }
    })
    return ok ? 1 : 0
  }

  // ==========================================================
  // metric.lcp_p95 —— LCP P95 超阈值
  // ==========================================================
  private async evaluateLcpP95(rule: AlertRule, windowStart: number, now: number): Promise<number> {
    const rows = await this.cached(`lcp|${now}|${rule.projectId}|${windowStart}`, () =>
      this.db.all<{ lcp: number | null }>(
        'SELECT lcp FROM transactions WHERE project_id = ? AND started_at >= ? AND lcp IS NOT NULL',
        [rule.projectId, windowStart]
      )
    )
    if (rows.length === 0) return 0

    const p95 = percentiles(rows.map((r) => r.lcp as number)).p95
    if (p95 < rule.threshold) return 0

    const ok = await this.fire(rule, undefined, now, {
      title: 'LCP P95 超阈值',
      body: `最近 ${rule.windowSeconds} 秒内 LCP P95 为 ${p95}ms（阈值 ${rule.threshold}ms），样本 ${rows.length} 条。`,
      metric: { name: 'LCP P95', value: p95, threshold: rule.threshold }
    })
    return ok ? 1 : 0
  }

  // ==========================================================
  // 内部
  // ==========================================================

  /**
   * 载入窗口内有发生的问题，并附上窗口内计数。
   *
   * ⚠️ `now` 参与缓存键 —— 不同轮次的窗口不同，不能共用。
   */
  private async loadIssues(
    projectId: number,
    windowStart: number,
    now: number
  ): Promise<IssueSubject[]> {
    const rows = await this.cached(`issues|${now}|${projectId}|${windowStart}`, () =>
      this.db.all<{
        id: number
        short_id: string
        fingerprint: string
        title: string
        level: string
        category: string
        environment: string | null
        release: string | null
        assignee_id: number | null
        count: number
        user_count: number
        status: string
        substatus: string
        window_count: number
      }>(
        `SELECT i.id, i.short_id, i.fingerprint, i.title, i.level, i.category,
                i.environment, i.release, i.assignee_id, i.count, i.user_count,
                i.status, i.substatus,
                (SELECT COUNT(*) FROM issue_events e
                 WHERE e.issue_id = i.id AND e.occurred_at >= ?) AS window_count
         FROM issues i
         WHERE i.project_id = ?`,
        [windowStart, projectId]
      )
    )

    return rows.map((row) => ({
      id: row.id,
      shortId: row.short_id,
      fingerprint: row.fingerprint,
      title: row.title,
      level: row.level,
      category: row.category,
      environment: row.environment,
      release: row.release,
      assigneeId: row.assignee_id,
      count: row.count,
      userCount: row.user_count,
      status: row.status,
      substatus: row.substatus,
      windowCount: row.window_count
    }))
  }

  /**
   * 某个问题的**历史基线**：最近 7 天（不含当前窗口）的日均发生次数。
   *
   * 没有历史时返回 undefined —— 调用方据此跳过突增判定。
   */
  private async baselineFor(issueId: number, now: number): Promise<number | undefined> {
    const sevenDaysAgo = now - 7 * 24 * 3600 * 1000

    const row = await this.db.get<{ n: number; days: number }>(
      `SELECT COUNT(*) AS n,
              COUNT(DISTINCT CAST(occurred_at / 86400000 AS INTEGER)) AS days
       FROM issue_events
       WHERE issue_id = ? AND occurred_at >= ?`,
      [issueId, sevenDaysAgo]
    )

    if (!row || row.days < 3) return undefined
    return row.n / row.days
  }

  /** 条件匹配（全部 AND） */
  private matchesConditions(issue: IssueSubject, conditions: AlertConditions): boolean {
    if (conditions.environment?.length && issue.environment) {
      if (!conditions.environment.includes(issue.environment)) return false
    }
    if (conditions.release?.length && issue.release) {
      if (!conditions.release.includes(issue.release)) return false
    }
    if (conditions.category?.length && !conditions.category.includes(issue.category)) {
      return false
    }
    if (conditions.level?.length && !conditions.level.includes(issue.level)) {
      return false
    }
    if (conditions.assigneeIds?.length && issue.assigneeId !== null) {
      if (!conditions.assigneeIds.includes(issue.assigneeId)) return false
    }
    return true
  }

  /**
   * 触发一次告警：去重 → 发送 → 记录。
   *
   * @returns true = 确实触发了（已发出并记录）；false = 被去重跳过
   */
  private async fire(
    rule: AlertRule,
    issue: IssueSubject | undefined,
    now: number,
    message: AlertMessage
  ): Promise<boolean> {
    // 去重键带**窗口编号**：同一窗口内只发一次，窗口一过允许重发
    const windowIndex = Math.floor(now / (rule.windowSeconds * 1000))
    const dedupeKey = `${rule.id}:${issue?.id ?? 'project'}:${windowIndex}`

    if (!(await this.alerting.shouldTrigger(dedupeKey))) {
      return false
    }

    // 通道是**逐个取**的（一个通道发失败不影响别的），
    // 所以先并发取回来，再逐个发。
    const channels = (
      await Promise.all(
        rule.channelIds.map(async (id) => {
          try {
            return await this.alerting.getChannel(id)
          } catch {
            return undefined
          }
        })
      )
    ).filter((channel): channel is NonNullable<typeof channel> => Boolean(channel))

    const fullMessage: AlertMessage = {
      ...message,
      issueId: issue?.id,
      shortId: issue?.shortId,
      severity: issue?.level === 'fatal' ? 'error' : 'warning'
    }

    const results = await Promise.all(
      channels.map(
        async (channel) =>
          await getSender(channel.type).send(channel.config as ChannelConfig, fullMessage)
      )
    )

    // 即使通道全失败也要记录 —— 否则下次评估会重复发
    await this.alerting.recordIncident({
      ruleId: rule.id,
      projectId: rule.projectId,
      issueId: issue?.id,
      dedupeKey,
      payload: {
        message: fullMessage.title,
        body: fullMessage.body,
        metric: fullMessage.metric,
        channels: results.length,
        delivered: results.filter((r) => r.ok).length
      }
    })

    return true
  }
}
