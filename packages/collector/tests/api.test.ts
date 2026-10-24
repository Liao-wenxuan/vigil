import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeEvent, setupDb } from './helpers.js'

const ADMIN_TOKEN = 'admin_test_token'

function makeServer(overrides: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const { db, app } = setupDb()
  const server = buildApp({ db, adminToken: ADMIN_TOKEN, ...overrides })
  return { db, app, server }
}

describe('POST /api/v1/collect', () => {
  it('缺 token 时 401', async () => {
    const { db, app, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      payload: { appId: app.appId, events: [makeEvent()] }
    })
    expect(response.statusCode).toBe(401)
    db.close()
  })

  it('token 错误时 401', async () => {
    const { db, app, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-token': 'vsk_wrong' },
      payload: { appId: app.appId, events: [makeEvent()] }
    })
    expect(response.statusCode).toBe(401)
    db.close()
  })

  it('header 带 token 时上报成功并入库', async () => {
    const { db, app, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-token': app.token },
      payload: { appId: app.appId, events: [makeEvent()] }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(1)

    const row = db.prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ?').get(app.appId) as {
      n: number
    }
    expect(row.n).toBe(1)
    db.close()
  })

  it('beacon 通道：token 放在 body 里也能上报', async () => {
    const { db, app, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      payload: { appId: app.appId, token: app.token, events: [makeEvent()] }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(1)
    db.close()
  })

  it('超出频率限制返回 429', async () => {
    const { db, app, server } = makeServer({
      rateLimit: { capacity: 1, refillPerSecond: 0 }
    })

    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-token': app.token },
      payload: { appId: app.appId, events: [makeEvent()] }
    })
    expect(first.statusCode).toBe(200)

    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-token': app.token },
      payload: { appId: app.appId, events: [makeEvent()] }
    })
    expect(second.statusCode).toBe(429)
    db.close()
  })

  it('events 为空数组时 400（schema 校验拦住）', async () => {
    const { db, app, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-token': app.token },
      payload: { appId: app.appId, events: [] }
    })
    expect(response.statusCode).toBe(400)
    db.close()
  })
})

describe('CORS', () => {
  it('预检请求返回允许跨域的响应头（没有它浏览器会直接拦掉上报）', async () => {
    const { db, server } = makeServer()
    const response = await server.inject({ method: 'OPTIONS', url: '/api/v1/collect' })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.headers['access-control-allow-headers']).toContain('X-Vigil-Token')
    db.close()
  })

  it('上报响应也带 CORS 头', async () => {
    const { db, app, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { origin: 'https://app.example.com' },
      payload: { appId: app.appId, token: app.token, events: [makeEvent()] }
    })
    expect(response.headers['access-control-allow-origin']).toBe('*')
    db.close()
  })
})

describe('管理接口', () => {
  it('创建应用时返回两个 token（只此一次可见）', async () => {
    const { db, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/apps',
      headers: { 'x-vigil-admin-token': ADMIN_TOKEN },
      payload: { name: '新应用' }
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.token).toMatch(/^vsk_/)
    expect(body.uploadToken).toMatch(/^vup_/)
    expect(body.token).not.toBe(body.uploadToken)
    db.close()
  })

  it('创建应用需要 admin token', async () => {
    const { db, server } = makeServer()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/apps',
      payload: { name: '新应用' }
    })
    expect(response.statusCode).toBe(401)
    db.close()
  })

  it('查询错误列表需要 admin token', async () => {
    const { db, app, server } = makeServer()
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.appId}/errors`
    })
    expect(response.statusCode).toBe(401)
    db.close()
  })

  it('上报后能查到错误列表和统计', async () => {
    const { db, app, server } = makeServer()

    await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-token': app.token },
      payload: { appId: app.appId, events: [makeEvent({ fingerprint: 'fp_list' })] }
    })

    const list = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.appId}/errors`,
      headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().total).toBe(1)
    expect(list.json().errors[0].fingerprint).toBe('fp_list')

    const stats = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.appId}/stats`,
      headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
    })
    expect(stats.statusCode).toBe(200)
    expect(stats.json().totals.distinct_errors).toBe(1)
    expect(stats.json().totals.occurrences).toBe(1)
    db.close()
  })

  it('能查到错误详情（含最近事件）', async () => {
    const { db, app, server } = makeServer()

    await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-token': app.token },
      payload: { appId: app.appId, events: [makeEvent({ fingerprint: 'fp_detail' })] }
    })

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/${app.appId}/errors/fp_detail`,
      headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().error.fingerprint).toBe('fp_detail')
    expect(detail.json().events.length).toBe(1)
    db.close()
  })

  it('多应用隔离：A 应用查不到 B 应用的错误', async () => {
    const { db, app: appA, server } = makeServer()
    const { createApp } = await import('../src/apps.js')
    const appB = createApp(db, '另一个应用')

    await server.inject({
      method: 'POST',
      url: '/api/v1/collect',
      headers: { 'x-vigil-app-id': appA.appId, 'x-vigil-token': appA.token },
      payload: { appId: appA.appId, events: [makeEvent({ fingerprint: 'fp_x' })] }
    })

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/${appB.appId}/errors`,
      headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
    })
    expect(response.json().total).toBe(0)
    db.close()
  })
})

describe('sourcemap 上传', () => {
  it('用上传 token 能上传，用运行时 token 不能', async () => {
    const { db, app, server } = makeServer()
    const payload = {
      appId: app.appId,
      release: '1.0.0',
      files: [
        {
          fileName: 'assets/index.js',
          sourceMap: '{"version":3,"sources":[],"names":[],"mappings":""}'
        }
      ]
    }

    const withRuntimeToken = await server.inject({
      method: 'POST',
      url: '/api/v1/sourcemaps',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-upload-token': app.token },
      payload
    })
    expect(withRuntimeToken.statusCode).toBe(401)

    const withUploadToken = await server.inject({
      method: 'POST',
      url: '/api/v1/sourcemaps',
      headers: { 'x-vigil-app-id': app.appId, 'x-vigil-upload-token': app.uploadToken },
      payload
    })
    expect(withUploadToken.statusCode).toBe(200)
    expect(withUploadToken.json().uploaded).toBe(1)
    db.close()
  })
})

describe('健康检查', () => {
  it('GET /api/health 返回 ok', async () => {
    const { db, server } = makeServer()
    const response = await server.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(true)
    db.close()
  })
})
