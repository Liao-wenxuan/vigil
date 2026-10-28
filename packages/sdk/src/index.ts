import type { BreadcrumbType, ErrorEvent, PerformanceEvent } from '@vigil/protocol'
import { BreadcrumbRecorder, installBreadcrumbs } from './collectors/breadcrumbs'
import { installGlobalErrorHandler } from './collectors/global'
import { installNetworkCapture, nativeFetch } from './collectors/network'
import { BlankScreenDetector, PerformanceCollector } from './collectors/performance'
import { installUnhandledRejectionHandler } from './collectors/promise'
import { collectContext, detectSelfUrls, isBrowser } from './context'
import { computeFingerprint, normalizeCustomFingerprint } from './fingerprint'
import { maskRecord, maskUrl, scrubText } from './mask'
import { DEFAULTS, type ResolvedOptions, type VigilOptions } from './options'
import { parseStack } from './parse-stack'
import { runPluginEnrich, setupPlugins, type VigilPlugin, type VigilPluginHost } from './plugin'
import { EventQueue } from './queue'
import { combineTeardowns, type ReportInput, type Reporter, type Teardown } from './reporter'
import { sendBatch, splitIntoBatches, type TransportOptions } from './transport'
import { SDK_NAME, SDK_VERSION } from './version'

export { SDK_NAME, SDK_VERSION } from './version'
export { DEFAULTS, type VigilOptions } from './options'
export type { VigilPlugin, VigilPluginHost } from './plugin'
export type { Breadcrumb, BreadcrumbType, ErrorEvent } from '@vigil/protocol'
export type { HttpErrorPolicy } from './collectors/network'

export interface CaptureExtra {
  /** 附加到这条错误上的业务上下文（会被脱敏） */
  context?: Record<string, unknown>
  /**
   * 自定义指纹。同一组自定义指纹的错误会被聚合成一条。
   *
   * 适用场景：SDK 算不出稳定指纹时（比如错误发生在 Web Worker 里，没有栈）。
   */
  fingerprint?: string
}

export interface BreadcrumbInput {
  type?: BreadcrumbType
  category?: string
  message?: string
  data?: Record<string, unknown>
}

/**
 * SDK 客户端。
 *
 * 一个进程内可以有多个实例（比如同一个页面接了两个不同的采集端点），
 * 但绝大多数场景用 `init()` 拿默认实例就够了。
 */
export class VigilClient {
  private readonly resolved: ResolvedOptions
  private readonly recorder: BreadcrumbRecorder
  private readonly queue: EventQueue
  private readonly transport: TransportOptions
  private readonly sdkFilenames: string[]
  private readonly sampled: boolean
  /** 性能数据**独立采样**（默认 10%）—— 性能量大且大多是正常的 */
  private readonly performanceSampled: boolean
  private readonly performanceQueue: EventQueue
  private readonly performanceTransport: TransportOptions
  private performanceCollector: PerformanceCollector | null = null
  private blankScreen: BlankScreenDetector | null = null
  /** 已安装的插件 */
  private installedPlugins: VigilPlugin[] = []

  private teardown: Teardown = () => {}
  private extraContext: Record<string, unknown> = {}
  private userId: string | undefined
  /** 会话 ID：整个生命周期内保持不变（标签页级） */
  private readonly sessionId: string
  /** 下一次 flush 优先用 beacon（页面正在卸载） */
  private preferBeacon = false
  private closed = false
  private started = false

  constructor(options: VigilOptions) {
    this.resolved = {
      ...DEFAULTS,
      ...options,
      sampleRate: clamp(options.sampleRate ?? DEFAULTS.sampleRate, 0, 1),
      maxPayloadBytes: Math.min(options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes, 60 * 1024),
      plugins: options.plugins ?? []
    }
    this.userId = options.userId
    this.sessionId = collectContext().sessionId
    this.recorder = new BreadcrumbRecorder(this.resolved.maxBreadcrumbs)
    this.sdkFilenames = detectSelfUrls()
    this.sampled = Math.random() < this.resolved.sampleRate

    this.transport = {
      endpoint: this.resolved.endpoint,
      appId: this.resolved.appId,
      token: this.resolved.token,
      maxPayloadBytes: this.resolved.maxPayloadBytes,
      maxBatchSize: this.resolved.maxBatchSize,
      fetchImpl:
        nativeFetch ?? ((() => Promise.reject(new Error('fetch unavailable'))) as typeof fetch),
      beaconImpl:
        typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
          ? (url: string, data: Blob) => navigator.sendBeacon(url, data)
          : undefined
    }

    this.queue = new EventQueue({
      maxSize: this.resolved.maxBatchSize,
      flushIntervalMs: this.resolved.flushIntervalMs,
      onFlush: (events) => this.send(events),
      onError: (error) => {
        if (this.resolved.debug) console.warn('[vigil] 上报失败', error)
      }
    })

    // ---- 性能：独立通道、独立采样 ----
    // 错误走 /collect，性能走 /performance。两条通道的采样率、批量策略、
    // 保留周期全都不同，混在一起会让「错误要全量、性能要采样」没法实现。
    this.performanceSampled = Math.random() < this.resolved.performanceSampleRate

    this.performanceTransport = {
      ...this.transport,
      endpoint: this.resolved.endpoint.replace(/\/collect$/, '/performance')
    }

    this.performanceQueue = new EventQueue({
      maxSize: this.resolved.maxBatchSize,
      flushIntervalMs: this.resolved.flushIntervalMs,
      onFlush: (events) => this.sendPerformance(events as unknown as PerformanceEvent[]),
      onError: (error) => {
        if (this.resolved.debug) console.warn('[vigil] 性能上报失败', error)
      }
    })
  }

