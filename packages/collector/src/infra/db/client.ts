import Database from 'better-sqlite3'
import fs from 'node:fs'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations, MIGRATIONS } from './migrate.js'
import type { Db } from './types.js'
import type { Dialect } from './dialect.js'

export type { Db } from './types.js'

/**
 * SQLite 实现。
 *
 * better-sqlite3 是**同步**驱动，所以这里每个方法都是「同步干活 + 包一层 Promise」。
 *
 * ## 事务里为什么可以 await
 *
 * 事务体里的 `await` 挂起的是**微任务**，不是宏任务。
 * Node 的事件循环会先清空微任务队列再回到宏任务 ——
 * 所以在微任务挂起期间，**另一个请求的 SQL 不会插进这个事务**。
 *
 * ⚠️ 这条保证依赖 SQLite 实现**不做真正的异步 IO**。
 *    PG 实现是另一套逻辑（独占一个连接，见 postgres.ts）。
 */
class SqliteDb implements Db {
  readonly dialect: Dialect = 'sqlite'

  /** 事务嵌套深度 —— 内层不重新 BEGIN，靠外层兜住 */
  private depth = 0

  /**
   * 预编译语句缓存。
   *
   * `db.prepare(sql)` **每次都会重新编译 SQL** ——
   * 摄入热路径上同一批 SQL 要跑成千上万次，重复编译是纯浪费。
   *
   * ⚠️ 但语句**不能重入**：better-sqlite3 在语句执行中再执行同一条
   *    会报 "This statement is busy executing a query"。
   *    所以命中缓存时先看 `busy`，忙就临时准备一条新的（不进缓存）。
   */
  private readonly statements = new Map<string, Database.Statement>()

  constructor(private readonly db: Database.Database) {}

  /** 取预编译语句（带缓存） */
  private prepare(sql: string): Database.Statement {
    const cached = this.statements.get(sql)
    if (cached) {
      // 正在执行中（重入）—— 临时准备一条，不进缓存
      if (cached.busy) return this.db.prepare(sql)
      return cached
    }
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  async exec(sql: string): Promise<void> {
    // DDL 会让**已缓存的语句失效**（表结构变了，语句的编译结果不再对）——
    // 所以执行 DDL 前清空缓存。
    //
    // ⚠️ 迁移就是走 exec 的：先清空再执行，顺序不能反。
    this.statements.clear()
    this.db.exec(sql)
  }

  async all<T = unknown>(sql: string, params?: unknown[] | Record<string, unknown>): Promise<T[]> {
    const statement = this.prepare(sql)
    if (params === undefined) return statement.all() as T[]
    return statement.all(params as never) as T[]
  }

  async get<T = unknown>(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<T | undefined> {
    const statement = this.prepare(sql)
    if (params === undefined) return statement.get() as T | undefined
    return statement.get(params as never) as T | undefined
  }

  async run(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<{ changes: number }> {
    const statement = this.prepare(sql)
    if (params === undefined) return statement.run()
    return statement.run(params as never)
  }

  async insert(sql: string, params?: unknown[] | Record<string, unknown>): Promise<number> {
    // `RETURNING id` —— SQLite 3.35+ 与 PG 都支持
    const statement = this.prepare(`${sql} RETURNING id`)
    const row = params === undefined ? statement.get() : statement.get(params as never)
    return Number((row as { id?: number } | undefined)?.id ?? 0)
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // 嵌套事务：内层直接跑，靠外层提交
    if (this.depth > 0) return await fn()

    this.depth++
    this.db.exec('BEGIN')
    try {
      const result = await fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

/**
 * 打开 SQLite 数据库。
 *
 * @param path SQLite 文件路径；':memory:' 表示内存库（测试用）
 * @param options.migrate 是否自动跑迁移。测试造「有历史数据的老库」时
 *        要先关掉 —— 否则迁移先跑完，就没有老表可迁了。
 */
export async function openDb(path: string, options: { migrate?: boolean } = {}): Promise<Db> {
  if (path !== ':memory:') {
    // 目录不存在时 SQLite 不会自动建 —— 直接开文件会报 "unable to open database file"
    fs.mkdirSync(nodePath.dirname(nodePath.resolve(path)), { recursive: true })
  }

  const raw = new Database(path)

  // ⚠️ SQLite 默认**不开启**外键约束，schema 里写的 ON DELETE CASCADE
  //    一条都不会触发。better-sqlite3 帮我们打开了，但这属于库的默认值，
  //    不是我们声明的约定，所以显式写一遍。
  raw.pragma('foreign_keys = ON')
  // WAL：上报是高频写，查询是低频读。默认的 rollback journal 模式下
  // 写事务会阻塞所有读 —— 用户正在刷错误列表时，新的上报全在排队。
  raw.pragma('journal_mode = WAL')
  raw.pragma('synchronous = NORMAL')

  const db = new SqliteDb(raw)
  if (options.migrate !== false) {
    // ⚠️ 迁移必须**等完**才能返回。
    //    丢弃这个 Promise 会让第一个请求撞上半截 schema ——
    //    症状是「刚启动的几秒里上报全部 500」。
    await runMigrations(db, 'sqlite', MIGRATIONS)
  }
  return db
}

/** 暴露原始句柄（仅 SQLite 特有操作需要时用） */
export function rawHandle(db: Db): Database.Database | undefined {
  return db instanceof SqliteDb ? (db as unknown as { db: Database.Database }).db : undefined
}

/**
 * 默认数据库路径。
 *
 * ⚠️ 相对**仓库根**解析，不能相对 CWD。
 *
 *    `npm run dev:collector` 会以 packages/collector 为 CWD 跑，
 *    相对路径会指向 packages/collector/data/vigil.db ——
 *    于是采集服务连的是 A 库、种子脚本写的是 B 库，
 *    表现是「种子跑完了但面板空空如也」。
 *
 *    根因是这类脚本的 CWD 随 npm 的调用方式变化，
 *    路径必须锚定在仓库结构上，而不是调用者当时站在哪。
 */
export function defaultDbPath(): string {
  if (process.env.VIGIL_DB_PATH) return process.env.VIGIL_DB_PATH

  const repoRoot = nodePath.resolve(
    nodePath.dirname(fileURLToPath(import.meta.url)),
    '../../../../..'
  )
  return nodePath.join(repoRoot, 'data', 'vigil.db')
}
