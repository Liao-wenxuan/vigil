import crypto from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Db } from '../../infra/db/client.js'
import { writeJson } from '../../infra/db/dialect.js'
import { AppError } from '../../shared/errors.js'
import type { TenancyService } from '../tenancy/service.js'

/**
 * 管理端鉴权与审计。
 *
 * ## 之前是什么样
 *
 * 40 多个管理路由共用一个 `VIGIL_ADMIN_TOKEN`：谁拿到它谁就是全系统
 * 管理员，不能撤销单个人、不能按组织隔离、不能给项目只读，`audit_log`
 * 表建好了但一行没写过。这是「一个人能跑」和「一个团队能用」的分界线。
 *
 * ## 现在的模型
 *
 * - **超级管理员**：`VIGIL_ADMIN_TOKEN`，bootstrap 用，全权限。
 *   现网 nginx 注入的就是它 —— 语义升级，但用法一个字都不改。
 * - **成员凭据**：`vmk_...`，按人签发、可撤销，绑定组织；
 *   组织角色 `owner > admin > member`，项目角色 `owner > editor > reader`。
 *
 * ⚠️ 兼容是硬约束：线上走的是 Basic Auth + nginx 注入 admin token，
 *    任何「必须先登录」的改造都会让面板当场全白，所以 admin token
 *    永远是第一等公民，成员凭据是**并存**的第二套，不是替代。
 */

export type OrgRole = 'owner' | 'admin' | 'member'

export type Principal =
  | {
      kind: 'superadmin'
      actorType: 'system'
      actorId: null
      organizationId: null
    }
  | {
      kind: 'member'
      actorType: 'member'
      actorId: number
      organizationId: number
      email: string
      orgRole: OrgRole
    }

declare module 'fastify' {
  interface FastifyRequest {
    /** 管理端 preHandler 挂上；onResponse 用它写审计 */
    vigilPrincipal?: Principal
  }
}

const SUPERADMIN: Principal = {
  kind: 'superadmin',
  actorType: 'system',
  actorId: null,
  organizationId: null
}

const ORG_LEVEL: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 }

type Action = 'read' | 'write' | 'manage' | 'superadmin'

/** 成员 / 凭据 / 项目授权 / 维护任务：只有组织 owner 能动 */
const MANAGE_PATH =
  /^\/api\/v1\/(organizations\/\d+\/members|members\/\d+\/keys|projects\/\d+\/members|maintenance\/)/

/** 轮换项目密钥会让现有 SDK 立刻失效，权限提到 owner 级 */
const ROTATE_KEY_PATH = /^\/api\/v1\/projects\/\d+\/keys\/rotate/

function pathOnly(url: string): string {
  return url.split('?')[0]
}

function projectIdFrom(path: string): number | undefined {
  const match = path.match(/\/projects\/(\d+)/)
  return match ? Number(match[1]) : undefined
}

/**
 * 按 method + path 推出所需权限。
 *
 * 40 多个路由共用同一个 preHandler，所以规则集中在这里而不是散在路由上 ——
 * 逐路由声明的话，漏配一个就是一次越权，而且没人会发现。
 */
function requiredAction(method: string, path: string): Action {
  // 创建组织是全系统动作，没有「所属组织」可校验，只能由 bootstrap 凭据做
  if (method === 'POST' && /^\/api\/v1\/organizations\/?$/.test(path)) return 'superadmin'

  if (MANAGE_PATH.test(path)) return method === 'GET' ? 'read' : 'manage'
  if (ROTATE_KEY_PATH.test(path)) return 'manage'
  if (method === 'DELETE') return 'manage'
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'read'
  return 'write'
}

export class AuthzService {
  private readonly adminHash: string

  constructor(
    private readonly db: Db,
    private readonly tenancy: TenancyService,
    adminToken: string
  ) {
    this.adminHash = crypto.createHash('sha256').update(adminToken, 'utf8').digest('hex')
  }

