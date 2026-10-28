/**
 * 采集接口地址的解析。
 *
 * ## 为什么需要这一层
 *
 * `endpoint` 是**错误上报**的完整地址，例如
 * `https://collector.example.com/api/v1/collect`。
 *
 * 但性能走 `.../api/v1/performance`，行为走 `.../api/v1/behavior` ——
 * 三者是**同层级的兄弟通道**，共享同一个 API 根。
 *
 * ## 这里踩过的坑
 *
 * 把路径直接拼在 endpoint 后面会得到
 * `https://collector.example.com/api/v1/collect/api/v1/behavior` ——
 * 404，而且**不报错**：请求发出去了、服务端也收到了，只是路由不匹配。
 *
 * 这种 bug 最难查 —— 面板上看到的是「行为数据一条都没有」，
 * 而 SDK 侧一切正常，日志里连一条警告都没有。
 */

/**
 * 从采集接口地址推出 **API 根地址**。
 *
 * 规则：去掉最后一段路径。
 *   `.../api/v1/collect` → `.../api/v1`
 *   `.../api/v1/collect/` → `.../api/v1`（末尾斜杠也要去掉）
 *   `/api/v1/collect` → `/api/v1`（相对地址保持相对）
 *
 * 用字符串切而不是 `new URL()`：
 * 相对地址在浏览器里是合法的，而 `new URL` 必须配一个基址，
 * 解析出来的 origin 是假的。
 */
export function resolveApiRoot(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  const lastSlash = trimmed.lastIndexOf('/')

  // 没有斜杠 —— 整个地址就是一个段，当根用
  if (lastSlash === -1) return trimmed

  // 斜杠在开头 —— 相对地址，保留前导斜杠
  const root = trimmed.slice(0, lastSlash)
  return root === '' ? '/' : root
}

/**
 * 推导出某个通道的完整上报地址。
 *
 * @param endpoint 采集接口地址
 * @param channel  通道名，如 `performance` / `behavior`
 */
export function resolveChannelEndpoint(endpoint: string, channel: string): string {
  const root = resolveApiRoot(endpoint)
  const separator = root.endsWith('/') ? '' : '/'
  return `${root}${separator}${channel}`
}
