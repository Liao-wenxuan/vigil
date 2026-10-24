import { describe, expect, it } from 'vitest'
import { authenticateAdmin, authenticateRuntime, authenticateUpload } from '../src/auth.js'
import { setAppEnabled } from '../src/apps.js'
import { setupDb } from './helpers.js'

describe('运行时鉴权', () => {
  it('token 正确时放行', () => {
    const { db, app } = setupDb()
    const result = authenticateRuntime(db, app.appId, app.token)
    expect(result.ok).toBe(true)
    db.close()
  })

  it('token 错误时拒绝', () => {
    const { db, app } = setupDb()
    const result = authenticateRuntime(db, app.appId, 'vsk_wrong')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
    db.close()
  })

  it('应用不存在时拒绝', () => {
    const { db, app } = setupDb()
    const result = authenticateRuntime(db, 'app_not_exist', app.token)
    expect(result.ok).toBe(false)
    db.close()
  })

  it('缺 appId / token 时拒绝', () => {
    const { db } = setupDb()
    expect(authenticateRuntime(db, undefined, 'x').ok).toBe(false)
    expect(authenticateRuntime(db, 'app_x', undefined).ok).toBe(false)
    db.close()
  })

  it('应用被停用后拒绝（403 而不是 401）', () => {
    const { db, app } = setupDb()
    setAppEnabled(db, app.appId, false)
    const result = authenticateRuntime(db, app.appId, app.token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    db.close()
  })
})

describe('上传 token 与运行时 token 严格分离', () => {
  it('运行时 token 不能用来上传 sourcemap', () => {
    const { db, app } = setupDb()
    const result = authenticateUpload(db, app.appId, app.token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
    db.close()
  })

  it('上传 token 不能用来上报错误', () => {
    const { db, app } = setupDb()
    const result = authenticateRuntime(db, app.appId, app.uploadToken)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
    db.close()
  })

  it('上传 token 能上传 sourcemap', () => {
    const { db, app } = setupDb()
    const result = authenticateUpload(db, app.appId, app.uploadToken)
    expect(result.ok).toBe(true)
    db.close()
  })
})

describe('管理端鉴权', () => {
  it('正确 token 放行', () => {
    const result = authenticateAdmin(
      { headers: { 'x-vigil-admin-token': 'admin_123' } },
      'admin_123'
    )
    expect(result.ok).toBe(true)
  })

  it('Bearer 形式也支持', () => {
    const result = authenticateAdmin(
      { headers: { authorization: 'Bearer admin_123' } },
      'admin_123'
    )
    expect(result.ok).toBe(true)
  })

  it('错误 token 拒绝', () => {
    const result = authenticateAdmin({ headers: { 'x-vigil-admin-token': 'wrong' } }, 'admin_123')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('缺 token 拒绝', () => {
    const result = authenticateAdmin({ headers: {} }, 'admin_123')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })
})
