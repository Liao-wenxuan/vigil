import Database from 'better-sqlite3'
import fs from 'node:fs'
import nodePath from 'node:path'
import { runMigrations, MIGRATIONS } from './migrate.js'
import type { Dialect } from './dialect.js'

/**
 * 数据访问接口。
 *
 * 领域代码**只依赖这个接口**，不依赖具体驱动。
 * 这样「换数据库」真的就只是换一个实现 —— 而不是重写所有查询。
 *
 * 参数既支持位置（`?`）也支持命名（`@name`），
 * 两种写法在 SQLite 和 PostgreSQL 上语义一致。
 */
export interface Db {
  readonly dialect: Dialect
  /** 执行不返回结果集的语句（DDL 等） */
  exec(sql: string): void
  /** 查询多行 */
  all<T = unknown>(sql: string, params?: unknown[] | Record<string, unknown>): T[]
  /** 查询单行 */
  get<T = unknown>(sql: string, params?: unknown[] | Record<string, unknown>): T | undefined
  /** 执行写语句 */
  run(sql: string, params?: unknown[] | Record<string, unknown>): { changes: number }
  /** 在事务里执行 */
  transaction<T>(fn: () => T): T
  close(): void
}

/** SQLite 实现 */
class SqliteDb implements Db {
  readonly dialect: Dialect = 'sqlite'

  constructor(private readonly db: Database.Database) {}

  exec(sql: string): void {
    this.db.exec(sql)
  }

  all<T = unknown>(sql: string, params?: unknown[] | Record<string, unknown>): T[] {
    const statement = this.db.prepare(sql)
    if (params === undefined) return statement.all() as T[]
    return statement.all(params as never) as T[]
  }

  get<T = unknown>(sql: string, params?: unknown[] | Record<string, unknown>): T | undefined {
    const statement = this.db.prepare(sql)
    if (params === undefined) return statement.get() as T | undefined
    return statement.get(params as never) as T | undefined
  }

  run(sql: string, params?: unknown[] | Record<string, unknown>): { changes: number } {
    const statement = this.db.prepare(sql)
    if (params === undefined) return statement.run()
    return statement.run(params as never)
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }
}

/**
 * 打开数据库。
 *
 * @param path SQLite 文件路径；':memory:' 表示内存库（测试用）
 * @param options.migrate 是否自动跑迁移。测试造「有历史数据的老库」时
 *        要先关掉 —— 否则迁移先跑完，就没有老表可迁了。
 */
export function openDb(path: string, options: { migrate?: boolean } = {}): Db {
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
    runMigrations(db, 'sqlite', MIGRATIONS)
  }
  return db
}

/** 暴露原始句柄（仅 SQLite 特有操作需要时用） */
export function rawHandle(db: Db): Database.Database | undefined {
  return db instanceof SqliteDb ? (db as unknown as { db: Database.Database }).db : undefined
}
