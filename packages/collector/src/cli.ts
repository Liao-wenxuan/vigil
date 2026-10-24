import { createApp, listApps, setAppEnabled } from './apps.js'
import { createDb, defaultDbPath } from './db.js'

/**
 * 应用管理 CLI。
 *
 *   npm --prefix packages/collector run app:create -- create "我的应用"
 *   npm --prefix packages/collector run app:create -- list
 *   npm --prefix packages/collector run app:create -- disable <appId>
 *
 * 直接操作数据库文件，不需要 Collector 在跑 —— 初始化流程更短。
 * （管理接口 POST /api/v1/apps 是等价的另一条路，给 Dashboard 用。）
 */
const [command, ...args] = process.argv.slice(2)

if (!command || command === 'help' || command === '--help') {
  console.log(`用法：
  create <名称>     创建应用，输出 appId / runtime token / upload token
  list               列出所有应用
  enable <appId>    启用应用
  disable <appId>   停用应用

环境变量 VIGIL_DB_PATH 指定数据库路径（默认 ./data/vigil.db）`)
  process.exit(command ? 0 : 1)
}

const db = createDb(defaultDbPath())

try {
  switch (command) {
    case 'create': {
      const name = args[0]
      if (!name) {
        console.error('缺少应用名称')
        process.exit(1)
      }
      const created = createApp(db, name)
      console.log('应用创建成功：')
      console.log(`  appId       ${created.appId}`)
      console.log(`  name        ${created.name}`)
      console.log(`  token       ${created.token}`)
      console.log(`  uploadToken ${created.uploadToken}`)
      console.log('')
      console.log('⚠️  两个 token 只显示这一次，数据库里只存哈希。')
      console.log('   token      运行时用，会进前端代码')
      console.log('   uploadToken 只放在 CI 里，用于上传 sourcemap')
      break
    }

    case 'list': {
      const apps = listApps(db)
      if (apps.length === 0) {
        console.log('还没有应用。用 `create <名称>` 建一个。')
        break
      }
      console.log('appId                    name                 enabled  created')
      for (const app of apps) {
        console.log(
          `${app.app_id.padEnd(24)} ${String(app.name).padEnd(20)} ${String(Boolean(app.enabled)).padEnd(8)} ${new Date(app.created_at).toISOString()}`
        )
      }
      break
    }

    case 'enable':
    case 'disable': {
      const appId = args[0]
      if (!appId) {
        console.error('缺少 appId')
        process.exit(1)
      }
      const changed = setAppEnabled(db, appId, command === 'enable')
      if (!changed) {
        console.error(`应用不存在：${appId}`)
        process.exit(1)
      }
      console.log(`应用 ${appId} 已${command === 'enable' ? '启用' : '停用'}`)
      break
    }

    default:
      console.error(`未知命令：${command}`)
      process.exit(1)
  }
} finally {
  db.close()
}
