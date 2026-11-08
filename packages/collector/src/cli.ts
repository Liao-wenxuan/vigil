import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './infra/db/client.js'
import { openPostgres } from './infra/db/postgres.js'
import { TenancyService } from './domains/tenancy/service.js'

/**
 * 管理命令行。
 *
 *   npm --prefix packages/collector run cli -- org create "我的组织"
 *   npm --prefix packages/collector run cli -- project create 1 "我的应用"
 *   npm --prefix packages/collector run cli -- env add 1 production "生产环境" --production
 *   npm --prefix packages/collector run cli -- release add 1 1.4.2
 *   npm --prefix packages/collector run cli -- list
 *
 * 直接连库（SQLite 文件或 PostgreSQL），不需要 Collector 在跑 ——
 * 初始化流程更短。容器里用不了 CLI 的话，也可以直接调管理 API：
 *   POST /api/v1/organizations
 *   POST /api/v1/organizations/:id/projects
 */
const args = process.argv.slice(2)
const command = args[0]
const sub = args[1]

const argValue = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 ? args[index + 1] : fallback
}

/**
 * 仓库根目录。
 *
 * ⚠️ 数据库路径**必须**相对仓库根解析，不能用相对 CWD 的路径 ——
 *    `npm --prefix packages/collector run cli` 的 CWD 是 packages/collector，
 *    相对路径会指向 packages/collector/data/vigil.db —— 一个空库。
 *    症状是「CLI 查出来什么都没有」，但采集服务那边数据好好的，
 *    极难联想到是路径问题。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const dbPath =
  argValue('db') ?? process.env.VIGIL_DB_PATH ?? path.join(REPO_ROOT, 'data', 'vigil.db')

/**
 * ⚠️ PostgreSQL 部署必须走 DATABASE_URL。
 *
 * 之前这里无条件 `openDb(dbPath)`：容器里设了 DATABASE_URL，
 * CLI 却照样新建一个空的 SQLite 文件，打印「组织已创建」「密钥如下」，
 * 而采集服务读的是 PG —— 一条都看不到，全程不报错。
 * 静默写错库比直接失败难查十倍，所以优先认连接串。
 *
 * openPostgres 默认会跑一次迁移（幂等），这样即使 Collector 还没启动过，
 * CLI 也能独立完成初始化。
 */
const databaseUrl = process.env.DATABASE_URL
const db = databaseUrl ? await openPostgres(databaseUrl) : await openDb(dbPath)
const tenancy = new TenancyService(db)

function printUsage(): void {
  console.log(`用法：
  org create <名称>                     创建组织
  org list                              列出组织
  project create <组织ID> <名称>        创建项目（输出两把密钥）
  project list <组织ID>                 列出项目
  env add <项目ID> <slug> <名称> [--production]
  release add <项目ID> <版本> [commitSha]
  list                                  列出组织与项目

环境变量：
  DATABASE_URL       PostgreSQL 连接串。设了就走 PG（容器部署必须设）
  VIGIL_DB_PATH      SQLite 文件路径（默认 ./data/vigil.db）
  --db <路径>        命令行覆盖 SQLite 路径，优先级最高`)
}

try {
  switch (command) {
    case 'org': {
      if (sub === 'create') {
        const name = args[2]
        if (!name) {
          console.error('缺少组织名称')
          process.exit(1)
        }
        const organization = await tenancy.createOrganization(name)
        console.log(
          `组织已创建：id=${organization.id} slug=${organization.slug} name=${organization.name}`
        )
      } else if (sub === 'list') {
        for (const org of await tenancy.listOrganizations()) {
          console.log(`${org.id}\t${org.slug}\t${org.name}`)
        }
      } else {
        printUsage()
      }
      break
    }

    case 'project': {
      if (sub === 'create') {
        const organizationId = Number(args[2])
        const name = args[3]
        if (!organizationId || !name) {
          console.error('用法：project create <组织ID> <名称>')
          process.exit(1)
        }
        const created = await tenancy.createProject({ organizationId, name })
        console.log(`项目已创建：id=${created.project.id} slug=${created.project.slug}`)
        console.log('')
        console.log('  运行时密钥（上报用，会进前端代码）：')
        console.log(`    ${created.runtimeKey}`)
        console.log('  上传密钥（sourcemap 用，只放 CI 里）：')
        console.log(`    ${created.uploadKey}`)
        console.log('')
        console.log('⚠️  两个密钥只显示这一次，数据库里只存哈希。')
      } else if (sub === 'list') {
        const organizationId = Number(args[2])
        for (const project of await tenancy.listProjects(organizationId)) {
          console.log(`${project.id}\t${project.slug}\t${project.name}`)
        }
      } else {
        printUsage()
      }
      break
    }

    case 'env': {
      if (sub === 'add') {
        const projectId = Number(args[2])
        const slug = args[3]
        const name = args[4]
        if (!projectId || !slug || !name) {
          console.error('用法：env add <项目ID> <slug> <名称> [--production]')
          process.exit(1)
        }
        const isProduction = args.includes('--production')
        const environment = await tenancy.createEnvironment(projectId, slug, name, isProduction)
        console.log(`环境已创建：id=${environment.id} slug=${environment.slug}`)
      } else {
        printUsage()
      }
      break
    }

    case 'release': {
      if (sub === 'add') {
        const projectId = Number(args[2])
        const version = args[3]
        const commitSha = args[4]
        if (!projectId || !version) {
          console.error('用法：release add <项目ID> <版本> [commitSha]')
          process.exit(1)
        }
        const release = await tenancy.createRelease(projectId, version, commitSha)
        console.log(`版本已登记：id=${release.id} version=${release.version}`)
      } else {
        printUsage()
      }
      break
    }

    case 'list': {
      for (const org of await tenancy.listOrganizations()) {
        console.log(`组织 ${org.id}  ${org.name}`)
        for (const project of await tenancy.listProjects(org.id)) {
          console.log(`  项目 ${project.id}  ${project.name}  (${project.slug})`)
        }
      }
      break
    }

    default:
      printUsage()
      process.exit(1)
  }
} finally {
  await db.close()
}
