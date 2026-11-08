import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setupDb } from './helpers.js'

/**
 * 权限模型与审计。
 *
 * 守的四件事：
 *   1. 现网 `VIGIL_ADMIN_TOKEN` 语义不变（线上 Basic Auth + nginx 注入不能挂）
 *   2. 成员按组织隔离，跨组织一律 403
 *   3. 角色矩阵：读 / 写 / manage / 只有超管能建组织
 *   4. 审计只记成功的写操作，且绝不把明文密钥写进去
 */

const ADMIN = 'super-secret-admin-token'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function fixture() {
  const ctx = await setupDb()
  const built = await buildApp({ db: ctx.db, adminToken: ADMIN })
  return { ...ctx, app: built.app }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/**
 * `app.inject` 返回 light-my-request 的 `void & Promise<Response> & Chain`
 * 交叉类型，封装成函数后 TS 解不开，所以显式收窄成测试用到的两个方法。
 */
interface InjectResponse {
  statusCode: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any
}

async function call(
  ctx: Fixture,
  method: Method,
  url: string,
  opts: { admin?: boolean; key?: string; payload?: Record<string, unknown> } = {}
): Promise<InjectResponse> {
  const headers: Record<string, string> = {}
  if (opts.admin) headers['x-vigil-admin-token'] = ADMIN
  else if (opts.key) headers['x-vigil-member-token'] = opts.key

  const response = await ctx.app.inject({ method, url, headers, payload: opts.payload })
  return response as unknown as InjectResponse
}

/** 造一个成员 + 一把凭据。每个测试用全新内存库，email 不会撞 */
async function member(
  ctx: Fixture,
  role: 'owner' | 'admin' | 'member',
  organizationId = ctx.organization.id
) {
  const created = await ctx.tenancy.createMember(
    organizationId,
    `${role}-${organizationId}@example.com`,
    `成员 ${role}`,
    role
  )
  const { id: keyId, key } = await ctx.tenancy.createMemberKey(created.id, '测试凭据')
  return { id: created.id, key, keyId }
}

/** 合法的写请求体 —— schema 校验在 preHandler **之前**，空 body 会先 400，测不到权限 */
const validWrite = { slug: 'perf-env', name: '性能环境' }

describe('管理端鉴权：兼容与身份', () => {
  it('admin token 仍是超级管理员，/api/v1/me 能报出身份', async () => {
    const ctx = await fixture()

    const response = await call(ctx, 'GET', '/api/v1/me', { admin: true })
    expect(response.statusCode).toBe(200)
    expect(response.json().principal).toMatchObject({
      kind: 'superadmin',
      actorType: 'system',
      orgRole: 'owner'
    })
    await ctx.db.close()
  })

  it('Bearer 形式的 admin token 照样能用（旧客户端兼容）', async () => {
    const ctx = await fixture()

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${ADMIN}` }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().principal).toMatchObject({ kind: 'superadmin' })
    await ctx.db.close()
  })

  it('不带凭据 401，带错凭据 403', async () => {
    const ctx = await fixture()

    expect((await call(ctx, 'GET', '/api/v1/me')).statusCode).toBe(401)
    expect((await call(ctx, 'GET', '/api/v1/me', { key: 'vmk_nope' })).statusCode).toBe(403)
    await ctx.db.close()
  })

  it('成员凭据能报出自己的组织与角色', async () => {
    const ctx = await fixture()
    const people = await member(ctx, 'admin')

    const response = await call(ctx, 'GET', '/api/v1/me', { key: people.key })
    expect(response.statusCode).toBe(200)
    expect(response.json().principal).toMatchObject({
      kind: 'member',
      actorType: 'member',
      organizationId: ctx.organization.id,
      orgRole: 'admin'
    })
    await ctx.db.close()
  })

  it('组织列表对成员只暴露自己的组织', async () => {
    const ctx = await fixture()
    await ctx.tenancy.createOrganization('别的组织')
    const people = await member(ctx, 'member')

    const response = await call(ctx, 'GET', '/api/v1/organizations', { key: people.key })
    expect(response.statusCode).toBe(200)
    expect(response.json().organizations).toHaveLength(1)
    expect(response.json().organizations).toEqual([
      expect.objectContaining({ id: ctx.organization.id })
    ])

    const all = await call(ctx, 'GET', '/api/v1/organizations', { admin: true })
    expect(all.json().organizations).toHaveLength(2)
    await ctx.db.close()
  })
})

describe('权限矩阵与租户隔离', () => {
  /**
   * 用合法 body 让 schema 校验通过，preHandler 才会真正跑：
   * 403 = 被权限拦下，201 = 放行并真的建出了环境。
   */
  const writeUrl = (projectId: number) => `/api/v1/projects/${projectId}/environments`

  it('组织 member 没有项目角色时不能写，跨组织项目一律 403', async () => {
    const ctx = await fixture()
    const otherOrg = await ctx.tenancy.createOrganization('别的组织')
    const otherProject = await ctx.tenancy.createProject({
      organizationId: otherOrg.id,
      name: '别的项目'
    })
    const people = await member(ctx, 'member')

    expect(
      (
        await call(ctx, 'POST', writeUrl(ctx.project.id), {
          key: people.key,
          payload: validWrite
        })
      ).statusCode
    ).toBe(403)
    expect(
      (await call(ctx, 'GET', `/api/v1/projects/${otherProject.project.id}`, { key: people.key }))
        .statusCode
    ).toBe(403)
    expect(
      (
        await call(ctx, 'GET', `/api/v1/organizations/${otherOrg.id}/members`, {
          key: people.key
        })
      ).statusCode
    ).toBe(403)
    await ctx.db.close()
  })

  it('项目级 editor 能写被授权的项目，不能写同组织的其它项目', async () => {
    const ctx = await fixture()
    const otherProject = await ctx.tenancy.createProject({
      organizationId: ctx.organization.id,
      name: '同组织另一个项目'
    })
    const people = await member(ctx, 'member')
    await ctx.tenancy.setProjectMember(ctx.project.id, people.id, 'editor')

    expect(
      (
        await call(ctx, 'POST', writeUrl(ctx.project.id), {
          key: people.key,
          payload: validWrite
        })
      ).statusCode
    ).toBe(201)
    expect(
      (
        await call(ctx, 'POST', writeUrl(otherProject.project.id), {
          key: people.key,
          payload: validWrite
        })
      ).statusCode
    ).toBe(403)
    await ctx.db.close()
  })

  it('组织 admin 能常规写，但不能签发凭据（manage 只给 owner）', async () => {
    const ctx = await fixture()
    const people = await member(ctx, 'admin')

    expect(
      (
        await call(ctx, 'POST', writeUrl(ctx.project.id), {
          key: people.key,
          payload: validWrite
        })
      ).statusCode
    ).toBe(201)
    expect(
      (
        await call(ctx, 'POST', `/api/v1/members/${people.id}/keys`, {
          key: people.key,
          payload: {}
        })
      ).statusCode
    ).toBe(403)
    await ctx.db.close()
  })

  it('组织 owner 能签发凭据，但只有超级管理员能创建组织', async () => {
    const ctx = await fixture()
    const people = await member(ctx, 'owner')

    const issued = await call(ctx, 'POST', `/api/v1/members/${people.id}/keys`, {
      key: people.key,
      payload: { label: '第二把' }
    })
    expect(issued.statusCode).toBe(201)
    expect(issued.json().key).toMatch(/^vmk_/)

    expect(
      (
        await call(ctx, 'POST', '/api/v1/organizations', {
          key: people.key,
          payload: { name: '新组织' }
        })
      ).statusCode
    ).toBe(403)
    expect(
      (
        await call(ctx, 'POST', '/api/v1/organizations', {
          admin: true,
          payload: { name: '新组织' }
        })
      ).statusCode
    ).toBe(201)
    await ctx.db.close()
  })

  it('成员与项目不同组织时，不能把外人挂进项目', async () => {
    const ctx = await fixture()
    const otherOrg = await ctx.tenancy.createOrganization('别的组织')
    const outsider = await ctx.tenancy.createMember(otherOrg.id, 'out@example.com', '外人', 'owner')

    await expect(
      ctx.tenancy.setProjectMember(ctx.project.id, outsider.id, 'owner')
    ).rejects.toThrow('不属于同一组织')
    await ctx.db.close()
  })
})

describe('成员凭据', () => {
  it('只存哈希，列表接口不吐 key_hash', async () => {
    const ctx = await fixture()
    const people = await member(ctx, 'member')

    const rows = await ctx.db.all<{ key_hash: string }>('SELECT key_hash FROM member_keys')
    expect(rows).toHaveLength(1)
    expect(rows[0].key_hash).not.toContain(people.key)
    expect(rows[0].key_hash).toHaveLength(64)

    const listed = await call(ctx, 'GET', `/api/v1/members/${people.id}/keys`, { admin: true })
    expect(listed.statusCode).toBe(200)
    expect(JSON.stringify(listed.json())).not.toContain('key_hash')
    await ctx.db.close()
  })

  it('撤销后旧凭据立即失效，不用轮换全站 admin token', async () => {
    const ctx = await fixture()
    const people = await member(ctx, 'owner')

    expect((await call(ctx, 'GET', '/api/v1/me', { key: people.key })).statusCode).toBe(200)
    expect(
      (
        await call(ctx, 'DELETE', `/api/v1/members/${people.id}/keys/${people.keyId}`, {
          admin: true
        })
      ).statusCode
    ).toBe(200)
    expect((await call(ctx, 'GET', '/api/v1/me', { key: people.key })).statusCode).toBe(403)
    expect((await call(ctx, 'GET', '/api/v1/me', { admin: true })).statusCode).toBe(200)
    await ctx.db.close()
  })
})

describe('审计日志', () => {
  it('成功的写操作落审计，读到组织与操作人；GET 与失败请求不落', async () => {
    const ctx = await fixture()

    const created = await call(
      ctx,
      'POST',
      `/api/v1/organizations/${ctx.organization.id}/projects`,
      {
        admin: true,
        payload: { name: '审计项目' }
      }
    )
    expect(created.statusCode).toBe(201)
    expect(created.json().runtimeKey).toMatch(/^vsk_/)

    const rows = await ctx.db.all<{
      organization_id: number
      actor_type: string
      actor_id: number | null
      action: string
      data_json: string
    }>('SELECT * FROM audit_log')

    expect(rows).toHaveLength(1)
    expect(rows[0].organization_id).toBe(ctx.organization.id)
    expect(rows[0].actor_type).toBe('system')
    expect(rows[0].actor_id).toBeNull()
    expect(rows[0].action).toContain('/projects')

    // 审计表不能变成第二个密钥库
    expect(JSON.stringify(rows)).not.toContain('vsk_')
    expect(JSON.stringify(rows)).not.toContain(created.json().runtimeKey)

    // GET 不记
    await call(ctx, 'GET', '/api/v1/organizations', { admin: true })
    // 409 也不记：这次 preHandler **跑过了**（principal 已挂上），
    // 是业务失败，不能留下「成功的」假记录
    await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/projects`, {
      admin: true,
      payload: { name: '审计项目' }
    })
    const after = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')
    expect(Number(after?.n)).toBe(1)
    await ctx.db.close()
  })

  it('成员的操作记成 member 身份，且审计查询按组织隔离', async () => {
    const ctx = await fixture()
    const otherOrg = await ctx.tenancy.createOrganization('别的组织')
    const people = await member(ctx, 'owner')

    const issued = await call(ctx, 'POST', `/api/v1/members/${people.id}/keys`, {
      key: people.key,
      payload: { label: '审计用' }
    })
    expect(issued.statusCode).toBe(201)

    const rows = await ctx.db.all<{ actor_type: string; actor_id: number }>(
      'SELECT actor_type, actor_id FROM audit_log'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_type: 'member', actor_id: people.id })

    const own = await call(ctx, 'GET', `/api/v1/organizations/${ctx.organization.id}/audit-log`, {
      key: people.key
    })
    expect(own.statusCode).toBe(200)
    expect(own.json().entries).toHaveLength(1)

    const cross = await call(ctx, 'GET', `/api/v1/organizations/${otherOrg.id}/audit-log`, {
      key: people.key
    })
    expect(cross.statusCode).toBe(403)
    await ctx.db.close()
  })
})
