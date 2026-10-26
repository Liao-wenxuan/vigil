import { openDb } from './infra/db/client.js'
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
 * 直接操作数据库文件，不需要 Collector 在跑 —— 初始化流程更短。
 */
const args = process.argv.slice(2)
const command = args[0]
const sub = args[1]

const db = openDb(process.env.VIGIL_DB_PATH ?? './data/vigil.db')
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

环境变量 VIGIL_DB_PATH 指定数据库路径（默认 ./data/vigil.db）`)
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
        const organization = tenancy.createOrganization(name)
        console.log(
          `组织已创建：id=${organization.id} slug=${organization.slug} name=${organization.name}`
        )
      } else if (sub === 'list') {
        for (const org of tenancy.listOrganizations()) {
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
        const created = tenancy.createProject({ organizationId, name })
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
        for (const project of tenancy.listProjects(organizationId)) {
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
        const environment = tenancy.createEnvironment(projectId, slug, name, isProduction)
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
        const release = tenancy.createRelease(projectId, version, commitSha)
        console.log(`版本已登记：id=${release.id} version=${release.version}`)
      } else {
        printUsage()
      }
      break
    }

    case 'list': {
      for (const org of tenancy.listOrganizations()) {
        console.log(`组织 ${org.id}  ${org.name}`)
        for (const project of tenancy.listProjects(org.id)) {
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
  db.close()
}
