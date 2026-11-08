import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setupDb } from './helpers.js'

/**
 * 团队路由：组织级分组。
 *
 * 守的三件事：
 *   1. 读（列 / 查 / 成员列表）组织内任何人都能看
 *   2. 写（建 / 改名 / 删 / 调整成员）只有组织 owner（manage）
 *   3. 跨组织既读不到（targetOrganization 解析团队归属）也加不进（addTeamMember 校验）
 */

const ADMIN = 'super-secret-admin-token'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function fixture() {
  const ctx = await setupDb()
  const built = await buildApp({ db: ctx.db, adminToken: ADMIN })
  return { ...ctx, app: built.app }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

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

/** 造一个成员 + 一把凭据 */
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
  const { key } = await ctx.tenancy.createMemberKey(created.id, '测试凭据')
  return { id: created.id, key }
}

describe('团队路由：owner 的增删改查', () => {
  it('owner 能创建团队', async () => {
    const ctx = await fixture()
    const response = await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: '前端组', slug: 'frontend' }
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().team).toMatchObject({ name: '前端组', slug: 'frontend' })
    await ctx.db.close()
  })

  it('owner 能列出组织下的团队', async () => {
    const ctx = await fixture()
    await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: '前端组' }
    })
    const list = await call(ctx, 'GET', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().teams.length).toBe(1)
    await ctx.db.close()
  })

  it('owner 能查 / 改名 / 删团队', async () => {
    const ctx = await fixture()
    const created = await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: '前端组', slug: 'frontend' }
    })
    const teamId = created.json().team.id

    const got = await call(ctx, 'GET', `/api/v1/teams/${teamId}`, { admin: true })
    expect(got.statusCode).toBe(200)

    const renamed = await call(ctx, 'PUT', `/api/v1/teams/${teamId}`, {
      admin: true,
      payload: { name: '核心前端' }
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().team.name).toBe('核心前端')

    const deleted = await call(ctx, 'DELETE', `/api/v1/teams/${teamId}`, { admin: true })
    expect(deleted.statusCode).toBe(200)
    const gone = await call(ctx, 'GET', `/api/v1/teams/${teamId}`, { admin: true })
    expect(gone.statusCode).toBe(404)
    await ctx.db.close()
  })

  it('团队 slug 组织内唯一，改名撞车返回 409', async () => {
    const ctx = await fixture()
    await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: 'A', slug: 'team-a' }
    })
    const b = await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: 'B', slug: 'team-b' }
    })
    const rename = await call(ctx, 'PUT', `/api/v1/teams/${b.json().team.id}`, {
      admin: true,
      payload: { name: 'B', slug: 'team-a' }
    })
    expect(rename.statusCode).toBe(409)
    await ctx.db.close()
  })
})

describe('团队路由：团队成员管理', () => {
  it('owner 能把成员加进团队并列出', async () => {
    const ctx = await fixture()
    const team = await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: '前端组' }
    })
    const teamId = team.json().team.id
    const people = await member(ctx, 'member')

    const added = await call(ctx, 'POST', `/api/v1/teams/${teamId}/members`, {
      admin: true,
      payload: { memberId: people.id }
    })
    expect(added.statusCode).toBe(201)

    const list = await call(ctx, 'GET', `/api/v1/teams/${teamId}/members`, { admin: true })
    expect(list.json().members.map((m: { member_id: number }) => m.member_id)).toContain(people.id)

    const removed = await call(
      ctx,
      'DELETE',
      `/api/v1/teams/${teamId}/members/${people.id}`,
      { admin: true }
    )
    expect(removed.statusCode).toBe(200)
    const after = await call(ctx, 'GET', `/api/v1/teams/${teamId}/members`, { admin: true })
    expect(after.json().members.length).toBe(0)
    await ctx.db.close()
  })

  it('跨组织成员加不进团队（forbidden）', async () => {
    const ctx = await fixture()
    const team = await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: '前端组' }
    })
    const teamId = team.json().team.id

    const other = await ctx.tenancy.createOrganization('其他组织')
    const outsider = await ctx.tenancy.createMember(other.id, 'out@x.com', '外人', 'member')

    const response = await call(ctx, 'POST', `/api/v1/teams/${teamId}/members`, {
      admin: true,
      payload: { memberId: outsider.id }
    })
    expect(response.statusCode).toBe(403)
    await ctx.db.close()
  })
})

describe('团队路由：权限矩阵与租户隔离', () => {
  it('组织 member 与 admin 都不能创建团队（manage 仅 owner）', async () => {
    const ctx = await fixture()
    const m = await member(ctx, 'member')
    const a = await member(ctx, 'admin')

    expect(
      (
        await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
          key: m.key,
          payload: { name: 'x' }
        })
      ).statusCode
    ).toBe(403)
    expect(
      (
        await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
          key: a.key,
          payload: { name: 'x' }
        })
      ).statusCode
    ).toBe(403)
    await ctx.db.close()
  })

  it('同组织 member 能读团队，但不能改名', async () => {
    const ctx = await fixture()
    const team = await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: '前端组' }
    })
    const teamId = team.json().team.id
    const m = await member(ctx, 'member')

    expect((await call(ctx, 'GET', `/api/v1/teams/${teamId}`, { key: m.key })).statusCode).toBe(200)
    expect(
      (
        await call(ctx, 'PUT', `/api/v1/teams/${teamId}`, {
          key: m.key,
          payload: { name: '改名' }
        })
      ).statusCode
    ).toBe(403)
    await ctx.db.close()
  })

  it('跨组织成员读不到别人的团队（租户隔离）', async () => {
    const ctx = await fixture()
    const team = await call(ctx, 'POST', `/api/v1/organizations/${ctx.organization.id}/teams`, {
      admin: true,
      payload: { name: '前端组' }
    })
    const teamId = team.json().team.id

    const other = await ctx.tenancy.createOrganization('其他组织')
    const outsider = await ctx.tenancy.createMember(other.id, 'out@x.com', '外人', 'member')
    const { key } = await ctx.tenancy.createMemberKey(outsider.id, '凭据')

    expect((await call(ctx, 'GET', `/api/v1/teams/${teamId}`, { key })).statusCode).toBe(403)
    await ctx.db.close()
  })
})
