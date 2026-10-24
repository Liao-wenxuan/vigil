import { isBrowser } from '../context'
import { describeThrown, parseStack } from '../parse-stack'
import type { Reporter, Teardown } from '../reporter'

/**
 * 未处理的 Promise 拒绝。
 *
 * `unhandledrejection` 和 `window.onerror` 是**两套独立机制**：
 * `async function` 里抛出的异常走的是 Promise 通道，
 * 如果只监听 error 事件，这类错误一条都收不到 ——
 * 而它恰恰是前端最常见的一类错误。
 *
 * 注意：`promise.catch()` 里处理掉的拒绝**不会**触发这个事件，
 * 这是设计如此 —— 已经处理过的错误不该进监控。
 */
export function installUnhandledRejectionHandler(reporter: Reporter): Teardown {
  if (!isBrowser()) return () => {}

  const handler = (event: Event) => {
    const rejectionEvent = event as PromiseRejectionEvent
    const described = describeThrown(rejectionEvent.reason)

    reporter({
      category: 'javascript',
      kind: 'promise',
      name: described.name ?? 'UnhandledRejection',
      message: described.message,
      stack: described.stack,
      frames: parseStack(described.stack)
    })
  }

  window.addEventListener('unhandledrejection', handler)

  return () => window.removeEventListener('unhandledrejection', handler)
}
