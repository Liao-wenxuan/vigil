import { runMigrations, MIGRATIONS } from './migrate.js'
import type { Db } from './client.js'
import type { Dialect } from './dialect.js'

/**
 * PostgreSQL 实现。
 *
 * ## 占位符翻译
 *
 * 领域代码写的是 `?`（SQLite 风格），PG 只认 `$1`。
 *
 * 转换在这里做 —— **领域代码一个字符都不用改**。
 * 翻译器必须跳过字符串字面量和注释，否则 SQL 里一个 `?`
 * （比如 `LIKE '%?%'`）会被误当成占位符，参数个数就错位了。
 *
 * ## 事务
 *
 * PG 的事务必须**独占一个连接**：BEGIN 之后的所有语句都得走同一个连接，
 * 否则就不在同一个事务里了。
 *
 * 所以这里从连接池里借出一个 client，事务结束再还回去。
 * 这也是 PG 实现和 SQLite 实现最大的结构差异。
 */

/** 能执行 SQL 的最小接口 —— `pg` 的 Pool / Client 都满足 */
export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
}

/** 能借出连接、也能归还的连接池 */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>
}

/** 借出来的连接 */
export interface PgClient extends PgQueryable {
  release(): void
}

/**
 * `?` → `$1` 的翻译。
 *
 * 逐字符扫描，跳过：
 *   - 单引号字符串（`''` 是转义的单引号）
 *   - 双引号标识符（`""` 是转义的双引号）
 *   - `--` 行注释
 *   - `/* *\/` 块注释
 */
export function toDollarPlaceholders(sql: string): string {
  let out = ''
  let index = 0
  let i = 0

  while (i < sql.length) {
    const char = sql[i]

    // 单引号字符串
    if (char === "'") {
      const end = findClosing(sql, i, "'")
      out += sql.slice(i, end)
      i = end
      continue
    }

    // 双引号标识符
    if (char === '"') {
      const end = findClosing(sql, i, '"')
      out += sql.slice(i, end)
      i = end
      continue
    }

    // 行注释
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      out += sql.slice(i, stop)
      i = stop
      continue
    }

    // 块注释
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop)
      i = stop
      continue
    }

    // 占位符
    if (char === '?') {
      index++
      out += `$${index}`
      i++
      continue
    }

    out += char
    i++
  }

  return out
}

/** 找到引号的闭合位置（返回闭合引号之后的下标） */
function findClosing(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      // 双写是转义 —— 跳过
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

/** PG 实现的 Db 适配器 */
export class PostgresDb implements Db {
  readonly dialect: Dialect = 'postgres'

  constructor(private readonly pool: PgPool) {}

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql)
  }

  async all<T = unknown>(sql: string, params?: unknown[] | Record<string, unknown>): Promise<T[]> {
    const result = await this.pool.query(toDollarPlaceholders(sql), toArray(params))
    return result.rows as T[]
  }

  async get<T = unknown>(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<T | undefined> {
    const result = await this.pool.query(toDollarPlaceholders(sql), toArray(params))
    return (result.rows[0] as T | undefined) ?? undefined
  }

  async run(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<{ changes: number }> {
    const result = await this.pool.query(toDollarPlaceholders(sql), toArray(params))
    return { changes: result.rowCount ?? 0 }
  }

  async insert(sql: string, params?: unknown[] | Record<string, unknown>): Promise<number> {
    // `RETURNING id` —— 与 SQLite 实现同一套语义
    const result = await this.pool.query(
      toDollarPlaceholders(`${sql} RETURNING id`),
      toArray(params)
    )
    const row = result.rows[0] as { id?: number | string } | undefined
    return Number(row?.id ?? 0)
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // PG 的事务必须独占一个连接 —— BEGIN 之后的语句都得走同一个连接
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn()
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 回滚失败说明连接已经断了 —— 原始错误更重要
      }
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    const pool = this.pool as PgPool & { end?: () => Promise<void> }
    await pool.end?.()
  }
}

/**
 * 打开 PostgreSQL。
 *
 * @param connectionString 连接串（`postgres://user:pass@host:5432/db`）
 */
