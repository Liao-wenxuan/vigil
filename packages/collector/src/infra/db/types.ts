/**
 * 数据访问接口。
 *
 * ## 为什么单独一个文件
 *
 * `client.ts`（实现）要 import `migrate.ts`（跑迁移），
 * 而 `migrate.ts` 又要 import `Db`（类型）。
 *
 * 接口和实现放一起时这是一个**循环依赖** ——
 * TypeScript 的类型推断会在环里打转，
 * 于是 `setupDb()` 的返回类型推不出来（TS7022「隐式 any」）。
 *
 * 把接口抽出来，环就断了。
 *
 * ## 为什么要异步
 *
 * PostgreSQL 的驱动（`pg`）只有异步 API —— 网络 IO 没法同步等。
 * 接口保持同步的话，PG 实现就只能是「阻塞事件线程」的反模式：
 * 一个慢查询能把整个采集服务（包括健康检查）一起卡死。
 *
 * ## 占位符
 *
 * 领域代码统一写 **`?`**（位置占位符）。
 *
 * SQLite 原生支持 `?`；PG 原生要 `$1`。
 * 转换**只发生在 PG 适配器里**（`postgres.ts` 的 `toDollarPlaceholders`），
 * 领域代码一个字符都不用改。
 */
import type { Dialect } from './dialect.js'

export interface Db {
  readonly dialect: Dialect
  /** 执行不返回结果集的语句（DDL 等） */
  exec(sql: string): Promise<void>
  /** 查询多行 */
  all<T = unknown>(sql: string, params?: unknown[] | Record<string, unknown>): Promise<T[]>
  /** 查询单行 */
  get<T = unknown>(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<T | undefined>
  /** 执行写语句 */
  run(sql: string, params?: unknown[] | Record<string, unknown>): Promise<{ changes: number }>
  /**
   * 插入并返回自增主键。
   *
   * 用 `RETURNING id` —— SQLite 3.35+ 和 PostgreSQL 都支持。
   *
   * ⚠️ 不要再用 SQLite 独有的 `last_insert_rowid()`：
   *    那个函数在 PG 上**不存在**，查它会直接报错。
   */
  insert(sql: string, params?: unknown[] | Record<string, unknown>): Promise<number>
  /** 在事务里执行 */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
}
