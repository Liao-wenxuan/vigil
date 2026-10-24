import type { ResourceInfo, StackFrame } from '@vigil/protocol'
import { isBrowser } from '../context'
import { maskUrl } from '../mask'
import { describeThrown, parseStack } from '../parse-stack'
import type { Reporter, Teardown } from '../reporter'

/**
 * 全局错误监听。
 *
 * 一个 `error` 事件其实承载了**两类**完全不同的东西，靠 `event.target` 区分：
 *
 *   window.addEventListener('error', handler, true)   ← 必须用捕获阶段
 *     ├─ event.target 是元素  → 资源加载失败（img/script/link 404 或 500）
 *     └─ event.target 是 window → JS 运行时异常
 *
 * 为什么必须用捕获阶段（`true`）：资源加载失败**不冒泡**。
 * 用冒泡阶段监听的话，`<img src="404.png">` 根本不会触发 handler，
 * 资源类错误一条都收不到 —— 这是新手写监控 SDK 最常踩的坑。
 */

/** 资源标签 → 资源类型 */
function resourceTypeOf(element: Element): string {
  const tag = element.tagName.toUpperCase()
  const withRel = element as Element & { rel?: string }

  if (tag === 'LINK') {
    const rel = (withRel.rel ?? '').toLowerCase()
    if (rel.includes('stylesheet')) return 'stylesheet'
    if (rel.includes('icon')) return 'image'
    if (rel.includes('preload') || rel.includes('prefetch')) return 'preload'
    return 'other'
  }

  switch (tag) {
    case 'SCRIPT':
      return 'script'
    case 'IMG':
      return 'image'
    case 'AUDIO':
    case 'VIDEO':
    case 'SOURCE':
      return 'media'
    case 'TRACK':
      return 'track'
    case 'IFRAME':
      return 'document'
    case 'OBJECT':
    case 'EMBED':
      return 'object'
    default:
      return 'other'
  }
}

/** 取资源的真实地址 */
function resourceSrcOf(element: Element): string {
  const withSrc = element as Element & { currentSrc?: string; src?: string; href?: string }
  return withSrc.currentSrc || withSrc.src || withSrc.href || ''
}

/** 判断 event.target 是不是一个元素（资源错误的标志） */
function isElementTarget(target: EventTarget | null): target is Element {
  if (!target || target === window) return false
  const tag = (target as Element).tagName
  return typeof tag === 'string' && tag.length > 0
}

export function installGlobalErrorHandler(reporter: Reporter): Teardown {
  if (!isBrowser()) return () => {}

  const handler = (event: Event) => {
    // ---- 资源加载失败 ----
    if (isElementTarget(event.target)) {
      const element = event.target
      const src = resourceSrcOf(element)
      if (!src) return

      const tag = element.tagName.toLowerCase()
      const masked = maskUrl(src)
      const resource: ResourceInfo = {
        tag,
        src: masked,
        type: resourceTypeOf(element)
      }

      reporter({
        category: 'resource',
        kind: 'resource',
        name: 'ResourceLoadError',
        message: `Failed to load ${tag}: ${masked}`,
        resource
      })
      return
    }

    // ---- JS 运行时异常 ----
    const domEvent = event as ErrorEvent
    const described = describeThrown(domEvent.error ?? domEvent.message)

    const frames: StackFrame[] = parseStack(described.stack)
    // 有些环境拿不到 error 对象，只有 filename/lineno/colno
    if (frames.length === 0 && domEvent.filename) {
      frames.push({
        filename: domEvent.filename,
        lineno: domEvent.lineno ?? undefined,
        colno: domEvent.colno ?? undefined
      })
    }

    reporter({
      category: 'javascript',
      kind: 'js',
      name: described.name ?? 'Error',
      message: described.message,
      stack: described.stack,
      frames
    })
  }

  // 捕获阶段 —— 资源错误不冒泡
  window.addEventListener('error', handler, true)

  return () => window.removeEventListener('error', handler, true)
}
