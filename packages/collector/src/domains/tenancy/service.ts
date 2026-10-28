import crypto from 'node:crypto'
import type { Db } from '../../infra/db/client.js'
import { fromBool, toBool } from '../../infra/db/dialect.js'
import { AppError } from '../../shared/errors.js'

/**
 * 租户域：组织 → 团队 → 项目 → 环境 / 版本。
 *
 * 层级划分的理由：
 * - **组织**：顶级租户，配额与账单挂在这一层
 * - **团队**：人的分组，告警通知发到团队
 * - **项目**：真正被监控的对象（一个前端应用），密钥挂在这一层
 *
 * 环境（production / staging）和版本（release）是项目的**下级概念**，
 * 不是平级的项目 —— 因为同一个项目的不同环境会共享同一套代码和密钥。
 */

/** 生成带前缀的密钥 */
export function generateKey(prefix: 'vsk' | 'vup'): string {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`
}

/** 密钥哈希 */
export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex')
}

export interface OrganizationRow {
  id: number
  slug: string
  name: string
  created_at: number
}

export interface ProjectRow {
  id: number
  organization_id: number
  team_id: number | null
  slug: string
  name: string
  platform: string
  retention_days: number
  event_quota: number
  created_at: number
}

export interface EnvironmentRow {
  id: number
  project_id: number
  slug: string
  name: string
  is_production: number
  created_at: number
}

export interface ReleaseRow {
  id: number
  project_id: number
  version: string
  commit_sha: string | null
  created_at: number
  deployed_at: number | null
}

export interface CreatedProject {
  project: ProjectRow
  /** 运行时密钥（上报用）—— 只在这里返回一次 */
  runtimeKey: string
  /** 上传密钥（sourcemap 用）—— 只在这里返回一次 */
  uploadKey: string
}

export class TenancyService {
  constructor(private readonly db: Db) {}

  // ---- 组织 ----

  async createOrganization(name: string, slug?: string): Promise<OrganizationRow> {
    const finalSlug = slug ?? slugify(name)
    const existing = await this.db.get<OrganizationRow>(
      'SELECT * FROM organizations WHERE slug = ?',
      [finalSlug]
    )
    if (existing) return existing

    const id = await this.db.insert(
      'INSERT INTO organizations (slug, name, created_at) VALUES (?, ?, ?)',
      [finalSlug, name, Date.now()]
    )
    return await this.getOrganization(id)
  }

  async getOrganization(id: number): Promise<OrganizationRow> {
    const row = await this.db.get<OrganizationRow>('SELECT * FROM organizations WHERE id = ?', [id])
    if (!row) throw AppError.notFound('组织')
    return row
  }

  async listOrganizations(): Promise<OrganizationRow[]> {
    return await this.db.all<OrganizationRow>('SELECT * FROM organizations ORDER BY id')
  }

  // ---- 团队 ----

  async createTeam(
    organizationId: number,
    name: string,
    slug?: string
  ): Promise<{
    id: number
    organization_id: number
    slug: string
    name: string
  }> {
    const finalSlug = slug ?? slugify(name)
    const existing = await this.db.get<{ id: number }>(
      'SELECT id FROM teams WHERE organization_id = ? AND slug = ?',
      [organizationId, finalSlug]
    )
    if (existing) return await this.getTeam(existing.id)

    const id = await this.db.insert(
      'INSERT INTO teams (organization_id, slug, name, created_at) VALUES (?, ?, ?, ?)',
      [organizationId, finalSlug, name, Date.now()]
    )
    return await this.getTeam(id)
  }

  async getTeam(id: number) {
    const row = await this.db.get<{
      id: number
      organization_id: number
      slug: string
      name: string
      created_at: number
    }>('SELECT * FROM teams WHERE id = ?', [id])
    if (!row) throw AppError.notFound('团队')
    return row
  }

  // ---- 成员 ----

  async createMember(
    organizationId: number,
    email: string,
    name: string,
    role: 'owner' | 'admin' | 'member' = 'member'
  ): Promise<{ id: number; organization_id: number; email: string; name: string; role: string }> {
    const existing = await this.db.get<{ id: number }>(
      'SELECT id FROM members WHERE organization_id = ? AND email = ?',
      [organizationId, email]
    )
    if (existing) return await this.getMember(existing.id)

    const id = await this.db.insert(
      'INSERT INTO members (organization_id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)',
      [organizationId, email, name, role, Date.now()]
    )
    return await this.getMember(id)
  }

  async getMember(id: number) {
    const row = await this.db.get<{
      id: number
      organization_id: number
      email: string
      name: string
      role: string
      created_at: number
    }>('SELECT * FROM members WHERE id = ?', [id])
    if (!row) throw AppError.notFound('成员')
    return row
  }

  async listMembers(organizationId: number) {
    return await this.db.all<{
      id: number
      email: string
      name: string
      role: string
    }>('SELECT id, email, name, role FROM members WHERE organization_id = ? ORDER BY id', [
      organizationId
    ])
  }

  // ---- 项目 ----

  /**
   * 创建项目，同时生成两把密钥。
   *
   * **两把密钥严格分离**：
   * - runtime：进前端代码，用于上报。拿到它只能刷错误数据
   * - upload：只在 CI 里，用于传 sourcemap。拿到它能污染别人项目的错误栈
   */
  async createProject(input: {
    organizationId: number
    teamId?: number
    name: string
    slug?: string
    platform?: string
    retentionDays?: number
    eventQuota?: number
  }): Promise<CreatedProject> {
    const slug = input.slug ?? slugify(input.name)

    const existing = await this.db.get<ProjectRow>(
      'SELECT * FROM projects WHERE organization_id = ? AND slug = ?',
      [input.organizationId, slug]
    )
    if (existing) {
      // 项目已存在：把现有密钥的明文找不回来了（只存哈希），
      // 所以这里明确报错，而不是返回一个空密钥。
      throw AppError.conflict(`项目 ${slug} 已存在，无法重新生成密钥`)
    }

    const runtimeKey = generateKey('vsk')
    const uploadKey = generateKey('vup')
    const createdAt = Date.now()

    const projectId = await this.db.insert(
      `INSERT INTO projects
         (organization_id, team_id, slug, name, platform, retention_days, event_quota, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.organizationId,
        input.teamId ?? null,
        slug,
        input.name,
        input.platform ?? 'javascript',
        input.retentionDays ?? 90,
        input.eventQuota ?? 1_000_000,
        createdAt
      ]
    )

    await this.db.run(
      'INSERT INTO project_keys (project_id, kind, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
      [projectId, 'runtime', hashKey(runtimeKey), '运行时密钥', createdAt]
    )
    await this.db.run(
      'INSERT INTO project_keys (project_id, kind, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
      [projectId, 'upload', hashKey(uploadKey), '上传密钥', createdAt]
    )

    return {
      project: await this.getProject(projectId),
      runtimeKey,
      uploadKey
    }
  }

  async getProject(id: number): Promise<ProjectRow> {
    const row = await this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id])
    if (!row) throw AppError.notFound('项目')
    return row
  }

  async listProjects(organizationId: number): Promise<ProjectRow[]> {
    return await this.db.all<ProjectRow>(
      'SELECT * FROM projects WHERE organization_id = ? ORDER BY id',
      [organizationId]
    )
  }

  /**
   * 用密钥明文找到项目。
   *
   * 查哈希，不查明文 —— 数据库泄露不等于所有项目的密钥泄露。
   */
  async findProjectByKey(
    key: string
  ): Promise<{ project: ProjectRow; keyKind: 'runtime' | 'upload' } | undefined> {
    if (!key) return undefined

    const row = await this.db.get<{ project_id: number; kind: 'runtime' | 'upload' }>(
      'SELECT project_id, kind FROM project_keys WHERE key_hash = ? LIMIT 1',
      [hashKey(key)]
    )
    if (!row) return undefined

    const project = await this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [
      row.project_id
    ])
    if (!project) return undefined

    return { project, keyKind: row.kind }
  }

  /** 重新生成密钥（旧密钥立即失效） */
  async rotateKey(projectId: number, kind: 'runtime' | 'upload'): Promise<string> {
    const key = generateKey(kind === 'runtime' ? 'vsk' : 'vup')
    await this.db.run('DELETE FROM project_keys WHERE project_id = ? AND kind = ?', [
      projectId,
      kind
    ])
    await this.db.run(
      'INSERT INTO project_keys (project_id, kind, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
      [projectId, kind, hashKey(key), kind === 'runtime' ? '运行时密钥' : '上传密钥', Date.now()]
    )
    return key
  }

  // ---- 环境 ----

  async createEnvironment(
    projectId: number,
    slug: string,
    name: string,
    isProduction = false
  ): Promise<EnvironmentRow> {
    const existing = await this.db.get<EnvironmentRow>(
      'SELECT * FROM environments WHERE project_id = ? AND slug = ?',
      [projectId, slug]
    )
    if (existing) return existing

    const id = await this.db.insert(
      'INSERT INTO environments (project_id, slug, name, is_production, created_at) VALUES (?, ?, ?, ?, ?)',
      [projectId, slug, name, toBool(isProduction), Date.now()]
    )
    return await this.getEnvironment(id)
  }

  async getEnvironment(id: number): Promise<EnvironmentRow> {
    const row = await this.db.get<EnvironmentRow>('SELECT * FROM environments WHERE id = ?', [id])
    if (!row) throw AppError.notFound('环境')
    return row
  }

  async listEnvironments(projectId: number): Promise<EnvironmentRow[]> {
    return await this.db.all<EnvironmentRow>(
      'SELECT * FROM environments WHERE project_id = ? ORDER BY id',
      [projectId]
    )
  }

  async findEnvironmentBySlug(
    projectId: number,
    slug: string
  ): Promise<EnvironmentRow | undefined> {
    return await this.db.get<EnvironmentRow>(
      'SELECT * FROM environments WHERE project_id = ? AND slug = ?',
      [projectId, slug]
    )
  }

  // ---- 版本 ----

  /**
   * 登记一个版本。
   *
   * 版本是**回归判定的锚** —— 「在 1.4.3 解决的问题，
   * 只有 1.4.4+ 再出现才算回归」就靠它。
   */
  async createRelease(
    projectId: number,
    version: string,
    commitSha?: string,
    deployedAt?: number
  ): Promise<ReleaseRow> {
    const existing = await this.db.get<ReleaseRow>(
      'SELECT * FROM releases WHERE project_id = ? AND version = ?',
      [projectId, version]
    )
    if (existing) {
      if (commitSha && !existing.commit_sha) {
        await this.db.run('UPDATE releases SET commit_sha = ? WHERE id = ?', [
          commitSha,
          existing.id
        ])
        return { ...existing, commit_sha: commitSha }
      }
      return existing
    }

    const id = await this.db.insert(
      'INSERT INTO releases (project_id, version, commit_sha, created_at, deployed_at) VALUES (?, ?, ?, ?, ?)',
      [projectId, version, commitSha ?? null, Date.now(), deployedAt ?? null]
    )
    return await this.getRelease(id)
  }

  async getRelease(id: number): Promise<ReleaseRow> {
    const row = await this.db.get<ReleaseRow>('SELECT * FROM releases WHERE id = ?', [id])
    if (!row) throw AppError.notFound('版本')
    return row
  }

  async listReleases(projectId: number): Promise<ReleaseRow[]> {
    return await this.db.all<ReleaseRow>(
      'SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC',
      [projectId]
    )
  }

  async findReleaseByVersion(projectId: number, version: string): Promise<ReleaseRow | undefined> {
    return await this.db.get<ReleaseRow>(
      'SELECT * FROM releases WHERE project_id = ? AND version = ?',
      [projectId, version]
    )
  }
}

/** 名字转 slug（中文保留，英文转小写） */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `project-${Date.now().toString(36)}`
}

export { fromBool, toBool }