export async function openPostgres(
  connectionString: string,
  options: { migrate?: boolean; pool?: PgPool } = {}
): Promise<Db> {
  const pool = options.pool ?? (await createPgPool(connectionString))
  const db = new PostgresDb(pool)

  if (options.migrate !== false) {
    await runMigrations(db, 'postgres', MIGRATIONS)
  }
  return db
}

/**
 * 建连接池。
 *
 * `pg` 是**可选依赖** —— 用 SQLite 部署的人不必装它。
 * 所以这里用动态 import：真的要用 PG 时才加载驱动。
 *
 * ## 为什么每个超时都要显式设
 *
 * `pg` 的默认值是「不超时」。一条写错的看板查询会永久占住一个连接；
 * 连接池默认只有 10 个，占满之后**整个采集服务假死** ——
 * 连 `/api/ready` 都连不上数据库，K8s 把 Pod 判成不健康再重启，
 * 重启后流量照旧，于是循环。这类故障最难查的地方是：
 * 日志里一条报错都没有，只有「服务突然不响应了」。
 */
async function createPgPool(connectionString: string): Promise<PgPool> {
  try {
    const pg = (await import('pg')) as unknown as {
      default?: { Pool: new (config: unknown) => PgPool }
      Pool?: new (config: unknown) => PgPool
    }
    const PoolCtor = pg.default?.Pool ?? pg.Pool
    if (!PoolCtor) throw new Error('pg 模块没有导出 Pool')

    const ssl = sslFromEnv()

    return new PoolCtor({
      connectionString,
      // 连接数上限。给多了会顶穿 PG 的 max_connections（默认 100），
      // 多副本时尤其要算总量：副本数 × max 必须小于 PG 的连接上限。
      max: intFromEnv('VIGIL_PG_POOL_MAX', 10),
      // 空闲连接回收，别长期占着 PG 的连接额度
      idleTimeoutMillis: intFromEnv('VIGIL_PG_IDLE_TIMEOUT_MS', 30_000),
      // 建连超时：PG 不可达时快速失败，而不是让请求挂住
      connectionTimeoutMillis: intFromEnv('VIGIL_PG_CONNECT_TIMEOUT_MS', 5_000),
      // 语句超时（服务端执行，PG 自己会杀掉）
      statement_timeout: intFromEnv('VIGIL_PG_STATEMENT_TIMEOUT_MS', 15_000),
      // 客户端超时：兜住「连接还在但不再回包」这种半死状态
      query_timeout: intFromEnv('VIGIL_PG_QUERY_TIMEOUT_MS', 20_000),
      // 出事时能在 pg_stat_activity 里认出是谁连的
      application_name: 'vigil-collector',
      ...(ssl ? { ssl } : {})
    })
  } catch (error) {
    throw new Error(
      `无法加载 pg 驱动（PostgreSQL 支持需要它）：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** 读正整数环境变量，缺失或非法时用默认值 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

/**
 * TLS 配置。
 *
 * 云数据库（RDS / 云厂商 PG）基本都强制 TLS，
 * 但内网自建的 PG 常常没配证书 —— 所以给三档，别让人为了连通性
 * 去改代码。
 *
 *   VIGIL_PG_SSL 缺失 / disable   → 不开 TLS
 *   VIGIL_PG_SSL=no-verify        → 加密但不校验证书（自签证书）
 *   VIGIL_PG_SSL=verify           → 加密且校验证书（生产该用这个）
 */
function sslFromEnv(): false | { rejectUnauthorized: boolean } | undefined {
  const mode = (process.env.VIGIL_PG_SSL ?? '').toLowerCase()
  if (!mode || mode === 'disable' || mode === 'false') return undefined
  if (mode === 'verify' || mode === 'require' || mode === 'true') {
    return { rejectUnauthorized: true }
  }
  // no-verify 及其它非空取值：加密但跳过证书校验
  return { rejectUnauthorized: false }
}

/** 命名参数转成位置参数 —— PG 不支持 SQLite 的命名参数 */
function toArray(params?: unknown[] | Record<string, unknown>): unknown[] {
  if (params === undefined) return []
  if (Array.isArray(params)) return params
  return Object.values(params)
}