  async resolve(headers: FastifyRequest['headers']): Promise<Principal> {
    const authorization = headers.authorization
    const bearer =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : undefined

    const candidates = [
      headers['x-vigil-member-token'],
      headers['x-vigil-admin-token'],
      bearer
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)

    if (candidates.length === 0) throw AppError.unauthorized('缺少管理凭据')

    for (const token of candidates) {
      if (this.isAdminToken(token)) return SUPERADMIN

      const member = await this.tenancy.findMemberByKey(token)
      if (member) {
        return {
          kind: 'member',
          actorType: 'member',
          actorId: Number(member.id),
          organizationId: Number(member.organization_id),
          email: member.email,
          orgRole: normalizeOrgRole(member.role)
        }
      }
    }

    // 带了凭据但都不认识 —— 403 而不是 401，和旧行为一致
    throw AppError.forbidden('管理凭据无效')
  }

  private isAdminToken(token: string): boolean {
    const actual = crypto.createHash('sha256').update(token, 'utf8').digest('hex')
    // 常量时间比较：逐字节比较的时间差会泄漏 token 前缀
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(this.adminHash))
  }

  /** 身份 + 权限等级 + 租户隔离，一次判定完 */
  async authorize(principal: Principal, method: string, url: string): Promise<void> {
    if (principal.kind === 'superadmin') return

    const path = pathOnly(url)
    const action = requiredAction(method, path)
    if (action === 'superadmin') throw AppError.forbidden('只有超级管理员能创建组织')

    const targetOrg = await this.targetOrganization(path)
    if (targetOrg !== undefined && targetOrg !== principal.organizationId) {
      throw AppError.forbidden('不能访问其它组织的数据')
    }

    const level = ORG_LEVEL[principal.orgRole]
    if (action === 'manage') {
      if (level < 2) throw AppError.forbidden('需要组织 owner 权限')
      return
    }
    if (action === 'write') {
      // 组织 admin/owner 天然可写
      if (level >= 1) return
      // 组织 member 仍可靠**项目级** editor/owner 拿到该项目的写权限
      const projectId = projectIdFrom(path)
      if (projectId !== undefined) {
        const role = await this.tenancy.projectMemberRole(projectId, principal.actorId)
        if (role === 'editor' || role === 'owner') return
      }
      throw AppError.forbidden('需要组织 admin 或项目 editor 权限')
    }
    // read：同组织成员都可读
  }

  private async targetOrganization(path: string): Promise<number | undefined> {
    const projectId = projectIdFrom(path)
    if (projectId !== undefined) {
      return await this.tenancy.organizationOfProject(projectId)
    }
    const org = path.match(/\/organizations\/(\d+)/)
    if (org) return Number(org[1])
    const member = path.match(/\/members\/(\d+)/)
    if (member) return await this.tenancy.organizationOfMember(Number(member[1]))
    return undefined
  }

  /**
   * 写审计：只记**成功**的写操作，且**不记请求体**。
   *
   * 创建项目、签发凭据的响应里带明文密钥，审计表不该变成第二个密钥库。
   * 所以 data_json 只放响应状态码；谁、在哪个组织、对什么资源做了什么
   * 才是审计要回答的问题。
   */
  async recordAudit(
    principal: Principal,
    method: string,
    url: string,
    status: number
  ): Promise<void> {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
    if (status >= 400) return

    const path = pathOnly(url)
    const organizationId = principal.organizationId ?? (await this.targetOrganization(path)) ?? null
    const target = path.match(/^\/api\/v1\/([a-z-]+)(?:\/(\d+))?/)

    await this.db.run(
      `INSERT INTO audit_log
         (organization_id, actor_type, actor_id, action, target_type, target_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId,
        principal.actorType,
        principal.actorId,
        `${method} ${path}`,
        target?.[1] ?? null,
        target?.[2] ?? null,
        writeJson({ status }),
        Date.now()
      ]
    )
  }

  async listAudit(organizationId: number, limit = 100) {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100
    return await this.db.all<{
      id: number
      actor_type: string
      actor_id: number | null
      action: string
      target_type: string | null
      target_id: string | null
      data_json: unknown
      created_at: number
    }>(
      `SELECT id, actor_type, actor_id, action, target_type, target_id, data_json, created_at
       FROM audit_log WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [organizationId, safeLimit]
    )
  }
}

function normalizeOrgRole(role: string): OrgRole {
  return role === 'owner' || role === 'admin' ? role : 'member'
}
