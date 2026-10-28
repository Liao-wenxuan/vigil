/**
 * 会话回放与用户行为 —— 独立入口。
 *
 * 为什么要单独一个入口：rrweb 压缩后 260KB（gzip 约 80KB），
 * 塞进 SDK 核心会膨胀 6 倍，而绝大多数用户不需要回放。
 *
 * 用法：
 * ```ts
 * import { init } from '@vigil/sdk'
 * import { replayPlugin, behaviorPlugin } from '@vigil/sdk/replay'
 *
 * init({
 *   endpoint, appId, token, release,
 *   plugins: [replayPlugin(), behaviorPlugin()]
 * })
 * ```
 */
export { replayPlugin, behaviorPlugin } from './replay/plugin.js'
export { ReplayRecorder, maskSensitiveText, type ReplayOptions } from './replay/recorder.js'
export { BehaviorCollector, type BehaviorOptions } from './replay/behavior.js'
export type {
  BehaviorEnvelope,
  BehaviorEvent,
  BehaviorSummary,
  BehaviorType,
  ReplayEvent,
  ReplayPayload,
  SessionSummary
} from '@vigil/protocol'
