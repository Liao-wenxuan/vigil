import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import type { Db } from '../../infra/db/client.js'
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
 * JS 栈里的列号是 **1-based**（`Error.stack` 的惯例）；
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
  /**
   * 命中的 TraceMap 缓存：projectId|release|baseName → TraceMap
   *
   * ⚠️ TraceMap 是**重对象**（整个 sourcemap 解析后的结构），
   *    所以数量必须封顶 —— 否则一个上传了几百个 chunk map 的项目
   *    会把内存吃光。封顶后最坏情况只是多查一次库。
   */
  private readonly hitCache = new Map<string, TraceMap>()

  /**
   * 未命中缓存：projectId|release|baseName → true
   *
   * ## 为什么必须缓存「没有」
   *
   * 没上传 sourcemap 的项目**很常见**（只上传了部分产物、
   * 或者 map 是后来才补传的）。而未命中如果不缓存，
   * **每一条错误事件都要白跑一次库** ——
   * 摄入热路径 5 次往返里有 1 次是它。
   *
   * 在 PostgreSQL 部署下这是实打实的一次**网络往返**，
   * 5 次 → 4 次就是 20% 的摄入延迟。
   *
   * 未命中条目很轻（只有一个 key），所以可以放很多。
   */
  private readonly missCache = new Map<string, true>()

  /** TraceMap 缓存上限 —— 重对象，少放几个 */
  private static readonly HIT_CACHE_MAX = 32
  /** 未命中缓存上限 —— 轻对象，可以多放 */
  private static readonly MISS_CACHE_MAX = 4096

  constructor(private readonly db: Db) {}

  /**
   * 还原一组栈帧。
   *
   * 任何一步失败都**降级返回原帧**，绝不抛异常 ——
   * 还原是锦上添花，不能因为它把整条错误弄丢了。
   */
  async resolve(
    projectId: number,
    release: string | undefined,
    frames: StackFrame[]
  ): Promise<ResolvedFrame[]> {
    if (!release || frames.length === 0) {
      return frames.map((frame) => ({ ...frame }))
    }

    return await Promise.all(
      frames.map(async (frame) => {
        const traceMap = await this.getTraceMap(projectId, release, frame.filename)
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
    )
  }

  /** 取（并缓存）某个文件对应的 TraceMap */
  private async getTraceMap(
    projectId: number,
    release: string,
    filename: string
  ): Promise<TraceMap | undefined> {
    const base = basename(filename)
    if (!base) return undefined

    const cacheKey = `${projectId}|${release}|${base}`

    // 命中缓存
    const hit = this.hitCache.get(cacheKey)
    if (hit) return hit

    // 未命中缓存 —— 这里必须用 `has` 而不是 `get`：
    // 存的是 `true`，`get` 拿到的是 `true`，跟「没缓存过」区分不开
    if (this.missCache.has(cacheKey)) return undefined

    const row = await this.db.get<{ map_json: string }>(
      `SELECT map_json FROM sourcemaps
       WHERE project_id = ? AND release_id IN (
         SELECT id FROM releases WHERE project_id = ? AND version = ?
       ) AND base_name = ?
       LIMIT 1`,
      [projectId, projectId, release, base]
    )

    if (!row) {
      this.rememberMiss(cacheKey)
      return undefined
    }

    try {
      const traceMap = new TraceMap(row.map_json)
      this.rememberHit(cacheKey, traceMap)
      return traceMap
    } catch {
      // map 坏了 —— 也记成「没有」，省得每条事件都重新解析一遍。
      // 重新上传会 invalidate 这条缓存，所以不会一直卡在坏 map 上。
      this.rememberMiss(cacheKey)
      return undefined
    }
  }

  /** 记一次命中，并给重对象缓存封顶 */
  private rememberHit(key: string, traceMap: TraceMap): void {
    this.hitCache.set(key, traceMap)
    while (this.hitCache.size > SourcemapResolver.HIT_CACHE_MAX) {
      const oldest = this.hitCache.keys().next().value
      if (oldest === undefined) break
      this.hitCache.delete(oldest)
    }
  }

  /** 记一次未命中，并给轻量缓存封顶 */
  private rememberMiss(key: string): void {
    this.missCache.set(key, true)
    while (this.missCache.size > SourcemapResolver.MISS_CACHE_MAX) {
      const oldest = this.missCache.keys().next().value
      if (oldest === undefined) break
      this.missCache.delete(oldest)
    }
  }

  /** 上传后清掉对应缓存 —— 否则旧的 map 会一直生效 */
  invalidate(projectId: number, release?: string): void {
    const prefix = release ? `${projectId}|${release}|` : `${projectId}|`
    for (const key of this.hitCache.keys()) {
      if (key.startsWith(prefix)) this.hitCache.delete(key)
    }
    // ⚠️ 未命中缓存也必须清 —— 否则后补传的 map 不生效
    for (const key of this.missCache.keys()) {
      if (key.startsWith(prefix)) this.missCache.delete(key)
    }
  }

  /** 清空全部缓存 */
  clear(): void {
    this.hitCache.clear()
    this.missCache.clear()
  }
}

/**
 * 保存 sourcemap。
 *
 * 同一个 (项目, 版本, 文件) 重复上传时覆盖 —— CI 重跑是常态。
 */
export async function saveSourcemap(
  db: Db,
  projectId: number,
  releaseId: number | null,
  fileName: string,
  mapJson: string
): Promise<void> {
  await db.run(
    `INSERT INTO sourcemaps (project_id, release_id, file_name, base_name, map_json, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, release_id, file_name)
     DO UPDATE SET map_json = excluded.map_json, base_name = excluded.base_name, uploaded_at = excluded.uploaded_at`,
    [projectId, releaseId, fileName, basename(fileName), mapJson, Date.now()]
  )
}
