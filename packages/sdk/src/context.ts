import type { ConnectionInfo, Viewport } from '@vigil/protocol'

/**
 * 运行环境上下文采集。
 *
 * 这些字段的作用是回答「**谁**遇到了这个错误」：
 * 只有一条「Cannot read properties of undefined」而没有浏览器/系统/网络信息，
 * 排查时还得自己去猜用户环境。
 *
 * 全部做了防御性读取 —— 采集代码自己抛异常是最糟的故障模式，
 * 它会让真正的错误彻底消失。
 */

/** 是否跑在浏览器里（SSR / Node 测试环境下要返回 false） */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export interface BrowserContext {
  userAgent: string
  locale?: string
  timezone?: string
  viewport?: Viewport
  screen?: Viewport
  connection?: ConnectionInfo
  sessionId: string
}

/** 网络连接信息（Navigator.connection 不在标准 DOM 类型里） */
function readConnection(): ConnectionInfo | undefined {
  if (!isBrowser()) return undefined
  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string
      downlink?: number
      rtt?: number
      type?: string
    }
  }
  const connection = nav.connection
  if (!connection) return undefined
  return {
    effectiveType: connection.effectiveType,
    downlink: connection.downlink,
    rtt: connection.rtt,
    type: connection.type
  }
}

/** 时区：用 Intl 解析，拿不到就留空 —— 不要用 UTC 顶替，那是错的信息 */
function readTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

function readViewport(): Viewport | undefined {
  if (!isBrowser()) return undefined
  const width = window.innerWidth
  const height = window.innerHeight
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  return { width, height }
}

function readScreen(): Viewport | undefined {
  if (!isBrowser()) return undefined
  if (typeof screen === 'undefined') return undefined
  const width = screen.width
  const height = screen.height
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  return { width, height }
}

const SESSION_ID_KEY = 'vigil.session.id'

/** 内存兜底：sessionStorage 不可用（隐私模式 / 被禁用）时用这个 */
let memorySessionId: string | undefined

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // 非安全上下文下 randomUUID 不可用，往下走
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * 会话 ID。
 *
 * 语义：**同一个标签页内**跨路由跳转保持不变，换标签页就换。
 * 用 sessionStorage 而不是 localStorage —— 后者会跨标签页共享，
 * 两个标签页会被算成一次会话，「会话数」这个指标就废了。
 */
export function getSessionId(): string {
  if (!isBrowser()) return randomId()

  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY)
    if (existing) return existing
    const created = randomId()
    sessionStorage.setItem(SESSION_ID_KEY, created)
    return created
  } catch {
    // sessionStorage 抛异常 = 隐私模式或被禁用
    if (!memorySessionId) memorySessionId = randomId()
    return memorySessionId
  }
}

/** 采集一次性环境上下文 */
export function collectContext(): BrowserContext {
  if (!isBrowser()) {
    return { userAgent: 'node', sessionId: randomId() }
  }

  return {
    userAgent: navigator.userAgent,
    locale: navigator.language,
    timezone: readTimezone(),
    viewport: readViewport(),
    screen: readScreen(),
    connection: readConnection(),
    sessionId: getSessionId()
  }
}

/**
 * 探测 SDK 自己被加载的脚本地址。
 *
 * 用途：把 SDK 内部帧从错误指纹里剔除。
 * 实际上原始异常的 stack 是在**用户代码里**构造的，本来就不含 SDK 帧，
 * 这一层是防御性的 —— 但 SDK 自己抛错时栈里就会有它的帧。
 *
 * 用 `document.currentScript` + 扫描 script[src] 两条路：
 * 前者对传统 `<script>` 有效，ES module 下 currentScript 为 null，走后者。
 */
export function detectSelfUrls(): string[] {
  if (!isBrowser()) return []
  const urls: string[] = []

  const current = document.currentScript as HTMLScriptElement | null
  if (current?.src) urls.push(current.src)

  const scripts = Array.from(document.querySelectorAll('script[src]'))
  for (const script of scripts) {
    const src = (script as HTMLScriptElement).src
    if (src && /vigil/i.test(src)) urls.push(src)
  }

  return urls
}
