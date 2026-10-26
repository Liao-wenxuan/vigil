import type { Db } from '../../infra/db/client.js'
import { saveSourcemap, SourcemapResolver } from './sourcemap.js'
import { parseUserAgent } from '../tenancy/user-agent.js'
import { AppError } from '../../shared/errors.js'

/**
 * 制品域：版本 + 构建产物 + sourcemap。
 *
 * sourcemap 是**敏感数据** —— 公开可下载等于公开源码。
 * 所以它只存服务端，由 Collector 还原后只输出「原始位置」。
 */
export class ArtifactService {
  private readonly resolver: SourcemapResolver

  constructor(private readonly db: Db) {
    this.resolver = new SourcemapResolver(db)
  }

  get sourcemapResolver(): SourcemapResolver {
    return this.resolver
  }

  /**
   * 上传 sourcemap。
   *
   * 版本不存在时**自动创建** —— CI 不应该因为忘了登记版本而失败。
   */
  uploadSourcemap(input: {
    projectId: number
    release: string
    fileName: string
    mapJson: string
  }): { releaseId: number; uploaded: number } {
    const release = this.db.get<{ id: number }>(
      'SELECT id FROM releases WHERE project_id = ? AND version = ?',
      [input.projectId, input.release]
    )

    let releaseId: number
    if (release) {
      releaseId = release.id
    } else {
      this.db.run('INSERT INTO releases (project_id, version, created_at) VALUES (?, ?, ?)', [
        input.projectId,
        input.release,
        Date.now()
      ])
      releaseId = Number(this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0)
    }

    saveSourcemap(this.db, input.projectId, releaseId, input.fileName, input.mapJson)

    // 缓存必须清掉，否则新上传的 map 不生效
    this.resolver.invalidate(input.projectId, input.release)

    // 顺带记一条制品
    this.db.run(
      `INSERT INTO artifacts (project_id, release_id, file_name, kind, size_bytes, uploaded_at)
       VALUES (?, ?, ?, 'sourcemap', ?, ?)
       ON CONFLICT(project_id, release_id, file_name, kind)
       DO UPDATE SET size_bytes = excluded.size_bytes, uploaded_at = excluded.uploaded_at`,
      [input.projectId, releaseId, input.fileName, input.mapJson.length, Date.now()]
    )

    return { releaseId, uploaded: 1 }
  }

  /** 批量上传 */
  uploadSourcemaps(input: {
    projectId: number
    release: string
    files: Array<{ fileName: string; sourceMap: string }>
  }): { uploaded: number } {
    return this.db.transaction(() => {
      for (const file of input.files) {
        this.uploadSourcemap({
          projectId: input.projectId,
          release: input.release,
          fileName: file.fileName,
          mapJson: file.sourceMap
        })
      }
      return { uploaded: input.files.length }
    })
  }

  /** 列出某个版本的上传记录 */
  listArtifacts(
    projectId: number,
    release?: string
  ): Array<{
    id: number
    file_name: string
    kind: string
    size_bytes: number
    uploaded_at: number
  }> {
    if (release) {
      return this.db.all(
        `SELECT a.id, a.file_name, a.kind, a.size_bytes, a.uploaded_at
         FROM artifacts a
         JOIN releases r ON r.id = a.release_id
         WHERE a.project_id = ? AND r.version = ?
         ORDER BY a.file_name`,
        [projectId, release]
      )
    }

    return this.db.all(
      `SELECT id, file_name, kind, size_bytes, uploaded_at
       FROM artifacts WHERE project_id = ? ORDER BY uploaded_at DESC`,
      [projectId]
    )
  }

  /** 解析 User-Agent（性能事务也带环境信息） */
  parseUserAgent(ua: string): { browser?: string; os?: string; device: string } {
    return parseUserAgent(ua)
  }

  /** 找不到版本时报错 */
  requireRelease(projectId: number, version: string): number {
    const row = this.db.get<{ id: number }>(
      'SELECT id FROM releases WHERE project_id = ? AND version = ?',
      [projectId, version]
    )
    if (!row) throw AppError.notFound(`版本 ${version}`)
    return row.id
  }
}
