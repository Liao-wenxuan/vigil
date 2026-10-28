import { record } from 'rrweb'
import type { ReplayEvent, ReplayPayload } from '@vigil/protocol'

/**
 * rrweb 事件的最小结构。
 *
 * 不直接用 rrweb 导出的 `eventWithTime` 联合类型 ——
 * 那个类型有几���百个成员，每次 rrweb 升级都可能变。
 * 我们只用到 type / data / timestamp 三个字段，自己声明更稳。
 */
interface RrwebEvent {
  type: number
  data: unknown
  timestamp: number
}

/**
 * 会话回放录制器。
 *
 * ## 为什么回放是独立入口而不是核心的一部分
 *
 * rrweb 压缩后 260KB（gzip 约 80KB），而 SDK 核心只有 13KB。
 * 塞进核心会膨胀 6 倍，而且**绝大多数用户不需要回放**。
 * 所以回放是独立入口 `dist/replay.js`，核心完全不知道它的存在。
 *
 * ## 事件流必须连续
 *
 * rrweb 的回放数据是「一个全量快照 + 一串增量」。
 * 中间丢掉任何一段，后面的增量就**全部对不上**，回放直接废掉。
 *
 * 所以缓冲区满了**不能丢中间的**，只能重新取一次全量快照：
 *   丢掉旧段 → 重新 record() → 新快照从当前 DOM 开始
 * 代价是丢失了更早的历史，但保证回放**始终可播**。
 */
export interface ReplayOptions {
  /** 会话采样率（0~1），默认 1 */
  sampleRate?: number
  /** 缓冲预算（字节）。超出就重新取快照 */
  maxBytes?: number
  /** 完全不录制的元素 class（默认 `vigil-block`） */
  blockClass?: string
  /** 完全不录制的元素选择器 */
  blockSelector?: string
  /** 文本遮罩选择器：命中的元素文本会被替换成 ● */
  maskTextSelector?: string
  /** 是否遮罩所有文本（最保守） */
  maskAllText?: boolean
  /** 是否录制画布内容（默认不录 —— 体积大且常含敏感信息） */
  recordCanvas?: boolean
}

/** 默认预算：64KB 足够覆盖出错前几十秒的操作，又不会撑爆上报体 */
const DEFAULT_MAX_BYTES = 64 * 1024

/** rrweb 的全量快照事件类型 */
const FULL_SNAPSHOT_TYPE = 0

export class ReplayRecorder {
  private readonly options: ReplayOptions
  private readonly sampled: boolean

  private buffer: ReplayEvent[] = []
  private bytes = 0
  private droppedSegments = 0
  private stopRecording: (() => void) | undefined = undefined
  private started = false

  constructor(options: ReplayOptions = {}) {
    this.options = options
    this.sampled = Math.random() < (options.sampleRate ?? 1)
  }

  /** 这个会话是否被采样到 */
  get isSampled(): boolean {
    return this.sampled
  }

  /** 已经开始录制 */
  get isRecording(): boolean {
    return this.started
  }

  /** 因为超预算被丢弃的段数 */
  get dropped(): number {
    return this.droppedSegments
  }

  start(): void {
    if (this.started || !this.sampled) return
    if (typeof window === 'undefined') return

    this.started = true
    this.startRecording()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.stopRecording?.()
    this.stopRecording = undefined
  }

  /**
   * 取当前缓冲（**不清空**）。
   *
   * 不清空是有意的：一次会话里可能出多个错误，每个错误都应该带上
   * 「出错前用户在干什么」的上下文。存储成本由服务端按会话去重解决。
   */
  peek(): ReplayPayload | undefined {
    if (this.buffer.length === 0) return undefined
    return {
      events: this.buffer.slice(),
      droppedSegments: this.droppedSegments,
      bytes: this.bytes
    }
  }

  /** 清空缓冲（会话结束或手动重置） */
  reset(): void {
    this.buffer = []
    this.bytes = 0
  }

  // ==========================================================
  // 内部
  // ==========================================================

