import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/infra/db/client.js'
import { TenancyService } from '../src/domains/tenancy/service.js'
import { fp, makeEvent } from './helpers.js'

const ADMIN = 'admin_test_token'

function setup() {
  const db = openDb(':memory:')
  const tenancy = new TenancyService(db)
  const organization = tenancy.createOrganization('测试组织')
  const created = tenancy.createProject({ organizationId: organization.id, name: '测试应用' })
  const built = buildApp({ db, adminToken: ADMIN })

  return {
    db,
    built,
    app: built.app,
    tenancy,
    organization,
    project: created.project,
    runtimeKey: created.runtimeKey,
    uploadKey: created.uploadKey
  }
}

const adminHeader = { 'x-vigil-admin-token': ADMIN }

describe('HTTP 接口', () => {
  describe('健康检查', () => {
    it('GET /api/health 返回 ok', async () => {
      const { app } = setup()
      const response = await app.inject({ method: 'GET', url: '/api/health' })
      expect(response.statusCode).toBe(200)
      expect(response.json().ok).toBe(true)
    })
  })

  describe('摄入', () => {
    it('缺密钥 → 401', async () => {
      const { app, project } = setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        payload: { appId: project.slug, events: [makeEvent()] }
      })
      expect(response.statusCode).toBe(401)
    })

    it('密钥无效 → 401', async () => {
      const { app, project } = setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': 'vsk_wrong' },
        payload: { appId: project.slug, events: [makeEvent()] }
      })
      expect(response.statusCode).toBe(401)
    })

    it('带密钥上报成功并入库', async () => {
      const { app, db, project, runtimeKey } = setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': runtimeKey },
        payload: { appId: project.slug, events: [makeEvent({ fingerprint: fp('api') })] }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().accepted).toBe(1)

      const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')
      expect(row?.n).toBe(1)
    })

    it('上传密钥不能用于上报（两把密钥严格分离）', async () => {
      const { app, project, uploadKey } = setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': uploadKey },
        payload: { appId: project.slug, events: [makeEvent()] }
      })
      expect(response.statusCode).toBe(403)
    })

    it('运行时密钥不能用于上传 sourcemap（密钥有效但类型不对 → 403）', async () => {
      const { app, project, runtimeKey } = setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sourcemaps',
        headers: { 'x-vigil-token': runtimeKey },
        payload: {
          appId: project.slug,
          release: '1.0.0',
          files: [{ fileName: 'a.js', sourceMap: '{"version":3}' }]
        }
      })
      expect(response.statusCode).toBe(403)
    })

    it('上传密钥能上传 sourcemap', async () => {
      const { app, db, project, uploadKey } = setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sourcemaps',
        headers: { 'x-vigil-token': uploadKey },
        payload: {
          appId: project.slug,
          release: '1.0.0',
          files: [
            { fileName: 'a.js', sourceMap: '{"version":3,"sources":[],"names":[],"mappings":""}' }
          ]
        }
      })

      expect(response.statusCode).toBe(200)
      const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sourcemaps')
      expect(row?.n).toBe(1)
    })

    it('性能事务上报', async () => {
      const { app, db, project, runtimeKey } = setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/performance',
        headers: { 'x-vigil-token': runtimeKey },
        payload: {
          appId: project.slug,
          transactions: [
            {
              name: '/checkout',
              type: 'page',
              startedAt: Date.now(),
              durationMs: 1200,
              vitals: { lcp: 1500 },
              pageUrl: 'https://a.com/checkout',
              userAgent: 'test',
              sessionId: 's1'
            }
          ]
        }
      })

      expect(response.statusCode).toBe(200)
      const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')
      expect(row?.n).toBe(1)
    })

    it('CORS 预检返回允许跨域的响应头', async () => {
      const { app } = setup()
      const response = await app.inject({ method: 'OPTIONS', url: '/api/v1/collect' })

      expect(response.statusCode).toBe(204)
      expect(response.headers['access-control-allow-origin']).toBe('*')
      expect(response.headers['access-control-allow-headers']).toContain('X-Vigil-Token')
    })
  })

  describe('管理接口', () => {
    it('缺 admin token → 401', async () => {
      const { app, project } = setup()
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`
      })
      expect(response.statusCode).toBe(401)
    })

    it('admin token 不匹配 → 403', async () => {
      const { app, project } = setup()
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`,
        headers: { 'x-vigil-admin-token': 'wrong' }
      })
      expect(response.statusCode).toBe(403)
    })

    it('创建项目返回两把密钥（只此一次可见）', async () => {
      const { app, organization } = setup()
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: adminHeader,
        payload: { name: '新应用' }
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.runtimeKey).toMatch(/^vsk_/)
      expect(body.uploadKey).toMatch(/^vup_/)
      expect(body.runtimeKey).not.toBe(body.uploadKey)
    })

    it('能查 Issue 列表与详情', async () => {
      const { app, project, runtimeKey } = setup()

      await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': runtimeKey },
        payload: { appId: project.slug, events: [makeEvent({ fingerprint: fp('list') })] }
      })

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`,
        headers: adminHeader
      })
      expect(list.statusCode).toBe(200)
      expect(list.json().total).toBe(1)

      const issueId = list.json().issues[0].id
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues/${issueId}`,
        headers: adminHeader
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json().issue.fingerprint).toBe(fp('list'))
    })

    it('能解决 Issue（Resolve with Release）', async () => {
      const { app, project, runtimeKey } = setup()

      await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': runtimeKey },
        payload: { appId: project.slug, events: [makeEvent({ fingerprint: fp('resolve') })] }
      })

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`,
        headers: adminHeader
      })
      const issueId = list.json().issues[0].id

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/issues/${issueId}/resolve`,
        headers: adminHeader,
        payload: { release: '1.4.3' }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().issue.status).toBe('resolved')
      expect(response.json().issue.resolvedInRelease).toBe('1.4.3')
    })

    it('告警规则能创建和查询', async () => {
      const { app, project } = setup()

      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/alert-rules`,
        headers: adminHeader,
        payload: { name: '错误过多', type: 'issue.count', threshold: 10, windowSeconds: 300 }
      })
      expect(created.statusCode).toBe(201)
      expect(created.json().rule.threshold).toBe(10)

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/alert-rules`,
        headers: adminHeader
      })
      expect(list.json().rules).toHaveLength(1)
    })

    it('性能汇总接口可用', async () => {
      const { app, project } = setup()
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/performance`,
        headers: adminHeader
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().summary.transactions).toBe(0)
    })
  })
})
