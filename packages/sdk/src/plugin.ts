import type { ErrorEvent } from '@vigil/protocol'
import type { VigilOptions } from './options'

/**
 * 插件系统。
 *
 * ## 为什么要插件而不是直接塞进核心
 *
 * 会话回放依赖 rrweb，压缩后 260KB（gzip 约 80KB）。
 * 塞进核心的话，SDK 核心会从 13KB 膨胀到 90KB+ ——
 * 而**绝大多数用户根本不需要回放**（尤其是涉及隐私合规的团队）。
 *
 * 插件化之后：
 *   - 核心产物 `dist/index.js` 不含任何回放代码
 *   - 回放是独立入口 `dist/replay.js`，用户按需引入
 *   - 新增能力（行为分析、APM trace、框架集成）都走同一个口子
 *
 * Sentry / Datadog / Bugsnag 都是这个模式，不是巧合。
 */
export interface VigilPluginHost {
  /** 初始化时的配置 */
  readonly options: Readonly<VigilOptions>
  /** 会话 ID（标签页级） */
  readonly sessionId: string
  /** 当前用户 ID */
  readonly userId: string | undefined
  /**
   * POST 到采集服务的某个通道。
   *
   * `path` 是**相对 API 根**的路径，例如 `/behavior`。
   * API 根由 `endpoint` 推导：`.../api/v1/collect` 的根是 `.../api/v1`。
   *
   * 鉴权头自动带上，所以插件不用关心 token 放哪。
   *
   * ⚠️ 别把路径写成完整地址再让宿主拼 —— 那样会得到
   * `.../api/v1/collect/api/v1/behavior`，404 且不报错。
   */
  post(path: string, body: unknown): void
  /** 附加到每一条错误事件上的上下文 */
  addContext(context: Record<string, unknown>): void
}

export interface VigilPlugin {
  /** 插件名，用于报错时定位 */
  readonly name: string
  /** 安装 */
  setup(host: VigilPluginHost): void
  /**
   * 错误事件入队**之前**调用。
   *
   * 用来往事件上挂额外数据（比如回放事件流）。
   */
  enrich?(event: ErrorEvent): void
  /** 页面卸载等收尾时机 */
  teardown?(): void
}

/** 插件异常不能影响业务，也不能影响其它插件 */
export function runPluginEnrich(plugins: VigilPlugin[], event: ErrorEvent): void {
  for (const plugin of plugins) {
    if (!plugin.enrich) continue
    try {
      plugin.enrich(event)
    } catch (error) {
      console.warn(`[vigil] 插件 ${plugin.name} 增强事件失败:`, error)
    }
  }
}

/** 安装插件，失败的不阻断后面的 */
export function setupPlugins(plugins: VigilPlugin[], host: VigilPluginHost): VigilPlugin[] {
  const installed: VigilPlugin[] = []

  for (const plugin of plugins) {
    try {
      plugin.setup(host)
      installed.push(plugin)
    } catch (error) {
      console.warn(`[vigil] 插件 ${plugin.name} 安装失败:`, error)
    }
  }

  return installed
}
