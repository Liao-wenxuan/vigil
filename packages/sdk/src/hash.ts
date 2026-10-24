/**
 * 同步字符串哈希。
 *
 * 为什么不用 SubtleCrypto：`crypto.subtle.digest` 是**异步**的，
 * 而指纹必须在 `window.onerror` 这个同步回调里当场算出来。
 * 异步拿指纹意味着这条错误会带着空指纹进队列，聚合就废了。
 *
 * 为什么不直接用现成包：为了两个 32 位哈希引入一个依赖不划算，
 * 而且浏览器端 bundle 每 1KB 都是成本。
 *
 * 用两个不同底数的哈希拼接（16 个十六进制字符）而不是单个 FNV-1a，
 * 是为了把碰撞概率再降一个数量级 —— 指纹是聚合主键，撞了会把两个
 * 不相关的错误并成一条，排查时会非常误导。
 */

/** FNV-1a 32 位 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** djb2 32 位 */
function djb2(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 33) + input.charCodeAt(i)) >>> 0
  }
  return h >>> 0
}

/**
 * 把任意字符串压成 16 位十六进制的稳定哈希。
 *
 * 同样的输入永远得到同样的输出 —— 这是指纹能跨会话、跨 release 聚合的前提。
 */
export function hashString(input: string): string {
  const a = fnv1a(input).toString(16).padStart(8, '0')
  const b = djb2(input).toString(16).padStart(8, '0')
  return a + b
}
