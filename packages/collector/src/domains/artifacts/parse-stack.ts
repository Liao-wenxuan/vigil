import type { StackFrame } from '@vigil/protocol'

/**
 * 服务端栈解析。
 *
 * ## 为什么服务端也要会解析
 *
 * SDK 已经解析过一次并把 `frames` 一起发上来了，服务端本来可以直接用。
 * 但这份能力不能只放在客户端：
 *
 * **老客户端只会发原始 stack 字符串。** 如果服务端不会解析，
 * 那这些客户端的错误就永远拿不到 sourcemap 还原 ——
 * 平台的还原能力被 SDK 版本绑死了。
 *
 * 所以服务端独立实现一份。两边各有一份不会漂移：
 * 指纹是**客户端**算的（它有更完整的信息），
 * 栈还原是**服务端**算的（它有 sourcemap）。
 *
 * 支持两种主流格式：
 *
 * Chrome / Edge / Safari（V8）
 * ```
 * TypeError: Cannot read properties of undefined
 *     at fetchUser (https://app.example.com/assets/index-DnB3xK2l.js:42:17)
 *     at https://app.example.com/assets/index-DnB3xK2l.js:100:5
 * ```
 *
 * Firefox / Safari（SpiderMonkey）
 * ```
 * fetchUser@https://app.example.com/index.js:42:17
 * @https://app.example.com/index.js:100:5
 * ```
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack || typeof stack !== 'string') return []

  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    const frame = parseFrameLine(line.trim())
    if (frame) frames.push(frame)
  }
  return frames
}

function parseFrameLine(line: string): StackFrame | null {
  if (!line) return null

  // Chrome：at fn (file:line:col) 或 at file:line:col
  if (line.startsWith('at ')) {
    const body = line.slice(3).trim()
    if (!body) return null

    if (body.endsWith(')')) {
      const open = body.lastIndexOf('(')
      if (open !== -1) {
        const fn = body.slice(0, open).trim()
        const location = body.slice(open + 1, body.length - 1).trim()
        return parseLocation(location, fn || undefined)
      }
    }
    return parseLocation(body)
  }

  // Firefox：fn@file:line:col
  const at = line.lastIndexOf('@')
  if (at > 0) {
    const fn = line.slice(0, at).trim()
    const location = line.slice(at + 1).trim()
    return parseLocation(location, fn || undefined)
  }

  return null
}

/** 解析 `file:line:col` 位置串 */
function parseLocation(location: string, functionName?: string): StackFrame | null {
  if (!location) return null

  // 懒惰匹配从右往左抠数字组，剩下的就是文件名。
  // URL 里也有冒号（http://），靠懒惰匹配 + 数字组约束能正确处理。
  const match = location.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
  if (!match) return null

  const filename = match[1]
  if (!filename) return null

  const frame: StackFrame = { filename }
  if (functionName) frame.functionName = functionName
  if (match[2] !== undefined) frame.lineno = Number(match[2])
  if (match[3] !== undefined) frame.colno = Number(match[3])
  return frame
}