  /** 安装所有采集器并开始工作 */
  start(): void {
    if (this.started) return
    this.started = true

    if (!this.resolved.enabled) return
    if (!isBrowser()) return

    const reporter: Reporter = (input) => this.handleReport(input)

    const teardowns: Teardown[] = [
      installGlobalErrorHandler(reporter),
      installUnhandledRejectionHandler(reporter),
      installNetworkCapture(reporter, {
        endpoint: this.resolved.endpoint,
        policy: this.resolved.httpErrorPolicy
      }),
      installBreadcrumbs({
        recorder: this.recorder,
        captureConsole: this.resolved.captureConsoleBreadcrumbs
      }),
      this.installPerformance(),
      this.installLifecycleFlush()
    ]

    this.teardown = combineTeardowns(teardowns)
    this.queue.start()

    // ---- 插件 ----
    // 回放、行为分析都走这里。核心不感知它们的存在。
    this.installedPlugins = setupPlugins(this.resolved.plugins, this.createPluginHost())
  }

  /**
   * 插件宿主。
   *
   * 插件拿到的是**能力**（发请求、加上下文），不是整个客户端 ——
   * 这样插件不会有能力去改 SDK 的内部状态。
   */
  private createPluginHost(): VigilPluginHost {
    // 箭头函数天然捕获 this，不需要 `const client = this`（那会被 no-this-alias 拦）
    const getUserId = (): string | undefined => this.userId
    const getSessionId = (): string => this.sessionId
    const post = (path: string, body: unknown): void => {
      void this.postTo(path, body)
    }
    const addContext = (context: Record<string, unknown>): void => {
      this.extraContext = { ...this.extraContext, ...context }
    }

    return {
      options: this.resolved,
      get sessionId() {
        return getSessionId()
      },
      get userId() {
        return getUserId()
      },
      post,
      addContext
    }
  }

