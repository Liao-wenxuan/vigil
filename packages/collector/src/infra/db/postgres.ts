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
 */
async function createPgPool(connectionString: string): Promise<PgPool> {
  try {
    const pg = (await import('pg')) as unknown as {
      default?: { Pool: new (config: unknown) => PgPool }
      Pool?: new (config: unknown) => PgPool
    }
    const PoolCtor = pg.default?.Pool ?? pg.Pool
    if (!PoolCtor) throw new Error('pg 模块没有导出 Pool')
    return new PoolCtor({ connectionString })
  } catch (error) {
    throw new Error(
      `无法加载 pg 驱动（PostgreSQL 支持需要它）：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** 命名参数转成位置参数 —— PG 不支持 SQLite 的命名参数 */
function toArray(params?: unknown[] | Record<string, unknown>): unknown[] {
  if (params === undefined) return []
  if (Array.isArray(params)) return params
  return Object.values(params)
}
