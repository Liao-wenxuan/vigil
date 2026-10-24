import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { findApp, hashToken, type AppRow } from './apps.js'

/**
 * 鉴权。
 *
 * 运行时 token 从两个地方取：
 *   - HTTP header `X-Vigil-Token`
 *   - 请求 body 的 `token` 字段
 *
 * 为什么两处都要支持：浏览器的 `navigator.sendBeacon` **不能自定义 header**，
 * SDK 在页面卸载时走 beacon 通道，token 只能放 body。
 * 走 fetch 时 token 放 header，这样它就不会出现在服务端访问日志里。
 *
 * 比较用 `timingSafeEqual` 而不是 `===`：
 * 逐字节比较的时间差可以泄漏 token 的前缀。攻击者拿到 token 前 1 字节
 * 就能靠响应时间一字节一字节试出完整 token。timingSafeEqual 的比较时间
 * 只和长度有关，不和内容有关。
 */
export type AuthResult = { ok: true; app: AppRow } | { ok: false; status: number; reason: string }

export function authenticateRuntime(
  db: Database,
  appId: string | undefined,
  token: string | undefined
): AuthResult {
  if (!appId) return { ok: false, status: 401, reason: '缺少 appId' }
  if (!token) return { ok: false, status: 401, reason: '缺少 token' }

  const app = findApp(db, appId)
  if (!app) return { ok: false, status: 401, reason: '应用不存在' }
  if (!app.enabled) return { ok: false, status: 403, reason: '应用已停用' }

  if (!safeEqual(hashToken(token), app.token_hash)) {
    return { ok: false, status: 401, reason: 'token 不匹配' }
  }

  return { ok: true, app }
}

/** 上传 sourcemap 用的鉴权 —— 用独立的上传 token */
export function authenticateUpload(
  db: Database,
  appId: string | undefined,
  token: string | undefined
): AuthResult {
  if (!appId) return { ok: false, status: 401, reason: '缺少 appId' }
  if (!token) return { ok: false, status: 401, reason: '缺少 token' }

  const app = findApp(db, appId)
  if (!app) return { ok: false, status: 401, reason: '应用不存在' }
  if (!app.enabled) return { ok: false, status: 403, reason: '应用已停用' }

  if (!safeEqual(hashToken(token), app.upload_token_hash)) {
    return { ok: false, status: 401, reason: '上传 token 不匹配' }
  }

  return { ok: true, app }
}

/**
 * 常量时间比较。
 *
 * `timingSafeEqual` 要求两个 buffer 长度相同，否则直接抛异常 ——
 * 所以先比长度（长度本身不是秘密），再用它做比较。
 */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) return false
  return crypto.timingSafeEqual(bufferA, bufferB)
}

/**
 * 管理端鉴权：查询接口用的 admin token。
 *
 * 为什么查询接口也要鉴权：错误列表里含有用户 URL、referrer、UA ——
 * 这是**能定位到人的信息**。裸奔的监控后台等于把用户画像公开。
 */
export function authenticateAdmin(
  request: { headers: Record<string, unknown> },
  adminToken: string
): AuthResult {
  const header = request.headers['x-vigil-admin-token']
  const authorization = request.headers.authorization

  let provided: string | undefined
  if (typeof header === 'string') {
    provided = header
  } else if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    provided = authorization.slice('Bearer '.length)
  }

  if (!provided) return { ok: false, status: 401, reason: '缺少管理 token' }
  if (!safeEqual(hashToken(provided), hashToken(adminToken))) {
    return { ok: false, status: 403, reason: '管理 token 不匹配' }
  }
  return { ok: true, app: undefined as unknown as AppRow }
}
