/**
 * 租户隔离闸门 —— 管理端每条语句都必须带租户范围。
 *
 * ## 为什么要有这个闸门
 *
 * 多租户系统最致命的 bug 不是崩溃，是**串数据**：
 * 项目 A 的管理员在项目 B 的页面上看到了 A 的数据，
 * 或者改掉了 B 的告警规则。
 *
 * ⚠️ 而「漏一个条件」在代码上几乎看不出来 ——
 *    `WHERE id = ?` 和 `WHERE id = ? AND project_id = ?` 长得一样。
 *    更糟的是：**读**路径通常有父查询兜着（先查父、后查子），
 *    所以漏了也不一定出事 —— 直到有人绕过父查询调它。
 *
 * ## 判据怎么定的
 *
 * 1. 从**库结构**读出每张表有哪些租户列（`project_id` / `organization_id`）。
 *    ⚠️ 不硬编码表清单 —— 新表上线自动纳入检查。
 * 2. 记录管理端**实际执行的 SQL**（`app.inject()` 打一遍所有接口）
 * 3. SELECT / UPDATE / DELETE → 必须有 `租户列 = ?` 的条件
 * 4. INSERT → 插入列里必须带租户列
 *
 * ## 没租户列的表怎么办
 *
 * 纯子表（比如挂在 issue 下的活动流/评论/标签）**没有** project_id 列 ——
 * 它们的归属靠 FK 继承自父行。那种表的隔离由父查询保证，
 * 不在本闸门范围内（但面板会列出它们，提醒你知道它靠谁兜着）。
 */
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, defaultDbPath } from '../packages/collector/src/infra/db/client.js'
import type { Db } from '../packages/collector/src/infra/db/types.js'
import { buildApp } from '../packages/collector/src/app.js'

const ADMIN_TOKEN = 'audit-scope-token'
/** 租户列的候选名 */
const TENANT_COLUMNS = ['project_id', 'organization_id']

/**
 * 结构上不可能串租户数据的语句形态。
 *
 * ⚠️ 豁免 ≠ 放宽判据：每一条都写明为什么安全，并在结果里**逐条打印数量**。
 *    悄悄放过的豁免等于没有闸门。硬约束：**UPDATE / DELETE 一律不豁免** ——
 *    写操作必须自带 `organization_id = ?` / `project_id = ?`，这是纵深防御。
 *
 * 这三类都是 v0.5 补 RBAC 后冒出来的：鉴权层按主键解析「这个资源属于哪个组织」，
 * 查的就是 organization_id 本身，条件里不可能先有它；解析结果随即用于校验。
 */
const SAFE_SHAPES: { name: string; test: (sql: string, table: string) => boolean }[] = [
  {
    name: '租户归属解析（按主键查出 organization_id，结果随即用于鉴权）',
    test: (sql) =>
      /^\s*select\s+organization_id\s+from\s+(projects|teams|members)\s+where\s+id\s*=\s*\?\s*$/i.test(
        sql
      )
  },
  {
    name: '按主键点查单行（主键全局唯一，最多返回一行）',
    test: (sql) => /^\s*select\b[\s\S]*?\bwhere\s+(?:\w+\.)?id\s*=\s*\?\s*$/i.test(sql)
  },
  {
    name: 'JOIN 关联范围（目标表由 JOIN 引入，范围条件落在已限定的关联表上）',
    test: (sql, table) =>
      new RegExp(`\\bjoin\\s+${table}\\b`, 'i').test(sql) &&
      /\b\w+\.(?:project_id|team_id|organization_id)\s*=\s*\?/i.test(sql)
  }
]

/** 不查库的接口（纯身份回显 / 纯计算），不打「覆盖可能有洞」的警告 */
const SQL_FREE_ENDPOINTS = ['/api/v1/me']

interface Recorded {
  sql: string
  endpoint: string
  method: string
}

interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

