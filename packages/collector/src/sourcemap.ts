import type { Database } from 'better-sqlite3'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import type { ResolvedPosition, StackFrame } from '@vigil/protocol'

/**
 * sourcemap 还原。
 *
 * ## 为什么必须做这一步
 *
 * 生产构建会压缩代码，报上来的栈长这样：
 * ```
 * at t (https://app.example.com/assets/index-DnB3xK2l.js:1:48213)
 * ```
 * 第 1 行第 48213 列 —— 没有任何排查价值。还原之后才是：
 * ```
 * at fetchUserProfile (src/api/user.ts:42:18)
 * ```
 *
 * ## 关键取舍：map 存在服务端，不进静态资源目录
 *
 * 浏览器能下载到的文件，攻击者也能下载到。sourcemap 等于把**源码**公开。
 * 所以 map 只上传到 Collector，由 Collector 在服务端做还原，
 * 还原完只把「原始位置」写进数据库，源码本身不出 Collector。
 *
 * ## 列号的 1-based / 0-based
 *
 * JS 栈里的列号是 **1-based**，`Error.stack` 的惯例；
 * sourcemap 的 column 是 **0-based**。差一位会导致还原到错误的列 ——
 * 不报错，只是位置偏了，非常难发现。所以这里显式 `- 1` / `+ 1`。
 */
export interface ResolvedFrame extends StackFrame {
  original?: ResolvedPosition
}

/** 取文件名部分 */
export function basename(filename: string): string {
  if (!filename) return ''
  const cleaned = filename.split('?')[0].split('#')[0]
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] || cleaned
}

/**
 * 剥掉构建 hash。
 *
 * 上传的 map 用的是**产物文件名**（index-DnB3xK2l.js），
 * 而有些流水线会重命名产物（index.js）。两种情况都要能匹配上，
 * 所以这里做一次归一化再比对。
 */
export function stripBuildHash(filename: string): string {
  return filename.replace(/[.-][A-Za-z0-9_-]{8}(\.[a-z0-9]{2,5})$/i, '$1')
}

export class SourcemapResolver {
  /** TraceMap 缓存：appId|release|baseName → TraceMap */
  private readonly cache = new Map<string, TraceMap>()

  constructor(private readonly db: Database) {}

  /**
   * 还原一组栈帧。
   *
   * 任何一步失败都**降级返回原帧**，绝不抛异常 ——
   * 还原是锦上添花，不能因为它把整条错误弄丢了。
   */
  resolve(appId: string, release: string | undefined, frames: StackFrame[]): ResolvedFrame[] {
    if (!release || frames.length === 0) {
      return frames.map((frame) => ({ ...frame }))
    }

    return frames.map((frame) => {
      const traceMap = this.getTraceMap(appId, release, frame.filename)
      if (!traceMap) return { ...frame }
      if (frame.lineno === undefined) return { ...frame }

      try {
        const position = originalPositionFor(traceMap, {
          line: frame.lineno,
          // JS 栈列号 1-based → sourcemap 0-based
          column: Math.max(0, (frame.colno ?? 1) - 1)
        })

        if (position.line === null || position.column === null) {
          return { ...frame }
        }

        return {
          ...frame,
          original: {
            filename: position.source ?? frame.filename,
            lineno: position.line,
            // sourcemap 0-based → 展示用 1-based
            colno: position.column + 1,
            functionName: position.name ?? frame.functionName,
            source: position.source ?? undefined
          }
        }
      } catch {
        return { ...frame }
      }
    })
  }

  /** 取（并缓存）某个文件对应的 TraceMap */
  private getTraceMap(appId: string, release: string, filename: string): TraceMap | undefined {
    const base = basename(filename)
    if (!base) return undefined

    const cacheKey = `${appId}|${release}|${base}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const row = this.db
      .prepare(
        `SELECT map_json FROM sourcemaps
         WHERE app_id = ? AND release = ? AND base_name = ?
         LIMIT 1`
      )
      .get(appId, release, base) as { map_json: string } | undefined

    if (!row) return undefined

    try {
      const traceMap = new TraceMap(row.map_json)
      this.cache.set(cacheKey, traceMap)
      return traceMap
    } catch {
      return undefined
    }
  }

  /** 上传后清掉对应缓存 —— 否则旧的 map 会一直生效 */
  invalidate(appId: string, release: string): void {
    const prefix = `${appId}|${release}|`
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  /** 清空全部缓存 */
  clear(): void {
    this.cache.clear()
  }
}

/**
 * 保存 sourcemap。
 *
 * 同一个 (app, release, file) 重复上传时覆盖 —— CI 重跑是常态。
 */
export function saveSourcemap(
  db: Database,
  appId: string,
  release: string,
  fileName: string,
  mapJson: string
): void {
  db.prepare(
    `INSERT INTO sourcemaps (app_id, release, file_name, base_name, map_json, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id, release, file_name)
     DO UPDATE SET map_json = excluded.map_json, base_name = excluded.base_name, uploaded_at = excluded.uploaded_at`
  ).run(appId, release, fileName, basename(fileName), mapJson, Date.now())
}
