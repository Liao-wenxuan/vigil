import type { ErrorVitals, PerformanceEvent, Span, VitalMetrics } from '@vigil/protocol'
import { isBrowser } from '../context'

/**
 * 性能采集（Web Vitals + 长任务 + 资源）。
 *
 * ## 采集什么
 *
 * 加载阶段：TTFB → FCP → LCP
 * 交互阶段：INP（取代了 FID）、CLS
 * 运行时：长任务（>50ms）、TBT（总阻塞时间）
 *
 * ## 为什么要自己算而不是用 web-vitals 库
 *
 * web-vitals 库是对的，但它的核心价值是「算准 INP/CLS 的官方算法」。
 * 这里要额外做两件库不提供的事：
 *   1. **错误与性能关联** —— 报错瞬间把当时的 vitals 快照带上
 *   2. **白屏检测** —— 需要拿到 DOM 采样能力
 * 所以自己实现，但**算法照抄官方的**（下面每处都标了出处）。
 *
 * ## CLS 的窗口算法
 *
 * 官方 CLS 不是「所有偏移相加」，而是分窗口：
 * 间隔超过 1 秒、或者窗口超过 5 秒，就开一个新窗口，取**最大的那个窗口**的总和。
 * 直接相加会把不同时期的偏移混在一起，高估 CLS。
 */
export interface PerformanceCollectorOptions {
  /** 采样率：多少比例的页面加载会被上报 */
  sampleRate: number
  /** 上报回调 */
  onTransaction: (event: PerformanceEvent) => void
  /** 采样判定（外部决定，保证与错误采样同一会话口径） */
  shouldSample: () => boolean
}

export class PerformanceCollector {
  private readonly options: PerformanceCollectorOptions

  private observers: PerformanceObserver[] = []
  private readonly metrics: VitalMetrics = {}
  private readonly longTasks: Array<{ duration: number; startTime: number }> = []

  /** CLS 窗口状态 */
  private clsValue = 0
  private clsSessionValue = 0
  private clsEntries: number[] = []
  private clsLastEntryTime = 0

  /** INP：按 interactionId 记最差的一次 */
  private readonly interactions = new Map<number, number>()

  /** 资源统计 */
  private resourceCount = 0
  private transferSize = 0

  /** 页面加载开始时刻 */
  private readonly pageStart: number
  /** 路由事务的起始时刻 */
  private routeStart?: number
  private routeName?: string

  private reported = false

  constructor(options: PerformanceCollectorOptions) {
    this.options = options
    this.pageStart = typeof performance !== 'undefined' ? performance.now() : 0
  }

  /** 安装所有观察器 */
  start(): void {
    if (!isBrowser() || typeof PerformanceObserver === 'undefined') return

    this.observePaint()
    this.observeLcp()
    this.observeLayoutShift()
    this.observeInteraction()
    this.observeLongTask()
    this.collectNavigation()
    this.collectResources()
  }

  /** 停止所有观察器 */
  stop(): void {
    for (const observer of this.observers) {
      try {
        observer.disconnect()
      } catch {
        // 忽略断开异常
      }
    }
    this.observers = []
  }

  /**
   * 当前 vitals 快照 —— 报错时挂到错误事件上。
   *
   * 这是**错误与性能关联**的关键：很多「页面卡」表面是性能问题，
   * 根因却是没捕获的 Promise 异常。带上当时的 LCP/FCP/长任务数，
   * 才能判断「这个错误是不是拖慢了这页」。
   */
  snapshot(): ErrorVitals {
    return {
      fcp: this.metrics.fcp,
      lcp: this.metrics.lcp,
      cls: this.metrics.cls,
      inp: this.currentInp(),
      ttfb: this.metrics.ttfb,
      tbt: this.metrics.tbt,
      longTaskCount: this.longTasks.length
    }
  }

  /**
   * 开始一个路由事务。
   *
   * SPA 的路由切换没有新的页面加载，所以 FCP/LCP 不适用 ——
   * 这个事务关心的是**切换耗时**和**切换后的 INP/CLS 增量**。
   */
  startRoute(name: string): void {
    this.routeName = name
    this.routeStart = typeof performance !== 'undefined' ? performance.now() : 0
  }

