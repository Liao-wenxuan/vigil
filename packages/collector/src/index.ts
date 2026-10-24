import crypto from 'node:crypto'
import { buildApp } from './app.js'
import { createDb, defaultDbPath } from './db.js'

/**
 * 采集服务启动入口。
 *
 * 环境变量：
 *   PORT              监听端口，默认 4318
 *   HOST              监听地址，默认 0.0.0.0
 *   VIGIL_DB_PATH     数据库路径，默认 ./data/vigil.db
 *   VIGIL_ADMIN_TOKEN 管理端 token。不设置就随机生成并打印一次
 *   LOG_LEVEL         'silent' 关闭日志
 */
const port = Number(process.env.PORT ?? 4318)
const host = process.env.HOST ?? '0.0.0.0'
const dbPath = defaultDbPath()

const db = createDb(dbPath)

// 管理 token 没配就随机生成 —— 绝不退化成「默认口令」。
// 监控后台里的错误列表含用户 URL、UA、referrer，是能定位到人的信息。
const adminToken = process.env.VIGIL_ADMIN_TOKEN ?? crypto.randomBytes(24).toString('hex')
const adminTokenGenerated = !process.env.VIGIL_ADMIN_TOKEN

const app = buildApp({
  db,
  adminToken,
  logger: process.env.LOG_LEVEL !== 'silent'
})

try {
  await app.listen({ port, host })
  console.log(`[vigil] 采集服务已启动 http://${host}:${port}`)
  console.log(`[vigil] 数据库 ${dbPath}`)
  if (adminTokenGenerated) {
    console.log(`[vigil] 管理 token（本次随机生成，重启后会变）：${adminToken}`)
  }
} catch (error) {
  app.log.error(error)
  process.exit(1)
}

const shutdown = async () => {
  await app.close()
  db.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
