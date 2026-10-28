import type { VigilPlugin, VigilPluginHost } from '../plugin.js'
import { SDK_NAME, SDK_VERSION } from '../version.js'
import { BehaviorCollector, type BehaviorOptions } from './behavior.js'
import { ReplayRecorder, type ReplayOptions } from './recorder.js'

/**
 * 会话回放插件。
 *
 * 回放事件流挂在**错误事件**上一起上报 ——
 * 不是持续上传整段会话。
 *
 * ## 为什么不持续上传
 *
 * 一次会话的 rrweb 事件流轻松到几百 KB。持续上传的话：
 *   - 带宽被监控吃掉
 *   - 服务端要存大量没人看的回放
 *   - 而**没出错的会话，回放基本没人看**
 *
 * 真正有价值的是「出错那一刻，用户之前在干什么」。
 * 所以：本地缓冲，出错时随错误一起带上去。
 */

/**
 * 创建回放插件。
 *
 * @example
 * ```ts
 * import { init } from '@vigil/sdk'
 * import { replayPlugin } from '@vigil/sdk/replay'
 *
 * init({
 *   endpoint, appId, token,
 *   plugins: [replayPlugin({ maxBytes: 64 * 1024 })]
 * })
 * ```
 */
export function replayPlugin(options: ReplayOptions = {}): VigilPlugin {
  let recorder: ReplayRecorder | null = null

  return {
    name: 'replay',

    setup() {
      recorder = new ReplayRecorder(options)
      recorder.start()
    },

    enrich(event) {
      if (!recorder) return
      const payload = recorder.peek()
      if (payload) event.replay = payload
    },

    teardown() {
      recorder?.stop()
      recorder = null
    }
  }
}

/**
 * 创建用户行为插件。
 *
 * 采集 PV / 路由切换 / 点击，走**独立通道** `/api/v1/behavior` ——
 * 行为数据量大且绝大多数正常，不能和错误混在一起上报。
 */
export function behaviorPlugin(options: BehaviorOptions = {}): VigilPlugin {
  let collector: BehaviorCollector | null = null
  let host: VigilPluginHost | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const flush = (): void => {
    if (!collector || !host) return
    const { events, session } = collector.take()
    if (events.length === 0) return

    // 用户 ID 由宿主提供（登录后才拿得到），在这里补到每条事件上
    for (const event of events) {
      if (!event.userId && host.userId) event.userId = host.userId
    }
    if (!session.userId && host.userId) session.userId = host.userId

    host.post('/api/v1/behavior', {
      appId: host.options.appId,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      events,
      session
    })
  }

  return {
    name: 'behavior',

    setup(pluginHost) {
      host = pluginHost
      collector = new BehaviorCollector(options)
      collector.start()

      const interval = options.flushIntervalMs ?? 10000
      timer = setInterval(flush, interval)
    },

    teardown() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      // 页面要走了 —— 最后一批必须发出去
      flush()
      collector?.stop()
      collector = null
      host = null
    }
  }
}
