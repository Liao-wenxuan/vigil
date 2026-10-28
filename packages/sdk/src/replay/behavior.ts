import type { BehaviorEvent, SessionSummary } from '@vigil/protocol'
import { collectContext, isBrowser } from '../context'
import { maskSensitiveText } from './recorder'

/**
 * 用户行为采集。
 *
 * ## 隐私边界画在哪
 *
 * **不记录任何输入内容** —— 只记「点了某个按钮」，不记「在搜索框里输入了 xxx」。
 * 输入内容是最敏感的数据，而它对定位问题的价值最低：
 * 知道用户点了「提交订单」已经够了。
 *
 * 点击目标的文字会做 PII 脱敏（手机号/邮箱/身份证）并截断到 40 字。
 */
export interface BehaviorOptions {
  /** 会话采样率（0~1），默认 1 */
  sampleRate?: number
  /** 攒多少条上报一次 */
  flushIntervalMs?: number
  /** 缓冲区最多多少条 */
  maxEvents?: number
  /** 是否记录点击 */
  trackClicks?: boolean
}

export class BehaviorCollector {
  private readonly options: BehaviorOptions
  private readonly sampled: boolean

  private events: BehaviorEvent[] = []
  private path: string[] = []
  private startedAt = Date.now()
  private lastEventAt = Date.now()
  private entryPage?: string
  private exitPage?: string

  private teardown: Array<() => void> = []
  private started = false

  constructor(options: BehaviorOptions = {}) {
    this.options = options
    this.sampled = Math.random() < (options.sampleRate ?? 1)
  }

  get isSampled(): boolean {
    return this.sampled
  }

  start(): void {
    if (this.started || !this.sampled || !isBrowser()) return
    this.started = true
    this.startedAt = Date.now()

    // 首个页面
    this.recordPageView(window.location.pathname + window.location.search)

    this.installRouteTracking()
    if (this.options.trackClicks !== false) this.installClickTracking()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    for (const fn of this.teardown) {
      try {
        fn()
      } catch {
        // 忽略卸载异常
      }
    }
    this.teardown = []
  }

  /** 取走待上报的事件与会话汇总 */
  take(): { events: BehaviorEvent[]; session: SessionSummary } {
    const context = collectContext()
    const events = this.events
    this.events = []

    const session: SessionSummary = {
      sessionId: context.sessionId,

      startedAt: this.startedAt,
      endedAt: Date.now(),
      durationMs: Date.now() - this.startedAt,
      pageViews: events.filter((e) => e.type === 'pageview').length,
      entryPage: this.entryPage,
      exitPage: this.exitPage,
      path: this.path.slice(0, 30),
      userAgent: context.userAgent,
      referrer: document.referrer || undefined
    }

    return { events, session }
  }

  /** 只看不取 */
  peek(): BehaviorEvent[] {
    return this.events.slice()
  }

  // ==========================================================
  // 内部
  // ==========================================================

  private recordPageView(url: string): void {
    this.push({
      type: 'pageview',
      name: url,
      url: window.location.href,
      timestamp: Date.now()
    })
  }

  private push(event: BehaviorEvent): void {
    const now = event.timestamp
    // 停留时长 = 距上一个事件的间隔
    const durationMs = now - this.lastEventAt
    this.lastEventAt = now
    if (durationMs > 0) event.durationMs = durationMs

    // 每条事件都带上会话 —— 服务端靠它归属
    const context = collectContext()
    event.sessionId = context.sessionId

    this.events.push(event)
    const max = this.options.maxEvents ?? 200
    if (this.events.length > max) {
      this.events.splice(0, this.events.length - max)
    }
  }

  /**
   * 路由跟踪。
   *
   * history.pushState / replaceState **不触发** popstate，
   * 所以必须自己打补丁。
   *
   * ⚠️ 核心的面包屑采集器也打了同样的补丁。这里是**后打**的，
   *    所以会包住核心的补丁 —— 两个都能触发。
   *    卸载时按安装的**逆序**还原才不会互相踩。
   */
  private installRouteTracking(): void {
    const history = window.history
    const originalPushState = history.pushState
    const originalReplaceState = history.replaceState

    // 闭包里的回调要能回到实例上
    const onRouteChange = () => this.handleRouteChange()

    history.pushState = function patchedPushState(
      this: History,
      ...args: Parameters<History['pushState']>
    ) {
      const result = originalPushState.apply(this, args)
      queueMicrotask(onRouteChange)
      return result
    }

    history.replaceState = function patchedReplaceState(
      this: History,
      ...args: Parameters<History['replaceState']>
    ) {
      const result = originalReplaceState.apply(this, args)
      queueMicrotask(onRouteChange)
      return result
    }

    const onPopState = () => onRouteChange()
    window.addEventListener('popstate', onPopState)

    this.teardown.push(() => {
      history.pushState = originalPushState
      history.replaceState = originalReplaceState
      window.removeEventListener('popstate', onPopState)
    })
  }

  /** 路由变化：记一条 route 事件，并更新访问路径 */
  private handleRouteChange(): void {
    const path = window.location.pathname + window.location.search

    // 同一个路径不重复记
    if (this.path[this.path.length - 1] === path) return

    this.path.push(path)
    if (this.path.length > 30) this.path.shift()

    this.exitPage = this.exitPage ?? this.entryPage
    this.exitPage = path

    this.push({
      type: 'route',
      name: path,
      url: window.location.href,
      timestamp: Date.now()
    })
  }

  private installClickTracking(): void {
    const onClick = (event: Event) => {
      const target = event.target as (Element & { tagName?: string }) | null
      if (!target || typeof target.tagName !== 'string') return

      const tag = target.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return

      const text = (target.textContent ?? '').trim()
      const name = text ? `${tag}:${maskSensitiveText(text).slice(0, 40)}` : tag

      this.push({
        type: 'click',
        name,
        url: window.location.href,
        timestamp: Date.now(),
        data: { tag }
      })
    }

    // 捕获阶段：冒泡阶段可能被业务代码 stopPropagation 截断
    document.addEventListener('click', onClick, true)

    this.teardown.push(() => {
      document.removeEventListener('click', onClick, true)
    })
  }
}
