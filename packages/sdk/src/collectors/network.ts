import { isBrowser } from '../context'
import { maskUrl } from '../mask'
import { pathOf } from '../fingerprint'
import type { Reporter, Teardown } from '../reporter'

/**
 * 接口错误采集：劫持 fetch 和 XMLHttpRequest。
 *
 * ## 为什么只报 5xx（默认）
 *
 * 前端接口的 4xx 大多是**业务语义**，不是故障：
 *   400 余额不足、409 订单状态已变化、401 登录过期
 * 这些是正常的业务分支，报进监控系统只会淹没真正的错误。
 * 默认策略只把 **5xx** 和**网络失败**当成错误，其余降级成面包屑。
 *
 * ## 防止自我递归
 *
 * SDK 自己上报数据也是一次 fetch。如果不排除采集端点，
 * 上报 → 触发拦截 → 再上报 → 无限循环，页面会被自己的 SDK 打死。
 * 所以 `isCollectorUrl` 是必须的，不是优化。
 */

/** 哪些 HTTP 状态算错误 */
export type HttpErrorPolicy = '5xx' | '4xx' | 'all' | 'none'

export function shouldReportStatus(status: number, policy: HttpErrorPolicy): boolean {
  switch (policy) {
    case 'none':
      return false
    case 'all':
      return status === 0 || status >= 400
    case '4xx':
      return status === 0 || (status >= 400 && status < 500)
    case '5xx':
    default:
      return status === 0 || status >= 500
  }
}

/**
 * 原始 fetch。
 *
 * ⚠️ 必须在**模块求值时**抓住 —— 一旦 `installNetworkCapture` 给
 * `globalThis.fetch` 打了补丁，之后再取到的就是打过补丁的版本，
 * 采集器调用它会无限递归。
 *
 * 模块求值发生在 import 时刻，而补丁在 init() 时才打 —— 顺序天然正确。
 */
const rawFetch: typeof fetch | undefined =
  typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined

/** 绑定过的原始 fetch，脱离 `this` 调用在浏览器里会报 Illegal invocation */
export const nativeFetch: typeof fetch | undefined = rawFetch
  ? (rawFetch.bind(globalThis) as typeof fetch)
  : undefined

/** 高精度计时 */
function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/** 把 fetch 的第一个参数统一成字符串 */
function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString()
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return String(input)
}

/** 取请求方法 */
function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase()
  }
  return 'GET'
}

/**
 * 判断某个 URL 是不是采集端点自己。
 *
 * 只比 origin + pathname：采集端点带 query 时（比如带 appId）也能匹配上。
 */
export function isCollectorUrl(url: string, endpoint: string): boolean {
  if (!endpoint) return false
  try {
    const target = new URL(endpoint)
    const candidate = new URL(url, target.origin)
    return candidate.origin === target.origin && candidate.pathname === target.pathname
  } catch {
    return url.startsWith(endpoint)
  }
}

export interface NetworkCaptureOptions {
  /** 采集端点地址 —— 上报请求本身必须排除 */
  endpoint: string
  /** 哪些状态码算错误 */
  policy?: HttpErrorPolicy
}

/** XHR 的附加信息，用 WeakMap 存 —— 不往 DOM 对象上挂自定义属性 */
interface XhrMeta {
  method: string
  url: string
  start: number
}

const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>()

export function installNetworkCapture(
  reporter: Reporter,
  options: NetworkCaptureOptions
): Teardown {
  if (!isBrowser()) return () => {}

  const policy = options.policy ?? '5xx'
  const teardowns: Array<() => void> = []

  // ---- fetch ----
  if (rawFetch && nativeFetch) {
    const originalFetch = globalThis.fetch

    const patchedFetch: typeof fetch = async (input, init) => {
      const url = toUrlString(input)
      // 上报请求本身：原样放行，绝不能再监控
      if (isCollectorUrl(url, options.endpoint)) {
        return originalFetch(input, init)
      }

      const method = resolveMethod(input, init)
      const start = now()

      try {
        const response = await nativeFetch(input, init)
        const duration = now() - start
        if (shouldReportStatus(response.status, policy)) {
          reporter({
            category: 'http',
            kind: 'http',
            name: 'HttpError',
            message: `HTTP ${response.status} ${method} ${pathOf(url)}`,
            http: {
              method,
              url: maskUrl(url),
              status: response.status,
              durationMs: Math.round(duration)
            }
          })
        }
        return response
      } catch (error) {
        const duration = now() - start
        reporter({
          category: 'http',
          kind: 'http',
          name: 'NetworkError',
          message: `Network request failed: ${method} ${pathOf(url)}`,
          http: {
            method,
            url: maskUrl(url),
            status: 0,
            durationMs: Math.round(duration)
          }
        })
        throw error
      }
    }

    globalThis.fetch = patchedFetch
    teardowns.push(() => {
      globalThis.fetch = originalFetch
    })
  }

  // ---- XMLHttpRequest ----
  if (typeof XMLHttpRequest !== 'undefined') {
    const proto = XMLHttpRequest.prototype
    const originalOpen = proto.open
    const originalSend = proto.send

    proto.open = function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ) {
      xhrMeta.set(this, {
        method: String(method).toUpperCase(),
        url: toUrlString(url),
        start: 0
      })
      // DOM 类型的 open() 把 async 标成必填，但运行时省略时默认是 true。
      // 这里显式补上，避免传 undefined 改变行为。
      return originalOpen.call(this, method, url, async ?? true, username, password)
    }

    proto.send = function patchedSend(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      const meta = xhrMeta.get(this)
      if (meta) {
        meta.start = now()
        this.addEventListener('loadend', () => {
          const duration = now() - meta.start
          if (!shouldReportStatus(this.status, policy)) return

          const status = this.status
          reporter({
            category: 'http',
            kind: 'http',
            name: status === 0 ? 'NetworkError' : 'HttpError',
            message:
              status === 0
                ? `Network request failed: ${meta.method} ${pathOf(meta.url)}`
                : `HTTP ${status} ${meta.method} ${pathOf(meta.url)}`,
            http: {
              method: meta.method,
              url: maskUrl(meta.url),
              status,
              durationMs: Math.round(duration)
            }
          })
        })
      }
      return originalSend.call(this, body as XMLHttpRequestBodyInit | null | undefined)
    }

    teardowns.push(() => {
      proto.open = originalOpen
      proto.send = originalSend
    })
  }

  return () => {
    for (const teardown of teardowns) {
      try {
        teardown()
      } catch {
        // 忽略卸载异常
      }
    }
  }
}
