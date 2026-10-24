import type { StackFrame } from '@vigil/protocol'

/**
 * 把 `Error.stack` 字符串解析成结构化栈帧。
 *
 * 支持两种主流格式：
 *
 * Chrome / Edge / Safari（V8）
 * ```
 * TypeError: Cannot read properties of undefined
 *     at fetchData (https://app.example.com/assets/index-a1b2c3d4.js:42:17)
 *     at https://app.example.com/assets/index-a1b2c3d4.js:100:5
 * ```
 *
 * Firefox / Safari（SpiderMonkey）
 * ```
 * fetchData@https://app.example.com/assets/index-a1b2c3d4.js:42:17
 * @https://app.example.com/assets/index-a1b2c3d4.js:100:5
 * ```
 *
 * 解析不出来就返回空数组 —— 降级展示，不抛异常。
 * 采集代码自己抛异常是最糟糕的故障模式：它会让真正的错误彻底消失。
 */

/** Chrome: `at fn (file:line:col)` 或 `at file:line:col` */
const CHROME_FRAME = /^at\s+(.*)$/
/** Firefox: `fn@file:line:col` 或 `@file:line:col` */
const FIREFOX_FRAME = /^(.*)@(.*)$/

/** 解析 `file:line:col` 位置串 */
function parseLocation(location: string, functionName?: string): StackFrame | null {
  if (!location) return null

  // 末尾的 `:line:col` 是可选的，而且文件名本身可能含冒号（`http://`）。
  // 用懒惰匹配从**右往左**抠出数字组，剩下的就是文件名。
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

/** 解析单行栈文本 */
function parseFrameLine(line: string): StackFrame | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const chrome = trimmed.match(CHROME_FRAME)
  if (chrome) {
    const body = chrome[1].trim()
    if (!body) return null

    // `fn (file:line:col)` —— 函数名和位置被一对括号隔开
    if (body.endsWith(')')) {
      const open = body.lastIndexOf('(')
      if (open !== -1) {
        const fn = body.slice(0, open).trim()
        const location = body.slice(open + 1, body.length - 1).trim()
        return parseLocation(location, fn || undefined)
      }
    }
    // `file:line:col` —— 没有函数名
    return parseLocation(body)
  }

  const firefox = trimmed.match(FIREFOX_FRAME)
  if (firefox) {
    const fn = firefox[1].trim()
    const location = firefox[2].trim()
    return parseLocation(location, fn || undefined)
  }

  return null
}

/**
 * 解析完整栈。
 *
 * 第一行（`TypeError: message`）不是栈帧，会被自然过滤掉：
 * 它不以 `at ` 开头，也几乎不含 `@`。
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack || typeof stack !== 'string') return []

  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    const frame = parseFrameLine(line)
    if (frame) frames.push(frame)
  }
  return frames
}

/**
 * 从任意 thrown 值里尽量提取「消息 + 原始栈」。
 *
 * catch 到的可能是 Error，也可能是字符串、数字、对象，甚至 null。
 * 全部要能安全转成一条可上报的事件。
 */
export function describeThrown(thrown: unknown): {
  name?: string
  message: string
  stack?: string
} {
  if (thrown instanceof Error) {
    return {
      name: thrown.name || 'Error',
      message: thrown.message || thrown.name || 'Unknown error',
      stack: thrown.stack
    }
  }

  if (typeof thrown === 'string') {
    return { message: thrown }
  }

  if (thrown && typeof thrown === 'object') {
    const obj = thrown as Record<string, unknown>
    const message = typeof obj.message === 'string' ? obj.message : safeStringify(thrown)
    const name = typeof obj.name === 'string' ? obj.name : undefined
    const stack = typeof obj.stack === 'string' ? obj.stack : undefined
    return { name, message, stack }
  }

  return { message: String(thrown) }
}

/** JSON 序列化，遇到循环引用不抛异常 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, (_key, val: unknown) => {
        if (val && typeof val === 'object') {
          if (seen.has(val as object)) return '[Circular]'
          seen.add(val as object)
        }
        return val
      }) ?? String(value)
    )
  } catch {
    return String(value)
  }
}
