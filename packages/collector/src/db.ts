import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { initSchema } from './schema.js'

/**
 * 数据库连接。
 *
 * WAL 模式是这里的重点：上报是**高频写**，查询是**低频读**。
 * 默认的 rollback journal 模式下，写事务会阻塞所有读 —— 意味着
 * 用户正在刷错误列表时，新的上报全在排队。WAL 让读写互不阻塞。
 *
 * `synchronous = NORMAL` 是 WAL 的配套设置：在 WAL 下，
 * NORMAL 只在操作系统崩溃时可能丢最后几个事务，进程崩溃不会丢 ——
 * 对监控系统来说这个取舍是划算的（丢几条错误 vs 每次写入都 fsync）。
 */
export function createDb(dbPath: string): Database.Database {
  // 目录不存在时 SQLite 不会自动建 —— 直接开文件会报 "unable to open database file"
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  }

  const db = new Database(dbPath)

  // SQLite 默认**不开启**外键约束 —— schema 里写的 ON DELETE CASCADE
  // 一条都不会触发。better-sqlite3 帮我们打开了，但这属于库的默认值，
  // 不是我们声明的约定，所以显式写一遍。
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  initSchema(db)
  return db
}

/** 默认数据库路径 */
export function defaultDbPath(): string {
  return process.env.VIGIL_DB_PATH ?? './data/vigil.db'
}
