import type { Breadcrumb } from '@vigil/protocol'
import { isBrowser } from '../context'
import { maskUrl, scrubText, truncate } from '../mask'

/**
 * 面包屑（breadcrumb）：出错之前用户干了什么。
 *
 * 一条孤立的「Cannot read undefined」几乎无法定位；
 * 加上「点了『提交订单』→『请求 /api/orders 返回 500』→『抛错』」，
 * 立刻能看出是谁触发的。
 *
 * 这不是「用户行为分析」—— 那是另一回事。面包屑是**调试上下文**，
 * 只保留最近 N 条，且必须和错误一起上报才有意义。
 */
export class BreadcrumbRecorder {
  private items: Breadcrumb[] = []

  constructor(private readonly max: number = 30) {}

  /** 记录一条面包屑 */
  add(crumb: Omit<Breadcrumb, 'timestamp'>): void {
    const entry: Breadcrumb = {
      type: crumb.type,
      category: crumb.category,
      timestamp: Date.now()
    }
    if (crumb.message !== undefined) entry.message = truncate(scrubText(crumb.message), 200)
    if (crumb.data !== undefined) entry.data = crumb.data

    this.items.push(entry)
    // 超过上限就丢最老的
    if (this.items.length > this.max) {
      this.items.splice(0, this.items.length - this.max)
    }
  }

  /** 取出当前全部面包屑 */
  list(): Breadcrumb[] {
    return this.items.slice()
  }

  /** 清空 */
  clear(): void {
    this.items = []
  }
}

export interface BreadcrumbOptions {
  recorder: BreadcrumbRecorder
  /** 采集控制台输出（console.error / console.warn） */
  captureConsole?: boolean
}

/**
 * 安装 DOM 层面的面包屑采集。
 *
 * 采集三类：路由跳转、点击、控制台输出。
 * 不采集输入内容 —— 键盘事件里的东西太敏感了，不值得为它承担隐私风险。
 */
export function installBreadcrumbs(options: BreadcrumbOptions): () => void {
  if (!isBrowser()) return () => {}

  const { recorder } = options
  const teardowns: Array<() => void> = []

  // ---- 路由跳转 ----
  // pushState / replaceState 不会触发 popstate，必须单独打补丁
  const history = window.history
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState

  history.pushState = function patchedPushState(...args: Parameters<History['pushState']>) {
    recorder.add({
      type: 'navigation',
      category: 'history',
      message: `pushState ${String(args[2] ?? '')}`
    })
    return originalPushState.apply(this, args)
  }

  history.replaceState = function patchedReplaceState(
    ...args: Parameters<History['replaceState']>
  ) {
    recorder.add({
      type: 'navigation',
      category: 'history',
      message: `replaceState ${String(args[2] ?? '')}`
    })
    return originalReplaceState.apply(this, args)
  }

  teardowns.push(() => {
    history.pushState = originalPushState
    history.replaceState = originalReplaceState
  })

  const onPopState = () => {
    recorder.add({ type: 'navigation', category: 'history', message: 'popstate' })
  }
  window.addEventListener('popstate', onPopState)
  teardowns.push(() => window.removeEventListener('popstate', onPopState))

  // ---- 点击 ----
  const onClick = (event: Event) => {
    const target = event.target as (Element & { tagName?: string }) | null
    if (!target || typeof target.tagName !== 'string') return

    const text = truncate((target.textContent ?? '').trim(), 60)
    recorder.add({
      type: 'click',
      category: target.tagName.toLowerCase(),
      message: text ? `${target.tagName.toLowerCase()} "${text}"` : target.tagName.toLowerCase()
    })
  }
  // 用捕获阶段：冒泡阶段可能被业务代码 stopPropagation 截断
  document.addEventListener('click', onClick, true)
  teardowns.push(() => document.removeEventListener('click', onClick, true))

  // ---- 控制台 ----
  if (options.captureConsole !== false) {
    const originalError = console.error
    const originalWarn = console.warn

    console.error = (...args: unknown[]) => {
      recorder.add({
        type: 'console',
        category: 'console.error',
        message: args.map((arg) => String(arg)).join(' ')
      })
      originalError.apply(console, args)
    }

    console.warn = (...args: unknown[]) => {
      recorder.add({
        type: 'console',
        category: 'console.warn',
        message: args.map((arg) => String(arg)).join(' ')
      })
      originalWarn.apply(console, args)
    }

    teardowns.push(() => {
      console.error = originalError
      console.warn = originalWarn
    })
  }

  // 记录起始页面
  recorder.add({
    type: 'navigation',
    category: 'document',
    message: maskUrl(window.location.href)
  })

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