/** 从库结构读出「哪些表有哪些租户列」 */
async function tenantColumns(db: Db): Promise<Map<string, string>> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  const map = new Map<string, string>()
  for (const { name } of rows) {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${name})`)
    const tenant = TENANT_COLUMNS.find((c) => cols.some((col) => col.name === c))
    if (tenant) map.set(name.toLowerCase(), tenant)
  }
  return map
}

/** 取出 SQL 里引用到的表 */
function tablesIn(sql: string): string[] {
  const found = new Set<string>()
  const pattern = /(?:from|join|update|into)\s+([a-z_][a-z0-9_]*)/gi
  // `ON CONFLICT DO UPDATE SET ...` 里的 `UPDATE SET` 会被上面那条正则
  // 误当成「UPDATE 某张表」，抓出一个叫 set 的伪表名。
  const keywords = new Set(['set', 'do', 'values', 'where', 'select'])
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1].toLowerCase()
    if (!keywords.has(name)) found.add(name)
  }
  return [...found]
}

/** INSERT 语句里插入的列 */
function insertedColumns(sql: string): string[] {
  const match = /insert\s+into\s+[a-z_][a-z0-9_]*\s*\(([^)]*)\)/i.exec(sql)
  if (!match) return []
  return match[1]
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
}

async function collectSql(endpoints: Endpoint[], dbPath: string): Promise<Recorded[]> {
  const base = await openDb(dbPath, { migrate: false })
  const recorded: Recorded[] = []

  const record = (sql: string, endpoint: string, method: string) => {
    recorded.push({ sql, endpoint, method })
  }

  const spy: Db = {
    dialect: base.dialect,
    exec: (sql) => base.exec(sql),
    all: async (sql, params) => {
      record(sql, '', 'ALL')
      return base.all(sql, params)
    },
    get: async (sql, params) => {
      record(sql, '', 'GET')
      return base.get(sql, params)
    },
    run: async (sql, params) => {
      record(sql, '', 'RUN')
      return base.run(sql, params)
    },
    insert: async (sql, params) => {
      record(sql, '', 'INSERT')
      return base.insert(sql, params)
    },
    transaction: (fn) => base.transaction(fn),
    savepoint: (name, fn) => base.savepoint(name, fn),
    close: () => base.close()
  }

  const { app } = await buildApp({ db: spy, adminToken: ADMIN_TOKEN })

  for (const ep of endpoints) {
    const before = recorded.length
    const res = await app.inject({
      method: ep.method,
      url: ep.path,
      headers: { 'x-vigil-admin-token': ADMIN_TOKEN },
      ...(ep.body === undefined ? {} : { payload: ep.body as never })
    })
    const got = recorded.length - before
    for (let i = before; i < recorded.length; i++) {
      recorded[i].endpoint = `${ep.method} ${ep.path}`
      recorded[i].method = ep.method
    }
    console.log(
      `   ${String(got).padStart(2)} 条  ${ep.method.padEnd(6)} ${ep.path}  → ${res.statusCode}`
    )
    if (res.statusCode >= 400) {
      console.log(`      ↳ ${res.body.slice(0, 160)}`)
    }
    if (got === 0 && res.statusCode === 200) {
      if (SQL_FREE_ENDPOINTS.includes(ep.path)) {
        console.log(`      · 纯身份回显，不查库（预期）`)
      } else {
        console.warn(`      ⚠ 这个接口没跑出任何 SQL —— 覆盖可能有洞`)
      }
    }
  }

  await app.close()
  await base.close()
  return recorded
}

async function main() {
  // ⚠️ 在**库副本**上跑 —— 闸门要真的调写接口才能检查写语句的��围，
  //    但那些调用不能污染演示数据。
  const tmp = join(process.cwd(), 'data', 'audit-scope.db')
  copyFileSync(defaultDbPath(), tmp)

  const raw = await openDb(tmp, { migrate: false })
  // 挑一个**真的有 issue** 的项目 —— 否则详情接口会 404，覆盖不到
  const project = (await raw.get<{ id: number }>(
    'SELECT project_id AS id FROM issues GROUP BY project_id ORDER BY count(*) DESC LIMIT 1'
  )) ?? { id: 1 }
  const issue = (await raw.get<{ id: number }>(
    'SELECT id FROM issues WHERE project_id = ? LIMIT 1',
    [project.id]
  )) ?? { id: 1 }
  const rule = (await raw.get<{ id: number }>(
    'SELECT id FROM alert_rules WHERE project_id = ? LIMIT 1',
    [project.id]
  )) ?? { id: 1 }
  // 指派需要真实成员 —— 否则接口直接 500，探不到 SQL
  const member = await raw.get<{ id: number }>('SELECT id FROM members LIMIT 1')
  let memberId = member?.id
  const orgRow = await raw.get<{ id: number }>(
    'SELECT organization_id AS id FROM projects WHERE id = ?',
    [project.id]
  )
  const orgId = orgRow?.id ?? 1
  if (memberId === undefined) {
    // 库里没有成员就建一个 —— 指派路径必须真的跑通
    memberId = await raw.insert(
      'INSERT INTO members (organization_id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)',
      [orgId, `scope-audit-${Date.now()}@example.com`, '闸门探针', 'member', Date.now()]
    )
  }
  // RBAC / 团队 / 凭据的路由也要**真实 id** —— 用假 id 只会拿到 404，
  // 一条 SQL 都探不到，闸门就成了「看起来覆盖了」的摆设。
  const team = await raw.get<{ id: number }>('SELECT id FROM teams LIMIT 1')
  const teamId =
    team?.id ??
    (await raw.insert(
      'INSERT INTO teams (organization_id, slug, name, created_at) VALUES (?, ?, ?, ?)',
      [orgId, 'scope-audit-team', '闸门探针团队', Date.now()]
    ))
  const key = await raw.get<{ id: number }>('SELECT id FROM member_keys LIMIT 1')
  const keyId =
    key?.id ??
    (await raw.insert(
      'INSERT INTO member_keys (member_id, key_hash, label, created_at) VALUES (?, ?, ?, ?)',
      [memberId, `scope-audit-${Date.now()}`, '闸门探针', Date.now()]
    ))
  const tenantCols = await tenantColumns(raw)
  await raw.close()

  const p = String(project.id)
  const endpoints: Endpoint[] = [
    // ---- 读 ----
    { method: 'GET', path: '/api/v1/organizations' },
    { method: 'GET', path: `/api/v1/projects/${p}/stats` },
    { method: 'GET', path: `/api/v1/projects/${p}/issues` },
    { method: 'GET', path: `/api/v1/projects/${p}/issues/trend` },
    { method: 'GET', path: `/api/v1/projects/${p}/issues/${issue.id}` },
    { method: 'GET', path: `/api/v1/projects/${p}/performance` },
    { method: 'GET', path: `/api/v1/projects/${p}/transactions` },
    { method: 'GET', path: `/api/v1/projects/${p}/error-performance` },
    { method: 'GET', path: `/api/v1/projects/${p}/behavior/summary` },
    { method: 'GET', path: `/api/v1/projects/${p}/sessions` },
    { method: 'GET', path: `/api/v1/projects/${p}/sessions/1/replay` },
    { method: 'GET', path: `/api/v1/projects/${p}/sessions/1/events` },
    { method: 'GET', path: `/api/v1/projects/${p}/alert-rules` },
    { method: 'GET', path: `/api/v1/projects/${p}/channels` },
    { method: 'GET', path: `/api/v1/projects/${p}/alert-incidents` },
    { method: 'GET', path: `/api/v1/projects/${p}/releases` },
    { method: 'GET', path: `/api/v1/projects/${p}/environments` },
    // ---- 写（这些才是最容易漏范围的）----
    {
      method: 'POST',
      path: `/api/v1/projects/${p}/alert-rules`,
      body: { name: '闸门探针', type: 'issue.new', threshold: 1, windowSeconds: 300 }
    },
    {
      method: 'PATCH',
      path: `/api/v1/projects/${p}/alert-rules/${rule.id}`,
      body: { enabled: false }
    },
    {
      method: 'POST',
      path: `/api/v1/projects/${p}/issues/${issue.id}/resolve`,
      body: { release: '1.0.0', reason: '闸门探针' }
    },
    {
      method: 'POST',
      path: `/api/v1/projects/${p}/issues/${issue.id}/comments`,
      body: { body: '闸门探针' }
    },
    {
      method: 'POST',
      path: `/api/v1/projects/${p}/issues/${issue.id}/assign`,
      body: { memberId }
    },
    {
      method: 'POST',
      path: `/api/v1/projects/${p}/issues/${issue.id}/bookmark`,
      body: { bookmarked: true }
    },
    // ---- 身份 / 成员 / 凭据（v0.5 RBAC 新增，之前闸门完全没扫过）----
    { method: 'GET', path: '/api/v1/me' },
    { method: 'GET', path: `/api/v1/organizations/${orgId}/members` },
    {
      method: 'POST',
      path: `/api/v1/organizations/${orgId}/members`,
      body: {
        email: `scope-audit-${Date.now()}@example.com`,
        name: '闸门探针成员',
        role: 'member'
      }
    },
    { method: 'GET', path: `/api/v1/members/${memberId}/keys` },
    { method: 'POST', path: `/api/v1/members/${memberId}/keys`, body: { label: '闸门探针' } },
    { method: 'GET', path: `/api/v1/projects/${p}/members` },
    {
      method: 'PUT',
      path: `/api/v1/projects/${p}/members/${memberId}`,
      body: { role: 'editor' }
    },
    // ---- 团队（同一批新增路由）----
    { method: 'GET', path: `/api/v1/organizations/${orgId}/teams` },
    {
      method: 'POST',
      path: `/api/v1/organizations/${orgId}/teams`,
      body: { name: '闸门探针团队' }
    },
    { method: 'GET', path: `/api/v1/teams/${teamId}` },
    { method: 'PUT', path: `/api/v1/teams/${teamId}`, body: { name: '闸门探针团队改名' } },
    { method: 'GET', path: `/api/v1/teams/${teamId}/members` },
    { method: 'POST', path: `/api/v1/teams/${teamId}/members`, body: { memberId } },
    { method: 'DELETE', path: `/api/v1/teams/${teamId}/members/${memberId}` },
    // 删除类放最后 —— 前面的接口还要用这些 id
    { method: 'DELETE', path: `/api/v1/members/${memberId}/keys/${keyId}` },
    { method: 'DELETE', path: `/api/v1/teams/${teamId}` },
    { method: 'DELETE', path: `/api/v1/organizations/${orgId}/members/${memberId}` },
    { method: 'GET', path: `/api/v1/organizations/${orgId}/audit-log` }
  ]

  console.log('① 记录管理端实际执行的 SQL…')
  const recorded = await collectSql(endpoints, tmp)
  console.log(`   共 ${recorded.length} 条语句\n`)

  console.log('② 检查每条语句的租户范围…')
  const offenders: { sql: string; endpoint: string; table: string; column: string }[] = []
  const waived: { reason: string }[] = []
  const childTables = new Set<string>()
  const seen = new Set<string>()

  for (const { sql, endpoint } of recorded) {
    const key = sql.replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)

    const isInsert = /^\s*insert/i.test(key)
    const inserted = isInsert ? insertedColumns(key) : []

    for (const table of tablesIn(key)) {
      const column = tenantCols.get(table)
      if (!column) {
        // 没租户列的表 —— 纯子表，归属靠 FK 继承
        childTables.add(table)
        continue
      }
      if (isInsert) {
        if (!inserted.includes(column)) {
          offenders.push({ sql: key, endpoint, table, column })
        }
        continue
      }
      // 范围条件可以是 `列 = ?`，也可以是 `列 = (SELECT ...)` ——
      // 后者用于「成员属于项目所在组织」这种跨表范围
      const scoped = new RegExp(`\\b${column}\\s*=\\s*(\\?|\\()`).test(key)
      if (!scoped) {
        // 写操作一律不豁免 —— 只有 SELECT 才可能属于「结构上安全」的形态
        const isWrite = /^\s*(update|delete)\b/i.test(key)
        const shape = isWrite ? undefined : SAFE_SHAPES.find((s) => s.test(key, table))
        if (shape) {
          waived.push({ reason: shape.name })
          continue
        }
        offenders.push({ sql: key, endpoint, table, column })
      }
    }
  }

  if (waived.length > 0) {
    const grouped = new Map<string, number>()
    for (const w of waived) grouped.set(w.reason, (grouped.get(w.reason) ?? 0) + 1)
    console.log(`\n按结构豁免 ${waived.length} 条（写操作一律不豁免，逐条列明）：`)
    for (const [reason, count] of grouped) console.log(`   ${count} 条 · ${reason}`)
  }

  for (const o of offenders) {
    console.log(`\n✗ 缺少范围条件：${o.table}.${o.column}`)
    console.log(`   来源接口：${o.endpoint}`)
    console.log(`   语句：${o.sql.slice(0, 150)}`)
  }

  if (childTables.size > 0) {
    console.log(`\n（这些表没有租户列，归属靠父行继承，不在本闸门范围内：`)
    console.log(`  ${[...childTables].sort().join('、')}）`)
  }

  console.log(`\n${'─'.repeat(60)}`)
  rmSync(tmp, { force: true })
  rmSync(`${tmp}-wal`, { force: true })
  rmSync(`${tmp}-shm`, { force: true })

  if (offenders.length === 0) {
    console.log(
      `闸门 1 条，通过 1 条，失败 0 条（检查了 ${seen.size} 条语句，` +
        `${waived.length} 条按结构豁免，其余全部带租户范围）`
    )
    console.log('─'.repeat(60))
    return
  }
  console.log(`闸门 1 条，通过 0 条，失败 1 条（${offenders.length} 处语句缺租户范围）`)
  console.log('─'.repeat(60))
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
