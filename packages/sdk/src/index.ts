import type { BreadcrumbType, ErrorEvent } from '@vigil/protocol'
import { BreadcrumbRecorder, installBreadcrumbs } from './collectors/breadcrumbs'
import { installGlobalErrorHandler } from './collectors/global'
import { installNetworkCapture, nativeFetch, type HttpErrorPolicy } from './collectors/network'
import { installUnhandledRejectionHandler } from './collectors/promise'
import { collectContext, detectSelfUrls, isBrowser } from './context'
import { computeFingerprint, normalizeCustomFingerprint } from './fingerprint'
import { maskRecord, maskUrl, scrubText } from './mask'
import { parseStack } from './parse-stack'
import { EventQueue } from './queue'
import { combineTeardowns, type ReportInput, type Reporter, type Teardown } from './reporter'
import { sendBatch, splitIntoBatches, type TransportOptions } from './transport'

export { SDK_NAME, SDK_VERSION } from './version'
export type { Breadcrumb, BreadcrumbType, ErrorEvent } from '@vigil/protocol'
export type { HttpErrorPolicy } from './collectors/network'

/** 默认参数 */
const DEFAULTS = {
  /** 会话采样率。默认 1 = 全量 */
  sampleRate: 1,
  /** 最多保留多少条面包屑 */
  maxBreadcrumbs: 30,
  /** 定时上报间隔 */
  flushIntervalMs: 5000,
  /** 一批最多几条 */
  maxBatchSize: 20,
  /** 单个请求体上限。浏览器对 beacon / keepalive 的限制都是 64KB 量级 */
  maxPayloadBytes: 48 * 1024,
  /** 哪些 HTTP 状态算错误 */
  httpErrorPolicy: '5xx' as HttpErrorPolicy,
  /** 是否采集 console 输出作为面包屑 */
  captureConsoleBreadcrumbs: true,
  /** 开关 */
  enabled: true,
  debug: false
}

export interface VigilOptions {
  /** 采集接口完整地址，例如 https://collector.example.com/api/v1/collect */
  endpoint: string
  /** 应用 ID */
  appId: string
  /** 运行时 token */
  token: string
  /** 发布版本，用于区分「这个错误是哪个版本引入的」 */
  release?: string
  /** 运行环境：production / staging / development */
  environment?: string
  /** 当前用户 ID（可后续用 setUser 更新） */
  userId?: string
  /**
   * 会话采样率（0~1）。
   *
   * 采样是**按会话**决定的，不按单条事件随机抽 —— 随机抽事件会得到
   * 「同一个用户只上报了部分错误」的残缺上下文，比不采样更误导。
   * 整个会话要么全采要么全不采，采中的会话里每一条错误都在。
   */
  sampleRate?: number
  maxBreadcrumbs?: number
  flushIntervalMs?: number
  maxBatchSize?: number
  maxPayloadBytes?: number
  httpErrorPolicy?: HttpErrorPolicy
  captureConsoleBreadcrumbs?: boolean
  enabled?: boolean
  debug?: boolean
}

interface ResolvedOptions {
  endpoint: string
  appId: string
  token: string
  release?: string
  environment?: string
  userId?: string
  sampleRate: number
  maxBreadcrumbs: number
  flushIntervalMs: number
  maxBatchSize: number
  maxPayloadBytes: number
  httpErrorPolicy: HttpErrorPolicy
  captureConsoleBreadcrumbs: boolean
  enabled: boolean
  debug: boolean
}

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

  private teardown: Teardown = () => {}
  private extraContext: Record<string, unknown> = {}
  private userId: string | undefined
  /** 下一次 flush 优先用 beacon（页面正在卸载） */
  private preferBeacon = false
  private closed = false
  private started = false

  constructor(options: VigilOptions) {
    this.resolved = {
      ...DEFAULTS,
      ...options,
      sampleRate: clamp(options.sampleRate ?? DEFAULTS.sampleRate, 0, 1),
      maxPayloadBytes: Math.min(options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes, 60 * 1024)
    }
    this.userId = options.userId
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
      this.installLifecycleFlush()
    ]

    this.teardown = combineTeardowns(teardowns)
    this.queue.start()
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
      void this.queue.flush()
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
    this.recorder.clear()
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
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
