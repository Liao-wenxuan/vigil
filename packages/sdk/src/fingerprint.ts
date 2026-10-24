import type { ErrorCategory, ErrorEvent, ResourceInfo, HttpInfo, StackFrame } from '@vigil/protocol'
import { hashString } from './hash'

/**
 * 错误指纹（fingerprint）
 *
 * 指纹是**聚合主键**：同一个指纹的错误在后台被并成一条，count 累加。
 * 指纹算错了，监控系统的价值就归零了：
 *   - 算得太散 → 一万个错误一万条记录，看不出哪个是真问题
 *   - 算得太聚 → 五个不同的 bug 挤成一条，修了一个另外四个还在但你看不见
 *
 * 三条设计准则：
 *
 * 1. **用 category，不用 kind**
 *    Vue 捕获和全局捕获到同一个错误，应该是同一条。kind 只说明「谁抓的」。
 *
 * 2. **指纹不含行号列号**
 *    改一行代码不该让这条错误的「历史」断掉。指纹里放行号，
 *    每次发版都会产生一批「新错误」，后台的「已解决/未解决」状态全部失效。
 *
 * 3. **剥掉构建 hash**
 *    `index-a1b2c3d4.js` 每次构建都变。不剥掉的话指纹跟构建产物绑定，
 *    等于每发一次版，所有错误都变成「新的」。
 */

/** 第三方代码的帧：不是用户的 bug，不该主导指纹 */
function isThirdPartyFrame(filename: string): boolean {
  return (
    filename.includes('node_modules/') ||
    filename.includes('/@vite/') ||
    filename.includes('/@fs/') ||
    filename.includes('/@id/')
  )
}

/**
 * 剥掉构建产物里的内容 hash。
 *
 * Vite 默认产出 `index-DnB3xK2l.js`，webpack 是 `index.abc12345.js`。
 * 只在**文件名末尾**、且前面是分隔符、后面是扩展名时才剥，
 * 免得把 `my.component.chunk.js` 这种正常文件名误伤。
 */
export function stripBuildHash(filename: string): string {
  return filename.replace(/[.-][A-Za-z0-9_-]{8}(\.[a-z0-9]{2,5})$/i, '$1')
}

/** 取文件名部分（去掉路径） */
export function basename(filename: string): string {
  if (!filename) return ''
  const cleaned = filename.split('?')[0].split('#')[0]
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] || cleaned
}

/**
 * 把消息里的动态部分归一化。
 *
 * 「用户 12345 不存在」和「用户 67890 不存在」是同一个 bug，
 * 但字面不同 —— 不归一化就会按消息分成两条。
 */
export function normalizeMessage(message: string): string {
  if (!message) return ''
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** 取 URL 的路径部分（去 origin、去 query、去 hash） */
export function pathOf(url: string): string {
  if (!url) return ''
  let s = url.split('?')[0].split('#')[0]
  const schemeEnd = s.indexOf('://')
  if (schemeEnd !== -1) {
    const slash = s.indexOf('/', schemeEnd + 3)
    s = slash === -1 ? '/' : s.slice(slash)
  }
  return s || '/'
}

export interface FingerprintInput {
  category: ErrorCategory
  name?: string
  message: string
  frames: StackFrame[]
  resource?: ResourceInfo
  http?: HttpInfo
  /** SDK 自身的文件名，用于把 SDK 内部帧从指纹里剔除 */
  sdkFilenames?: string[]
}

/** 判断某帧是否来自 SDK 自己 */
function isSdkFrame(frame: StackFrame, sdkFilenames: string[]): boolean {
  if (!sdkFilenames.length) return false
  const file = frame.filename
  return sdkFilenames.some((sdkFile) => file.includes(sdkFile))
}

/**
 * 计算错误指纹。
 *
 * 纯函数，不依赖运行时环境 —— 同样的输入永远得到同样的输出，
 * 这样单元测试可以直接断言具体值。
 */
export function computeFingerprint(input: FingerprintInput): string {
  const sdkFilenames = input.sdkFilenames ?? []

  if (input.category === 'resource') {
    const resource = input.resource
    if (!resource) return hashString('resource|unknown')
    // 资源错误没有栈，靠「标签 + 地址」分组。
    // 地址去掉 query —— 图片 URL 上的 ?v=123 是缓存版本号，
    // 带上它每次发版都变成新的一条。
    const src = resource.src.split('?')[0].split('#')[0]
    return hashString(`resource|${resource.tag}|${src}`)
  }

  if (input.category === 'http') {
    const http = input.http
    if (!http) return hashString('http|unknown')
    // 接口错误按「方法 + 路径 + 状态码」分组。
    // 不带 query：不同 query 往往是同一个接口的不同筛选条件，
    // 合在一起才能看出「哪个接口在挂」。
    return hashString(`http|${http.method}|${pathOf(http.url)}|${http.status}`)
  }

  // category === 'javascript'
  const errorName = input.name ?? 'Error'

  const frames = input.frames
  const appFrames = frames.filter(
    (frame) => !isSdkFrame(frame, sdkFilenames) && !isThirdPartyFrame(frame.filename)
  )
  const usable =
    appFrames.length > 0 ? appFrames : frames.filter((f) => !isSdkFrame(f, sdkFilenames))

  if (usable.length > 0) {
    // 取前三帧：再往后的帧通常只是调用链上游，信息量递减；
    // 但前三帧足够区分「同一个函数里的不同 bug」。
    const frameKey = usable
      .slice(0, 3)
      .map((frame) => `${frame.functionName ?? '?'}@${stripBuildHash(basename(frame.filename))}`)
      .join('>')
    return hashString(`js|${errorName}|${frameKey}`)
  }

  // 没有可用栈（比如内联脚本里的错误、或者错误对象被序列化过）：
  // 退化成「错误名 + 归一化后的消息」。
  return hashString(`js|${errorName}|msg:${normalizeMessage(input.message)}`)
}

/**
 * 为事件计算指纹。事件里已经带好了 category 和各 kind 的专属字段。
 */
export function fingerprintOfEvent(event: {
  category: ErrorCategory
  name?: string
  message: string
  frames: StackFrame[]
  resource?: ResourceInfo
  http?: HttpInfo
}): string {
  return computeFingerprint(event)
}

/**
 * 自定义指纹：用户可以在上报时覆盖。
 *
 * 有些错误 SDK 算不出稳定指纹（比如错误发生在 worker 里、没有栈），
 * 这时业务侧最清楚「什么参数组合算同一个 bug」。
 */
export function normalizeCustomFingerprint(value: string): string {
  return hashString(`custom|${value.trim()}`)
}

/** 类型收敛辅助：让 events 数组在 TS 里保持 ErrorEvent 精确类型 */
export type { ErrorEvent }
