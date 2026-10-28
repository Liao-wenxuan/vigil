import { createAppFromEnv } from './app.js'
import { defaultDbPath } from './infra/db/client.js'

/**
 * 采集服务启动入口。
 *
 * 环境变量：
 *   PORT              监听端口，默认 4318
 *   HOST              监听地址，默认 0.0.0.0
 *   VIGIL_DB_PATH     数据库路径，默认 ./data/vigil.db
 *   VIGIL_ADMIN_TOKEN 管理端 token。不设置就随机生成并打印一次
 *   VIGIL_ALERT_INTERVAL 告警评估间隔（秒），默认 60；设 0 关闭
 *   LOG_LEVEL         'silent' 关闭日志
 */
const port = Number(process.env.PORT ?? 4318)
const host = process.env.HOST ?? '0.0.0.0'
const adminTokenGenerated = !process.env.VIGIL_ADMIN_TOKEN

const { app, db, evaluator } = await createAppFromEnv()

try {
  await app.listen({ port, host })
  console.log(`[vigil] 采集服务已启动 http://${host}:${port}`)
  console.log(`[vigil] 数据库 ${defaultDbPath()}`)
  if (adminTokenGenerated) {
    console.log(
      `[vigil] 管理 token（本次随机生成，重启后会变）：${process.env.VIGIL_ADMIN_TOKEN ?? ''}`
    )
  }
} catch (error) {
  app.log.error(error)
  process.exit(1)
}

// ---- 告警评估循环 ----
// 告警是**拉模型**：定时扫描规则，判断是否触发。
// 事件驱动需要在每次摄入时反查所有规则，反而更慢更贵。
const alertIntervalSeconds = Number(process.env.VIGIL_ALERT_INTERVAL ?? 60)

if (alertIntervalSeconds > 0) {
  const timer = setInterval(async () => {
    void (await evaluator
      .evaluateAll()
      .then((result) => {
        if (result.triggered > 0) {
          console.log(`[vigil] 告警评估：${result.evaluated} 条规则，触发 ${result.triggered} 次`)
        }
      })
      .catch((error) => console.error('[vigil] 告警评估失败:', error)))
  }, alertIntervalSeconds * 1000)

  // 不要因为定时器而阻止进程退出
  timer.unref?.()
}

const shutdown = async () => {
  await app.close()
  await db.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