  /**
   * POST 到采集服务的任意路径（插件用）。
   *
   * 鉴权头自动带上，所以插件不用管 token 放哪。
   */
  private async postTo(path: string, body: unknown): Promise<void> {
    try {
      const response = await this.transport.fetchImpl(`${this.resolved.endpoint}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'X-Vigil-App-Id': this.resolved.appId,
          'X-Vigil-Token': this.resolved.token
        }
      })
      if (!response.ok && this.resolved.debug) {
        console.warn(`[vigil] ${path} 上报失败：HTTP ${response.status}`)
      }
    } catch (error) {
      if (this.resolved.debug) console.warn(`[vigil] ${path} 上报失败`, error)
    }
  }

  /**
   * 装��性能采集与白屏检测。
   *
   * 白屏检测用**双重信号**：FCP 超时 **且** DOM 采样全空。
   * 只看 FCP 会误判（页面确实慢但有内容），只看 DOM 会误判（正在渲染中）。
   */
  private installPerformance(): Teardown {
    if (!this.resolved.enablePerformance) return () => {}

    this.performanceCollector = new PerformanceCollector({
      sampleRate: this.resolved.performanceSampleRate,
      shouldSample: () => this.performanceSampled,
      onTransaction: (event) => {
        event.sessionId = this.sessionId
        event.userId = this.userId
        event.release = this.resolved.release
        event.environment = this.resolved.environment
        this.performanceQueue.push(event as unknown as ErrorEvent)
      }
    })
    this.performanceCollector.start()
    this.performanceQueue.start()

    this.blankScreen = new BlankScreenDetector({
      timeoutMs: this.resolved.blankScreenTimeoutMs,
      hasContentPaint: () => {
        const snapshot = this.performanceCollector?.snapshot()
        return (snapshot?.fcp ?? 0) > 0
      },
      onBlank: ({ elapsedMs, samples }) => {
        // 白屏当成一条错误上报 —— 它对用户的影响和崩溃一样严重
        this.handleReport({
          category: 'javascript',
          kind: 'manual',
          name: 'BlankScreen',
          message: `页面在 ${elapsedMs}ms 内白屏（${samples}/5 个采样点为空）`,
          context: { blankScreen: true, elapsedMs, samples }
        })
      }
    })
    this.blankScreen.start()

    return () => {
      this.performanceCollector?.stop()
      this.blankScreen?.stop()
      this.performanceQueue.stop()
    }
  }

  /**
   * 页面生命周期钩子。
   *
   * 用 `pagehide` 而不是 `unload`：unload 会让页面进不了 bfcache，
   * 用户「后退」时页面要重新加载，体感明显变慢。pagehide 没有这个问题。
   */
  private installLifecycleFlush(): Teardown {
    const flushWithBeacon = () => {
      this.preferBeacon = true
      // 页面要走了 —— 先把性能事务结算掉（vitals 到此刻才完整）
      this.performanceCollector?.report()
      void this.queue.flush()
      void this.performanceQueue.flush()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushWithBeacon()
    }

    window.addEventListener('pagehide', flushWithBeacon)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('pagehide', flushWithBeacon)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
  /** 内部上报入口 —— 任何异常都不能让它抛到业务代码里 */
  private handleReport(input: ReportInput): void {
    if (this.closed) return
    if (!this.sampled) return

    try {
      this.queue.push(this.buildEvent(input))
    } catch (error) {
      if (this.resolved.debug) console.warn('[vigil] 事件构建失败', error)
    }
  }

  /** 把采集器描述的错误组装成一条完整事件 */
  private buildEvent(input: ReportInput): ErrorEvent {
    const context = collectContext()
    const stack = input.stack
    const frames = input.frames ?? parseStack(stack)

    const fingerprint = input.fingerprint
      ? normalizeCustomFingerprint(input.fingerprint)
      : computeFingerprint({
          category: input.category,
          name: input.name,
          message: input.message,
          frames,
          resource: input.resource,
          http: input.http,
          sdkFilenames: this.sdkFilenames
        })

    const event: ErrorEvent = {
      category: input.category,
      kind: input.kind,
      // 事件唯一 ID：服务端用它去重（网络重试不该让 count 虚高）
      eventId: generateEventId(),
      message: scrubText(input.message),
      frames,
      fingerprint,
      url: maskUrl(window.location.href),
      userAgent: context.userAgent,
      sessionId: context.sessionId,
      occurredAt: Date.now()
    }

    if (input.name) event.name = input.name
    if (stack) event.stack = scrubText(stack)
    if (document.referrer) event.referrer = maskUrl(document.referrer)
    if (context.locale) event.locale = context.locale
    if (context.timezone) event.timezone = context.timezone
    if (context.viewport) event.viewport = context.viewport
    if (context.screen) event.screen = context.screen
    if (context.connection) event.connection = context.connection
    if (this.userId) event.userId = this.userId
    if (this.resolved.release) event.release = this.resolved.release
    if (this.resolved.environment) event.environment = this.resolved.environment
    if (input.context) event.context = maskRecord(input.context)
    if (this.extraContext) event.extra = maskRecord(this.extraContext)
    if (input.resource) event.resource = input.resource
    if (input.http) event.http = input.http

    const breadcrumbs = this.recorder.list()
    if (breadcrumbs.length > 0) event.breadcrumbs = breadcrumbs

    // 错误与性能关联：把报错瞬间的性能快照带上。
    // 很多「页面卡」表面是性能问题，根因却是没捕获的异常 ——
    // 有了这个快照才能判断「这个错误是不是拖慢了这页」。
    const vitals = this.performanceCollector?.snapshot()
    if (vitals && Object.keys(vitals).length > 0) event.vitals = vitals

    // 插件增强：回放插件在这里把事件流挂到事件上
    runPluginEnrich(this.installedPlugins, event)

    return event
  }

  /** 发送一批事件 */
  private async send(events: ErrorEvent[]): Promise<void> {
    const batches = splitIntoBatches(
      events,
      this.resolved.maxPayloadBytes,
      this.resolved.maxBatchSize
    )

    for (const batch of batches) {
      const ok = await sendBatch(batch, this.transport, this.preferBeacon)
      if (!ok && this.resolved.debug) {
        console.warn(`[vigil] ${batch.length} 条事件上报失败`)
      }
    }

    // beacon 只对「这次卸载」有意义，用完就复位
    this.preferBeacon = false
  }

  /**
   * 发送性能事务。
   *
   * 走**独立通道**（/performance），和错误分开：
   * 性能数据量大且大多是正常的，采样率、批量大小、保留周期都该独立调。
   */
  private async sendPerformance(transactions: PerformanceEvent[]): Promise<void> {
    if (transactions.length === 0) return

    const batches = splitIntoBatches(
      transactions as unknown as ErrorEvent[],
      this.resolved.maxPayloadBytes,
      this.resolved.maxBatchSize
    )

    for (const batch of batches) {
      const body = JSON.stringify({
        appId: this.resolved.appId,
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        transactions: batch
      })

      try {
        const response = await this.performanceTransport.fetchImpl(
          this.performanceTransport.endpoint,
          {
            method: 'POST',
            body,
            keepalive: true,
            credentials: 'omit',
            headers: {
              'Content-Type': 'application/json',
              'X-Vigil-App-Id': this.resolved.appId,
              'X-Vigil-Token': this.resolved.token
            }
          }
        )
        if (!response.ok && this.resolved.debug) {
          console.warn(`[vigil] ${batch.length} 条性能数据上报失败`)
        }
      } catch (error) {
        if (this.resolved.debug) console.warn('[vigil] 性能上报失败', error)
      }
    }
  }

  /**
   * 开始一个路由事务（SPA 路由切换）。
   *
   * 用法：`vigil.startRoute('/orders')` —— 在路由 hook 里调。
   * 上一个路由的事务会在这次调用时结算。
   */
  startRoute(name: string): void {
    this.performanceCollector?.report()
    this.performanceCollector?.startRoute(name)
  }

  /** 手动上报一个错误 */
  captureException(error: unknown, extra?: CaptureExtra): void {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    const name = error instanceof Error ? error.name : undefined

    this.handleReport({
      category: 'javascript',
      kind: 'manual',
      name: name ?? 'Error',
      message: message || 'Unknown error',
      stack,
      frames: parseStack(stack),
      context: extra?.context,
      fingerprint: extra?.fingerprint
    })
  }

  /** 记录一条面包屑 */
  addBreadcrumb(crumb: BreadcrumbInput): void {
    this.recorder.add({
      type: crumb.type ?? 'custom',
      category: crumb.category ?? 'custom',
      message: crumb.message,
      data: crumb.data
    })
  }

  /** 更新当前用户 ID */
  setUser(userId: string | null | undefined): void {
    this.userId = userId ?? undefined
  }

  /** 设置全局附加上下文，会并到每一条事件上 */
  setContext(context: Record<string, unknown>): void {
    this.extraContext = { ...this.extraContext, ...context }
  }

  /** 立即上报队列里剩余的事件 */
  async flush(): Promise<void> {
    await this.queue.flush()
  }

  /** 停止采集并卸载所有监听器 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue.stop()
    this.teardown()

    for (const plugin of this.installedPlugins) {
      try {
        plugin.teardown?.()
      } catch (error) {
        console.warn(`[vigil] 插件 ${plugin.name} 卸载失败:`, error)
      }
    }
    this.installedPlugins = []

    this.recorder.clear()
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 生成事件唯一 ID。
 *
 * 服务端靠它去重：同一条事件因为网络重试被上报两次时，
 * 第二次会被挡下来，count 不会虚高。
 */
function generateEventId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // 非安全上下文下 randomUUID 不可用，往下走
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** 默认实例 */
let defaultClient: VigilClient | null = null

/**
 * 初始化 SDK。
 *
 * 重复调用会先关掉上一个实例 —— 否则旧的监听器还在跑，
 * 会把同一条错误上报两次。
 */
export function init(options: VigilOptions): VigilClient {
  defaultClient?.close()
  const client = new VigilClient(options)
  client.start()
  defaultClient = client
  return client
}

/** 用默认实例上报一个错误 */
export function captureException(error: unknown, extra?: CaptureExtra): void {
  defaultClient?.captureException(error, extra)
}

/** 用默认实例记录一条面包屑 */
export function addBreadcrumb(crumb: BreadcrumbInput): void {
  defaultClient?.addBreadcrumb(crumb)
}

/** 用默认实例设置当前用户 */
export function setUser(userId: string | null | undefined): void {
  defaultClient?.setUser(userId)
}

/** 拿到默认实例（可能为 null） */
export function getClient(): VigilClient | null {
  return defaultClient
}