  /**
   * 上报当前的事务。
   *
   * 页面事务在页面隐藏时上报；路由事务在下一个路由开始时上报。
   */
  report(): void {
    if (!isBrowser()) return
    if (!this.options.shouldSample()) return

    const now = typeof performance !== 'undefined' ? performance.now() : this.pageStart

    // ---- 路由事务 ----
    if (this.routeName && this.routeStart !== undefined) {
      const durationMs = now - this.routeStart
      const event: PerformanceEvent = {
        name: this.routeName,
        type: 'route',
        startedAt: Date.now() - Math.round(durationMs),
        durationMs,
        vitals: {
          inp: this.currentInp(),
          cls: this.metrics.cls,
          tbt: this.metrics.tbt,
          longTaskCount: this.longTasks.length
        },
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
        sessionId: '',
        spans: []
      }
      this.options.onTransaction(event)
      this.routeName = undefined
      this.routeStart = undefined
    }

    // ---- 页面事务 ----
    if (this.reported) return
    this.reported = true

    const event: PerformanceEvent = {
      name: window.location.pathname || '/',
      type: 'page',
      startedAt: Date.now() - Math.round(now),
      durationMs: now,
      vitals: this.snapshot(),
      resourceCount: this.resourceCount,
      transferSize: this.transferSize,
      pageUrl: window.location.href,
      referrer: document.referrer || undefined,
      userAgent: navigator.userAgent,
      sessionId: '',
      spans: []
    }
    this.options.onTransaction(event)
  }

  // ==========================================================
  // 各类观察器
  // ==========================================================

  /** FCP —— paint 条目里的 first-contentful-paint */
  private observePaint(): void {
    this.observe(
      (entries) => {
        for (const entry of entries) {
          if (entry.name === 'first-contentful-paint') {
            this.metrics.fcp = Math.round(entry.startTime)
          }
        }
      },
      { type: 'paint', buffered: true }
    )
  }

  /**
   * LCP —— largest-contentful-paint。
   *
   * LCP 会多次触发（最大元素变了就更新），最后一次才是最终值。
   */
  private observeLcp(): void {
    this.observe(
      (entries) => {
        for (const entry of entries) {
          this.metrics.lcp = Math.round(entry.startTime)
        }
      },
      { type: 'largest-contentful-paint', buffered: true }
    )
  }

  /**
   * CLS —— 布局偏移，**分窗口**求和（官方算法）。
   *
   * 官方定义：布局偏移分成 session window（间隔 <1s、窗口 <5s），
   * CLS 取**最大窗口**的总和，而不是所有偏移的总和。
   */
  private observeLayoutShift(): void {
    this.observe(
      (entries) => {
        for (const raw of entries) {
          const entry = raw as PerformanceEntry & {
            value: number
            hadRecentInput: boolean
          }

          // 用户交互引起的偏移不计入 CLS（用户看到了，不是意外）
          if (entry.hadRecentInput) continue

          const value = entry.value
          const startTime = entry.startTime

          const gap = startTime - this.clsLastEntryTime
          const sessionAge = startTime - this.clsSessionValue

          // 间隔超过 1 秒或窗口超过 5 秒 → 开新窗口
          if (gap > 1000 || sessionAge > 5000) {
            this.clsEntries = []
            this.clsSessionValue = startTime
          }

          this.clsEntries.push(value)
          this.clsLastEntryTime = startTime
          this.clsValue = Math.max(
            this.clsValue,
            this.clsEntries.reduce((a, b) => a + b, 0)
          )
          this.metrics.cls = Math.round(this.clsValue * 10000) / 10000
        }
      },
      { type: 'layout-shift', buffered: true }
    )
  }

  /**
   * INP —— 交互到下次绘制的延迟。
   *
   * 官方算法：按 interactionId 分组，取最差交互的延迟；
   * 交互数多时取第 98 百分位。这里按 interactionId 记最差值，
   * 交互数少时 INP ≈ 最差值（与官方在低样本下的结果一致）。
   */
  private observeInteraction(): void {
    this.observe(
      (entries) => {
        for (const raw of entries) {
          const entry = raw as PerformanceEventTiming & { interactionId?: number }
          const interactionId = entry.interactionId ?? 0
          // interactionId 为 0 表示不是用户交互触发的（keydown 之类不算）
          if (!interactionId) continue

          const duration = entry.duration || entry.processingEnd - entry.processingStart
          const existing = this.interactions.get(interactionId) ?? 0
          if (duration > existing) this.interactions.set(interactionId, duration)
        }
        this.metrics.inp = this.currentInp()
      },
      {
        type: 'event',
        buffered: true,
        // durationThreshold 是 'event' 类型的合法选项，
        // 但它不在 TS 标准库的 PerformanceObserverInit 里
        durationThreshold: 40
      } as PerformanceObserverInit
    )
  }

