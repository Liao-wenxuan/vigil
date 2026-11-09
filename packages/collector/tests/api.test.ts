import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/infra/db/client.js'
import { TenancyService, slugify } from '../src/domains/tenancy/service.js'
import { fp, makeEvent } from './helpers.js'

const ADMIN = 'admin_test_token'

async function setup() {
  const db = await openDb(':memory:')
  const tenancy = new TenancyService(db)
  const organization = await tenancy.createOrganization('测试组织')
  const created = await tenancy.createProject({ organizationId: organization.id, name: '测试应用' })
  const built = await buildApp({ db, adminToken: ADMIN })

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
      const { app } = await setup()
      const response = await app.inject({ method: 'GET', url: '/api/health' })
      expect(response.statusCode).toBe(200)
      expect(response.json().ok).toBe(true)
    })
  })

  describe('摄入', () => {
    it('缺密钥 → 401', async () => {
      const { app, project } = await setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        payload: { appId: project.slug, events: [makeEvent()] }
      })
      expect(response.statusCode).toBe(401)
    })

    it('密钥无效 → 401', async () => {
      const { app, project } = await setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': 'vsk_wrong' },
        payload: { appId: project.slug, events: [makeEvent()] }
      })
      expect(response.statusCode).toBe(401)
    })

    it('带密钥上报成功并入库', async () => {
      const { app, db, project, runtimeKey } = await setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': runtimeKey },
        payload: { appId: project.slug, events: [makeEvent({ fingerprint: fp('api') })] }
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().accepted).toBe(1)

      const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')
      expect(row?.n).toBe(1)
    })

    it('上传密钥不能用于上报（两把密钥严格分离）', async () => {
      const { app, project, uploadKey } = await setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': uploadKey },
        payload: { appId: project.slug, events: [makeEvent()] }
      })
      expect(response.statusCode).toBe(403)
    })

    it('运行时密钥不能用于上传 sourcemap（密钥有效但类型不对 → 403）', async () => {
      const { app, project, runtimeKey } = await setup()
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
      const { app, db, project, uploadKey } = await setup()
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
      const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sourcemaps')
      expect(row?.n).toBe(1)
    })

    it('性能事务上报', async () => {
      const { app, db, project, runtimeKey } = await setup()
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
      const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')
      expect(row?.n).toBe(1)
    })

    it('CORS 预检返回允许跨域的响应头', async () => {
      const { app } = await setup()
      const response = await app.inject({ method: 'OPTIONS', url: '/api/v1/collect' })

      expect(response.statusCode).toBe(204)
      expect(response.headers['access-control-allow-origin']).toBe('*')
      expect(response.headers['access-control-allow-headers']).toContain('X-Vigil-Token')
    })
  })

  describe('租户隔离', () => {
    /**
     * 跨租户访问必须被挡住。
     *
     * ⚠️ 这些断言盯的是**范围条件**，不是「有没有报错」——
     *    漏一个 `AND project_id = ?` 往往不报错，只是把别的项目的数据返回了。
     */
    it('不能用别的项目的路径读自己的 issue', async () => {
      const { app, project, runtimeKey, tenancy, organization } = await setup()

      await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': runtimeKey },
        payload: { appId: project.slug, events: [makeEvent({ fingerprint: fp('tenant') })] }
      })

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`,
        headers: adminHeader
      })
      const issueId = list.json().issues[0].id

      // 另一个项目
      const other = await tenancy.createProject({
        organizationId: organization.id,
        name: '别的项目'
      })

      const cross = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${other.project.id}/issues/${issueId}`,
        headers: adminHeader
      })
      expect(cross.statusCode).toBe(404)
    })

    it('不能用别的项目的路径改自己的 issue', async () => {
      const { app, project, runtimeKey, tenancy, organization } = await setup()

      await app.inject({
        method: 'POST',
        url: '/api/v1/collect',
        headers: { 'x-vigil-token': runtimeKey },
        payload: { appId: project.slug, events: [makeEvent({ fingerprint: fp('tenant2') })] }
      })

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`,
        headers: adminHeader
      })
      const issueId = list.json().issues[0].id

      const other = await tenancy.createProject({
        organizationId: organization.id,
        name: '别的项目2'
      })

      const cross = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${other.project.id}/issues/${issueId}/resolve`,
        headers: adminHeader,
        payload: { release: '1.0.0' }
      })
      expect(cross.statusCode).toBe(404)

      // 原项目里的 issue 不该被改掉
      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues/${issueId}`,
        headers: adminHeader
      })
      expect(after.json().issue.status).toBe('unresolved')
    })

    it('不能用别的项目的路径改别人的告警规则', async () => {
      const { app, project, tenancy, organization } = await setup()

      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/alert-rules`,
        headers: adminHeader,
        payload: { name: '规则', type: 'issue.new', threshold: 1, windowSeconds: 300 }
      })
      const ruleId = created.json().rule.id

      const other = await tenancy.createProject({
        organizationId: organization.id,
        name: '别的项目3'
      })

      const cross = await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${other.project.id}/alert-rules/${ruleId}`,
        headers: adminHeader,
        payload: { enabled: false }
      })
      expect(cross.statusCode).toBe(404)

      // 原项目的规则不该被改掉
      const rules = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/alert-rules`,
        headers: adminHeader
      })
      expect(rules.json().rules[0].enabled).toBe(true)
    })
  })

  describe('SLO 与错误预算', () => {
    it('能创建 SLO 并读到当前状态', async () => {
      const { app, project } = await setup()

      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/slos`,
        headers: adminHeader,
        payload: { name: '可用性', target: 0.999, windowSeconds: 3600, stepSeconds: 600 }
      })
      expect(created.statusCode).toBe(201)
      const sloId = created.json().slo.id
      expect(created.json().slo.target).toBe(0.999)

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/slos/${sloId}`,
        headers: adminHeader
      })
      expect(detail.statusCode).toBe(200)
      // 没有流量 → SLI 是 null，不是 1
      expect(detail.json().evaluation.sli).toBeNull()
      expect(detail.json().evaluation.status).toBe('healthy')
      // 多窗口燃烧率也在同一份响应里
      expect(detail.json().burnRates).toHaveLength(4)

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/slos`,
        headers: adminHeader
      })
      expect(list.statusCode).toBe(200)
      expect(list.json().slos).toHaveLength(1)
      expect(list.json().slos[0].evaluation).toBeDefined()
    })

    it('目标值非法 → 400', async () => {
      const { app, project } = await setup()
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/slos`,
        headers: adminHeader,
        payload: { name: 'x', target: 2, windowSeconds: 3600 }
      })
      expect(res.statusCode).toBe(400)
    })

    it('参数不合法返回 400 而不是 500', async () => {
      // ⚠️ 回归测试：Fastify 的 schema 校验错误不是 AppError，
      //    不接住的话客户端传错参数会收到 500，
      //    而且会被当成内部错误刷进日志 —— 告警被噪声淹没。
      const { app, project } = await setup()
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/slos`,
        headers: adminHeader,
        // 缺 name 与 target
        payload: { windowSeconds: 3600 }
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().ok).toBe(false)
    })

    it('跨项目读不到 SLO', async () => {
      const { app, project, tenancy, organization } = await setup()
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/slos`,
        headers: adminHeader,
        payload: { name: 'x', target: 0.99, windowSeconds: 3600 }
      })
      const sloId = created.json().slo.id

      const other = await tenancy.createProject({
        organizationId: organization.id,
        name: '别的项目'
      })
      const cross = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${other.project.id}/slos/${sloId}`,
        headers: adminHeader
      })
      expect(cross.statusCode).toBe(404)
    })
  })

  describe('管理接口', () => {
    it('缺 admin token → 401', async () => {
      const { app, project } = await setup()
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`
      })
      expect(response.statusCode).toBe(401)
    })

    it('admin token 不匹配 → 403', async () => {
      const { app, project } = await setup()
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}/issues`,
        headers: { 'x-vigil-admin-token': 'wrong' }
      })
      expect(response.statusCode).toBe(403)
    })

    it('创建项目返回两把密钥（只此一次可见）', async () => {
      const { app, organization } = await setup()
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
      const { app, project, runtimeKey } = await setup()

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
      const { app, project, runtimeKey } = await setup()

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
      const { app, project } = await setup()

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
      const { app, project } = await setup()
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

/**
 * 创建组织 / 项目的管理接口。
 *
 * 这一组守的是「不做手工 SQL 也能初始化一个 PG 部署」：
 * 容器里 CLI 连错库是静默的，管理 API 必须是唯一可信的入口。
 */
describe('创建组织与项目（管理接口）', () => {
  it('POST /organizations 创建后能列出来', async () => {
    const { app } = await setup()

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: adminHeader,
      payload: { name: '线上组织' }
    })
    expect(created.statusCode).toBe(201)
    const org = created.json().organization
    expect(org.id).toBeGreaterThan(0)
    expect(org.name).toBe('线上组织')
    expect(org.slug).toBeTruthy()

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: adminHeader
    })
    expect(list.json().organizations.some((o: { id: number }) => o.id === org.id)).toBe(true)
  })

  it('同名组织重复创建是幂等的，不产生第二行', async () => {
    const { app } = await setup()

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: adminHeader,
      payload: { name: '同名组织' }
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: adminHeader,
      payload: { name: '同名组织' }
    })

    expect(second.json().organization.id).toBe(first.json().organization.id)
  })

  it('缺 name 返回 400，不带 admin token 返回 401', async () => {
    const { app } = await setup()

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: adminHeader,
      payload: {}
    })
    expect(invalid.statusCode).toBe(400)

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      payload: { name: '不该被创建' }
    })
    // 没带 token = 401（未认证）；带了但不对 = 403（没权限）。
    // 这两个码别写反，网关层会按它区分「要弹登录」还是「要拒绝」。
    expect(unauthorized.statusCode).toBe(401)
  })

  it('REST 创建的项目，返回的 runtimeKey 立刻能上报并查到 issue', async () => {
    const { app } = await setup()

    const org = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: adminHeader,
      payload: { name: '端到端组织' }
    })
    const project = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${org.json().organization.id}/projects`,
      headers: adminHeader,
      payload: { name: '端到端应用' }
    })
    expect(project.statusCode).toBe(201)
    const { runtimeKey } = project.json()
    expect(runtimeKey).toMatch(/^vsk_/)
    const slug = project.json().project.slug

    const ingest = await app.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-key': runtimeKey },
      payload: {
        appId: slug,
        token: runtimeKey,
        events: [makeEvent({ fingerprint: fp('rest-created-project') })]
      }
    })
    expect(ingest.statusCode).toBe(200)
    expect(ingest.json().accepted).toBe(1)

    const issues = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.json().project.id}/issues`,
      headers: adminHeader
    })
    expect(issues.json().total).toBe(1)
    expect(issues.json().issues[0].fingerprint).toBe(fp('rest-created-project'))
  })
})

describe('中文名 slug 转写', () => {
  it('纯中文转成拼音连字符，不再留中文', () => {
    expect(slugify('线上应用')).toBe('xian-shang-ying-yong')
    expect(slugify('购物小程序')).toBe('gou-wu-xiao-cheng-xu')
  })

  it('中英混排不会把英文单词拆成单字母', () => {
    // pinyin-pro 的 type:'array' 会把 "Vue3" 拆成 V/u/e/3 —— 逐字转汉字才不会
    expect(slugify('Vue3 项目')).toBe('vue3-xiang-mu')
  })

  it('原有英文行为保持不变（大小写 / 符号 / 首尾裁切）', () => {
    expect(slugify('  My Cool App!  ')).toBe('my-cool-app')
    expect(slugify('Release 1.4.2')).toBe('release-1-4-2')
  })

  it('全符号或空串 → 稳定的 ASCII 回退，不会返回空 slug', () => {
    expect(slugify('!!!')).toMatch(/^project-[a-z0-9]+$/)
    expect(slugify('')).toMatch(/^project-[a-z0-9]+$/)
  })

  it('各种中文名生成的 slug 全是 ASCII（可直接当 appId / 放进 URL）', () => {
    for (const name of ['接口验证-线上', '内容 平台 v2', '前端组', '日本語テスト']) {
      expect(slugify(name)).toMatch(/^[a-z0-9-]+$/)
      expect(slugify(name).length).toBeGreaterThan(0)
    }
  })

  it('REST 建中文名项目：slug 是拼音，且立刻能拿它上报', async () => {
    const { app } = await setup()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/1/projects',
      headers: adminHeader,
      payload: { name: '中文演示应用' }
    })
    expect(created.statusCode).toBe(201)
    const slug: string = created.json().project.slug
    expect(slug).toBe('zhong-wen-yan-shi-ying-yong')

    const ingest = await app.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-key': created.json().runtimeKey },
      payload: {
        appId: slug,
        token: created.json().runtimeKey,
        events: [makeEvent({ fingerprint: fp('chinese-slug') })]
      }
    })
    expect(ingest.statusCode).toBe(200)
    expect(ingest.json().accepted).toBe(1)
  })
})
