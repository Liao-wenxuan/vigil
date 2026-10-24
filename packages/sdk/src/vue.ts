import { describeThrown, parseStack } from './parse-stack'
import type { Reporter, Teardown } from './reporter'

/**
 * Vue 适配器。
 *
 * 单独成一个入口（`@vigil/sdk/vue`），原因有两个：
 *   1. **不把 Vue 变成 SDK 的依赖** —— SDK 核心包保持框架无关，
 *      React / Svelte / 原生项目都能用。
 *   2. Vue 项目通常会用 `app.config.errorHandler` 统一兜底，
 *      Vue 自己会捕获组件渲染错误并调用它 —— 走这条通道能拿到
 *      **组件名和错误来源信息**（`info` 参数），比全局 error 事件丰富得多。
 *
 * 用法：
 * ```ts
 * import { createApp } from 'vue'
 * import { init } from '@vigil/sdk'
 * import { installVueErrorHandler } from '@vigil/sdk/vue'
 *
 * const app = createApp(App)
 * installVueErrorHandler(app, (error) => vigil.captureException(error))
 * ```
 *
 * 或者让 SDK 自己接管（更简单）：
 * ```ts
 * const client = init({ ... })
 * installVueErrorHandler(app, client.report)
 * ```
 */

/** Vue 应用实例的最小结构 —— 不 import Vue，避免把它变成依赖 */
export interface VueLikeApp {
  config: {
    errorHandler?: (err: unknown, instance: unknown, info: string) => void
  }
}

/**
 * 安装 Vue 错误处理器。
 *
 * 会**保留**原有的 errorHandler 并在之后调用 —— 直接覆盖会静默吃掉
 * 用户自己写的错误上报逻辑（比如 Sentry 或他们自己的埋点）。
 */
export function installVueErrorHandler(app: VueLikeApp, report: Reporter): Teardown {
  const previous = app.config.errorHandler

  app.config.errorHandler = (err: unknown, instance: unknown, info: string) => {
    const described = describeThrown(err)

    try {
      report({
        category: 'javascript',
        kind: 'vue',
        name: described.name ?? 'VueError',
        message: described.message,
        stack: described.stack,
        frames: parseStack(described.stack),
        context: {
          vueInfo: info,
          componentName: inferComponentName(instance)
        }
      })
    } catch {
      // 上报失败不能影响 Vue 的错误处理
    }

    // 保留原有处理器
    previous?.(err, instance, info)
  }

  return () => {
    app.config.errorHandler = previous
  }
}

/**
 * 从组件实例推断组件名。
 *
 * Vue 3 里组件实例上通常有 `$options.name` 或 `type.name`，
 * 拿不到就返回 undefined —— 拿不到名字不该让整条错误丢掉。
 */
export function inferComponentName(instance: unknown): string | undefined {
  if (!instance || typeof instance !== 'object') return undefined

  const candidate = instance as {
    $options?: { name?: string }
    type?: { name?: string }
  }

  return candidate.$options?.name ?? candidate.type?.name
}
