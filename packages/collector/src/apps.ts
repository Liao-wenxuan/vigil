import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'

/**
 * 应用（接入方）管理。
 *
 * 一个 app 对应：
 *   - **运行时 token**：嵌在网页里，用于上报。安全性要求是「别被乱用」，
 *     所以它可以出现在前端代码里 —— 但不能因此放松服务端校验。
 *   - **上传 token**：只存在于 CI 里，用于上传 sourcemap。
 *     绝对不能进浏览器 —— 拿到了它就能上传任意 sourcemap，
 *     进而污染别人应用的错误栈。
 *
 * 两个 token 分开，是「多应用可接入」这个需求的必然要求：
 * 不同应用的 CI 不该共享凭证。
 *
 * **数据库里只存哈希**，不存明文。数据库文件泄露不等于所有应用的 token 泄露。
 */

export interface AppRow {
  app_id: string
  name: string
  token_hash: string
  upload_token_hash: string
  enabled: number
  created_at: number
  last_seen_at: number | null
}

export interface CreatedApp {
  appId: string
  name: string
  /** 运行时 token —— 只在这里返回一次，之后查不到了 */
  token: string
  /** 上传 token —— 只在这里返回一次 */
  uploadToken: string
  createdAt: number
}

/** 生成 token：前缀让人一眼看出用途，随机部分保证不可猜 */
export function generateToken(prefix: 'vsk' | 'vup'): string {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`
}

/** token 哈希 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

export function createApp(db: Database, name: string): CreatedApp {
  const appId = `app_${crypto.randomBytes(6).toString('hex')}`
  const token = generateToken('vsk')
  const uploadToken = generateToken('vup')
  const createdAt = Date.now()

  db.prepare(
    `INSERT INTO apps (app_id, name, token_hash, upload_token_hash, enabled, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(appId, name, hashToken(token), hashToken(uploadToken), createdAt)

  return { appId, name, token, uploadToken, createdAt }
}

export function findApp(db: Database, appId: string): AppRow | undefined {
  return db.prepare('SELECT * FROM apps WHERE app_id = ?').get(appId) as AppRow | undefined
}

export function listApps(
  db: Database
): Array<Pick<AppRow, 'app_id' | 'name' | 'enabled' | 'created_at' | 'last_seen_at'>> {
  return db
    .prepare(
      `SELECT app_id, name, enabled, created_at, last_seen_at FROM apps ORDER BY created_at DESC`
    )
    .all() as Array<Pick<AppRow, 'app_id' | 'name' | 'enabled' | 'created_at' | 'last_seen_at'>>
}

export function setAppEnabled(db: Database, appId: string, enabled: boolean): boolean {
  const result = db
    .prepare('UPDATE apps SET enabled = ? WHERE app_id = ?')
    .run(enabled ? 1 : 0, appId)
  return result.changes > 0
}

export function touchApp(db: Database, appId: string): void {
  db.prepare('UPDATE apps SET last_seen_at = ? WHERE app_id = ?').run(Date.now(), appId)
}