  private startRecording(): void {
    try {
      this.stopRecording = record<RrwebEvent>({
        emit: (payload: RrwebEvent, isCheckout?: boolean) => {
          this.onEvent(payload, isCheckout === true)
        },

        // ---- 隐私：默认必须是安全的 ----
        // 所有输入框的值都遮罩。密码、邮箱、电话、搜索词……
        // 一个都不落。用户填的东西不上报，这是底线。
        maskAllInputs: true,
        maskInputOptions: {
          password: true,
          text: true,
          email: true,
          tel: true,
          number: true,
          search: true,
          url: true,
          date: true,
          time: true
        },
        // 命中的元素整块不录
        blockClass: this.options.blockClass ?? 'vigil-block',
        blockSelector: this.options.blockSelector ?? '',
        // 文本遮罩
        maskTextSelector: this.options.maskTextSelector ?? '',
        maskTextFn: this.options.maskAllText ? () => '●' : maskSensitiveText,

        // ---- 体积控制 ----
        // 采样鼠标移动与输入：这两类事件量最大，但排查价值最低
        // （sampling.input 只接受 'all' | 'last'，dblclick 在 mouseInteraction 里）
        sampling: {
          mousemove: true,
          mouseInteraction: { dblclick: true },
          scroll: 150,
          media: 800,
          input: 'last'
        },
        // 画布默认不录：体积大，且常含用户绘制的内容
        recordCanvas: this.options.recordCanvas ?? false,
        // 字体信息用不上，采集它只是白费体积
        collectFonts: false,
        // 定期全量快照，减小增量事件链的长度
        checkoutEveryNms: 30_000
      })
    } catch (error) {
      // rrweb 初始化失败不能影响业务
      console.warn('[vigil] 会话回放启动失败:', error)
      this.started = false
    }
  }

  private onEvent(payload: RrwebEvent, isCheckout: boolean): void {
    const event: ReplayEvent = {
      type: payload.type,
      data: payload.data,
      timestamp: payload.timestamp
    }

    const size = estimateSize(event)

    // 全量快照 → 缓冲区重置（增量链必须从快照开始）
    if (event.type === FULL_SNAPSHOT_TYPE) {
      this.buffer = [event]
      this.bytes = size
      return
    }

    // 超预算 → 重新取快照，保证回放始终可播
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES
    if (this.bytes + size > maxBytes) {
      this.droppedSegments++
      this.reset()
      this.restart()
      return
    }

    this.buffer.push(event)
    this.bytes += size

    // isCheckout 表示 rrweb 自己触发的定期全量快照
    void isCheckout
  }

  /** 重新录制（取新的全量快照） */
  private restart(): void {
    this.stopRecording?.()
    this.stopRecording = undefined
    this.buffer = []
    this.bytes = 0
    if (this.started) this.startRecording()
  }
}

/**
 * 估算事件大小。
 *
 * 用 JSON.stringify 是最准的，但全量快照可能有几十 KB ——
 * 那个开销只在快照时出现一次，可以接受。
 */
function estimateSize(event: ReplayEvent): number {
  try {
    return JSON.stringify(event).length
  } catch {
    return 1024
  }
}

/**
 * 文本脱敏。
 *
 * rrweb 默认**不遮罩文本**（否则回放看不出用户在干什么），
 * 但页面上的文字可能含手机号、邮箱、身份证号。
 * 这里做一层正则脱敏：命中就替换成 ●。
 *
 * 这不是完整的 PII 防护（页面上写出来的身份证号也可能格式不标准），
 * 但能挡住最常见的几种。需要更严格的场景请用 `maskAllText: true`。
 */
export function maskSensitiveText(text: string): string {
  if (!text) return text

  return (
    text
      // 邮箱
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '●')
      // 中国大陆手机号
      .replace(/\b1[3-9]\d{9}\b/g, '●')
      // 身份证号（15 位或 18 位）
      .replace(/\b\d{17}[\dXx]\b/g, '●')
      .replace(/\b\d{15}\b/g, '●')
      // 银行卡号（16~19 位）
      .replace(/\b\d{16,19}\b/g, '●')
  )
}
