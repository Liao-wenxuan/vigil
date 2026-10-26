/**
 * Vigil 上报协议（wire format）
 *
 * 这个包**只有类型，没有运行时值**。SDK 和 Collector 都从这里 import type，
 * 编译后完全擦除 —— 所以：
 *   - 不会给 SDK 增加任何产物体积
 *   - 不会引入构建顺序依赖（protocol 不需要 build）
 *   - 但两边对「一条错误长什么样」的理解永远一致
 *
 * ⚠️ 改动这里 = 改动线上协议。Collector 侧必须同步改解析逻辑，
 *    否则老 SDK 上报的数据会解析失败。
 *
 * 按域拆成多个文件：一个 index.ts 装不下企业级的契约了。
 */

export * from './common.js'
export * from './error.js'
export * from './performance.js'
export * from './issue.js'
export * from './tenancy.js'
