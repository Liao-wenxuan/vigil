/**
 * SLO 发布闸门 —— 「这个项目现在能不能发版」。
 *
 * ## 用法
 *
 * ```bash
 * npm run slo:gate -- --project 1
 * npm run slo:gate -- --project 1 --strict        # 「有风险」也阻断
 * npm run slo:gate -- --project 1 --require-data  # 没数据也阻断
 * npm run slo:gate -- --project 1 --require-slo   # 必须定义了 SLO
 * npm run slo:gate -- --all                      # 查所有项目
 * ```
 *
 * ## 退出码
 *
 * | 码 | 含义 |
 * |---|---|
 * | 0 | 放行 |
 * | 1 | 被 SLO 阻断（不要发版） |
 * | 2 | 闸门自己跑不起来（数据库连不上等） |
 *
 * ## 为什么直接读库
 *
 * CI 里发版的时候，采集服务**不一定在跑** —— 闸门要能用。
 * 直接读库最省事，也不会因为「服务没起来」而放行。
 *
 * ⚠️ 读的是**生产库**才有意义 —— 拿开发库的 SLO 挡发版是自欺欺人。
 */
import { existsSync } from 'node:fs'
import { openDb, defaultDbPath } from '../packages/collector/src/infra/db/client.js'
import { openPostgres } from '../packages/collector/src/infra/db/postgres.js'
import type { Db } from '../packages/collector/src/infra/db/types.js'
import { SloService } from '../packages/collector/src/domains/slo/service.js'
import { decideSloGate } from '../packages/collector/src/domains/slo/gate.js'

const args = process.argv.slice(2)

function flagValue(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  return args[index + 1]
}

const has = (name: string): boolean => args.includes(`--${name}`)

const projectArg = flagValue('project')
const all = has('all') || projectArg === undefined
const strict = has('strict')
const requireData = has('require-data')
const requireSlo = has('require-slo')

/** 打开当前环境指向的库（PG 优先，与采集服务一致） */
async function openDbForEnv(): Promise<Db | null> {
  const url = process.env.DATABASE_URL
  if (url) return await openPostgres(url, { migrate: false })

  const path = process.env.VIGIL_DB_PATH ?? defaultDbPath()
  // ⚠️ **没有数据库**和**数据库连不上**是两回事：
  //    - 没有库 → 什么都没得判 → 跳过（CI 里就是这个情况）
  //    - 连不上 → 闸门跑不起来 → 阻断（跑不了就不能放行）
  if (!existsSync(path)) return null
  return await openDb(path, { migrate: false })
}

function formatPercent(value: number | null): string {
  if (value === null) return '—'
  return `${(value * 100).toFixed(2)}%`
}

async function main(): Promise<void> {
  let db: Db | null
  try {
    db = await openDbForEnv()
  } catch (error) {
    console.error(
      `[slo-gate] 连不上数据库：${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 2
    return
  }

  if (db === null) {
    console.log('[slo-gate] 没有数据库 —— 跳过')
    return
  }

  try {
    const slo = new SloService(db)
    const projectIds = all
      ? (await db.all<{ id: number }>('SELECT id FROM projects ORDER BY id')).map((r) => r.id)
      : [Number(projectArg)]
    if (!all && (!Number.isFinite(Number(projectArg)) || Number(projectArg) <= 0)) {
      console.error('[slo-gate] --project 要给一个数字（或用 --all）')
      process.exitCode = 2
      return
    }

    let blocked = 0
    let checked = 0

    for (const projectId of projectIds) {
      const list = await slo.list(projectId)
      if (list.length === 0) {
        if (requireSlo) {
          console.error(`✗ 项目 ${projectId} 没有定义 SLO —— 被阻断（requireSlo 模式）`)
          blocked++
        } else {
          console.log(`· 项目 ${projectId}：没有 SLO —— 跳过`)
        }
        continue
      }

      const items = []
      for (const item of list) {
        if (!item.enabled) continue
        const evaluation = await slo.evaluate(projectId, item)
        items.push({ slo: item, evaluation })
      }
      if (items.length === 0) {
        console.log(`· 项目 ${projectId}：所有 SLO 都已停用 —— 跳过`)
        continue
      }

      const result = decideSloGate(items, { strict, requireData, requireSlo })
      checked += items.length

      console.log(`\n项目 ${projectId}`)
      for (const entry of result.entries) {
        const mark = entry.blocking ? '✗' : '·'
        console.log(
          `  ${mark} ${entry.name}：SLI ${formatPercent(entry.sli)} · 错误率 ${formatPercent(entry.errorRatio)} · ` +
            `预算剩余 ${Math.round(entry.budgetRemaining)} · 燃烧率 ${entry.burnRate === null ? '—' : `${entry.burnRate.toFixed(2)}×`} —— ${entry.reason}`
        )
      }
      console.log(`  → ${result.summary}`)

      if (!result.passed) blocked++
    }

    console.log('')
    if (blocked > 0) {
      console.error(`[slo-gate] 阻断：${blocked} 个项目不允许发布（共检查 ${checked} 条 SLO）`)
      process.exitCode = 1
      return
    }
    console.log(`[slo-gate] 放行（共检查 ${checked} 条 SLO）`)
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error('[slo-gate] 闸门执行失败：', error)
  process.exitCode = 2
})
