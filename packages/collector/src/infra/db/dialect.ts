/**
 * 数据层方言层。
 *
 * ## 为什么要方言层
 *
 * 本机 Docker 跑不起来（缺 WSL2），也没装 PostgreSQL —— 只能用 SQLite。
 * 但 SQLite 和 PostgreSQL 在类型系统上有几处硬差异，直接写死一方就等于
 * 把「换库」的成本从「改一行配置」变成「重写整个数据层」。
 *
 * 所以 schema 用这一层生成，两边都跑得起来，**领域代码一行都不用改**。
 *
 * ## 各类型的取舍
 *
 * | 逻辑类型 | SQLite | PostgreSQL | 为什么 |
 * |---|---|---|---|
 * | 自增主键 | INTEGER PRIMARY KEY | SERIAL PRIMARY KEY | PG 没有 rowid 别名 |
 * | 时间戳 | INTEGER | BIGINT | 统一用 epoch 毫秒，不受时区影响 |
 * | 布尔 | INTEGER | INTEGER | ⚠️ 见下 |
 * | JSON | TEXT | JSONB | 见下 |
 *
 * **布尔用 INTEGER 而不是 PG 的 BOOLEAN**：PG 的 BOOLEAN 不接受整数
 * （`INSERT ... VALUES (1)` 直接报类型错误），写 0/1 两边都通。
 * 代价是 PG 上少了一层类型安全，用 CHECK 约束补回来。
 *
 * **JSON 在 PG 上用 JSONB**：性能好得多。代价是 PG 返回的是对象、
 * SQLite 返回的是字符串 —— 所以读写一律走 `readJson` / `writeJson`，
 * 它们两边都认，调用方不需要知道自己在哪个库上。
 */

/** 支持的方言 */
export type Dialect = 'sqlite' | 'postgres'

/** 自增主键 */
export function pk(dialect: Dialect): string {
  return dialect === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY'
}

/** 时间戳（epoch 毫秒） */
export function ts(dialect: Dialect): string {
  return dialect === 'postgres' ? 'BIGINT' : 'INTEGER'
}

/** 布尔（0/1） */
export function bool(_dialect: Dialect): string {
  return 'INTEGER'
}

/**
 * 单调计数器。
 *
 * SQLite 只有 INTEGER（8 字节，够到 9e18）；PG 必须写 BIGINT ——
 * 用 INTEGER 会在 21 亿封顶，一个日活百万的应用一年就能撑爆。
 */
export function bigInt(dialect: Dialect): string {
  return dialect === 'postgres' ? 'BIGINT' : 'INTEGER'
}

/** JSON */
export function json(dialect: Dialect): string {
  return dialect === 'postgres' ? 'JSONB' : 'TEXT'
}

/** 普通字符串 */
export function text(_dialect: Dialect): string {
  return 'TEXT'
}

/** 长字符串（消息、栈） */
export function longText(_dialect: Dialect): string {
  return 'TEXT'
}

/**
 * 读 JSON 字段。
 *
 * PG 的 JSONB 返回已解析的对象，SQLite 的 TEXT 返回字符串 ——
 * 这里统一处理，调用方拿到的永远是对象。
 */
export function readJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    if (!value) return undefined
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  }
  return value as T
}

/** 写 JSON 字段 */
export function writeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

/** 布尔入参归一化 */
export function toBool(value: boolean | undefined | null): number {
  return value ? 1 : 0
}

/** 布尔出参归一化 */
export function fromBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1' || value === 't'
}

/**
 * 时间分桶表达式。
 *
 * ## 为什么返回「桶起点」而不是「桶序号」
 *
 * 图表要的是**桶的起始时间**（拿去当横轴标签），不是序号。
 * 返回序号的话，每次查都要在应用层再换算一遍。
 *
 * ## 为什么要传时区偏移
 *
 * 「按天」分桶如果按 UTC 边界切，中国用户看到的「今天」
 * 要到早上 8 点才真正开始 —— 有三分之一的数据落到了昨天。
 *
 * 偏移让桶边界对齐**用户所在时区的午夜**。
 * 偏移是「分钟，UTC 以东为正」（东八区 = 480）。
 *
 * ## 跨库一致
 *
 * SQLite 的 `INTEGER / INTEGER` 与 PG 的 `bigint / bigint` **都是整除**，
 * 两边行为一致。`CAST(... AS BIGINT)` 在 SQLite 里退化成整数亲和性，
 * 在 PG 里保证乘回去不会溢出 int4（epoch 毫秒 × 天数会超）。
 */
export function bucketExpr(column: string, bucketMs: number, tzOffsetMinutes = 0): string {
  const offsetMs = Math.round(tzOffsetMinutes) * 60_000
  if (offsetMs === 0) {
    return `(CAST(${column} / ${bucketMs} AS BIGINT) * ${bucketMs})`
  }
  // 本地时间 = UTC + 偏移，所以「本地第几天」是 (col + offset) / bucketMs，
  // 而桶起点（换回 epoch）要再减掉偏移。
  // ⚠️ 两个符号别搞反：反了会把东八区算成西八区，
  //    桶边界整体错 8 小时 —— 数据会落到隔壁那天的桶里。
  return `(CAST((${column} + ${offsetMs}) / ${bucketMs} AS BIGINT) * ${bucketMs} - ${offsetMs})`
}