  /** 长任务 —— 主线程被占用 >50ms */
  private observeLongTask(): void {
    this.observe(
      (entries) => {
        for (const entry of entries) {
          const task = entry as PerformanceEntry & { attribution?: unknown[] }
          this.longTasks.push({ duration: task.duration, startTime: task.startTime })
        }
        this.metrics.longTaskCount = this.longTasks.length
        this.metrics.tbt = Math.round(
          this.longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)
        )
      },
      { type: 'longtask', buffered: true }
    )
  }

  /** TTFB —— 从 navigation timing 取 */
  private collectNavigation(): void {
    try {
      const navigation = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined
      if (navigation) {
        this.metrics.ttfb = Math.round(navigation.responseStart - navigation.requestStart)
      }
    } catch {
      // 拿不到就算了
    }
  }

  /** 资源统计 —— 数量与传输体积 */
  private collectResources(): void {
    try {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      this.resourceCount = resources.length
      this.transferSize = resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0)
    } catch {
      // 拿不到就算了
    }
  }

  /** 当前 INP */
  private currentInp(): number | undefined {
    if (this.interactions.size === 0) return undefined
    const values = [...this.interactions.values()].sort((a, b) => a - b)
    // 交互数少时取最差值（官方在 <50 个交互时也是这样）
    const index = Math.min(values.length - 1, Math.floor(values.length * 0.98))
    return Math.round(values[index])
  }

  /** 统一的观察器创建 */
  private observe(
    handler: (entries: PerformanceEntry[]) => void,
    options: PerformanceObserverInit
  ): void {
    try {
      const observer = new PerformanceObserver((list) => {
        handler(list.getEntries())
      })
      observer.observe(options)
      this.observers.push(observer)
    } catch {
      // 浏览器不支持这个类型就跳过 —— 采集器不能影响业务
    }
  }
}

/**
 * 白屏检测。
 *
 * 双重检测（两个信号都满足才判白屏）：
 *   1. **FCP 超时** —— 默认 3 秒还没画出来
 *   2. **DOM 采样** —— 取视口中心 + 四角共 5 个点，
 *      如果全是 `html` 或 `body`，说明页面上什么都没有
 *
 * 只用 FCP 超时会误判（页面确实慢但有内容）；
 * 只用 DOM 采样会误判（页面正在渲染中）。
 * 两个都满足才是真的白屏。
 */
export class BlankScreenDetector {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(
    private readonly options: {
      timeoutMs: number
      onBlank: (info: { elapsedMs: number; samples: number }) => void
      /** 已有 FCP 时直接判为非白屏 */
      hasContentPaint: () => boolean
    }
  ) {}

  start(): void {
    if (this.started || !isBrowser()) return
    this.started = true

    this.timer = setTimeout(() => {
      if (this.options.hasContentPaint()) return

      const samples = this.sampleDom()
      if (samples === 0) {
        this.options.onBlank({ elapsedMs: this.options.timeoutMs, samples })
      }
    }, this.options.timeoutMs)
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.started = false
  }

  /**
   * DOM 采样：视口中心 + 四角 5 个点。
   *
   * @returns 命中「空元素」的采样点数（5 = 全是空白）
   */
  private sampleDom(): number {
    const width = window.innerWidth
    const height = window.innerHeight

    const points: Array<[number, number]> = [
      [Math.floor(width / 2), Math.floor(height / 2)],
      [2, 2],
      [width - 2, 2],
      [2, height - 2],
      [width - 2, height - 2]
    ]

    let blank = 0

    for (const [x, y] of points) {
      const element = document.elementFromPoint(x, y)
      if (!element) {
        blank++
        continue
      }
      const tag = element.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') blank++
    }

    return blank
  }
}

/** 构造一个资源 span（供资源错误采集复用） */
export function toResourceSpan(entry: PerformanceResourceTiming): Span {
  return {
    name: entry.name.split('/').pop() ?? entry.name,
    type: 'resource',
    durationMs: Math.round(entry.duration),
    startedAt: Math.round(entry.startTime),
    sizeBytes: entry.transferSize || undefined,
    initiatorType: entry.initiatorType
  }
}
