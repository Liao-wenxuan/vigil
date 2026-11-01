import { describe, expect, it } from 'vitest'
import { PostgresDb, type PgClient, type PgPool } from '../src/infra/db/postgres.js'

/**
 * PG 事务的连接归属。
 *
 * ## 为什么不能用真 PG 测
 *
 * 本机没有 PG 服务器，PGlite 是**单连接**的 —— 它天然不会出现
 * 「语句跑到别的连接上」这个问题。所以这里用一个**假连接池**：
 * 池和借出的连接是不同身份，一眼就能看出语句跑去了哪。
 *
 * ## 这个 bug 是什么
 *
 * PG 的事务必须**独占一个连接**：BEGIN 之后的所有语句都得走同一个连接，
 * 否则就不在同一个事务里了。
 *
 * 曾经的实现是：事务借出一个 client 发 BEGIN，但所有语句走 `pool.query` ——
 * 而 `pool.query` 会挑一个**空闲连接**，那是另一个连接。
 * 结果是：事务在 PG 上**形同虚设** ——
 * BEGIN/COMMIT 落在一个连接上，语句全在事务之外跑。
 *
 * 后果：摄入链路的原子性没了。中途失败会留下半截数据
 * （比如 Issue 行建好了、明细没写进去）。
 */
interface QueryLog {
  sql: string
  /** -1 = 走的是池；正数 = 走的是那个借出来的连接 */
  clientId: number
}

class FakeClient implements PgClient {
  constructor(
    readonly id: number,
    private readonly log: QueryLog[]
  ) {}

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number | null }> {
    this.log.push({ sql, clientId: this.id })
    return { rows: [], rowCount: 0 }
  }

  release(): void {
    /* 假池不需要真的归还 */
  }
}

class FakePool implements PgPool {
  readonly log: QueryLog[] = []
  private nextId = 0

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number | null }> {
    this.log.push({ sql, clientId: -1 })
    return { rows: [], rowCount: 0 }
  }

  async connect(): Promise<PgClient> {
    return new FakeClient(++this.nextId, this.log)
  }
}

describe('PG 事务的连接归属', () => {
  it('事务里的语句走同一个连接（BEGIN / COMMIT 也在上面）', async () => {
    const pool = new FakePool()
    const db = new PostgresDb(pool)

    await db.transaction(async () => {
      await db.run('UPDATE issues SET count = count + 1')
      await db.get('SELECT id FROM issues LIMIT 1')
      await db.insert('INSERT INTO issue_events (id) VALUES (1)')
    })

    const ids = new Set(pool.log.map((e) => e.clientId))
    expect(ids.size).toBe(1)

    // BEGIN / COMMIT 也必须在同一个连接上
    const begin = pool.log.find((e) => e.sql === 'BEGIN')
    const commit = pool.log.find((e) => e.sql === 'COMMIT')
    expect(begin).toBeDefined()
    expect(commit).toBeDefined()
    expect(begin?.clientId).toBe(commit?.clientId)
  })

  it('事务外的语句仍然走连接池', async () => {
    const pool = new FakePool()
    const db = new PostgresDb(pool)

    await db.run('UPDATE issues SET count = count + 1')

    expect(pool.log).toHaveLength(1)
    expect(pool.log[0].clientId).toBe(-1)
  })

  it('并发事务各自独占连接（不会串到对方的事务里）', async () => {
    const pool = new FakePool()
    const db = new PostgresDb(pool)

    await Promise.all([
      db.transaction(async () => {
        await db.run('SELECT 1')
        // 让出事件循环，逼出交错
        await new Promise((resolve) => setTimeout(resolve, 5))
        await db.run('SELECT 2')
      }),
      db.transaction(async () => {
        await db.run('SELECT 3')
        await new Promise((resolve) => setTimeout(resolve, 5))
        await db.run('SELECT 4')
      })
    ])

    const clients = pool.log.filter((e) => e.sql !== 'BEGIN' && e.sql !== 'COMMIT')
    const byClient = new Map<number, string[]>()
    for (const q of clients) {
      const list = byClient.get(q.clientId) ?? []
      list.push(q.sql)
      byClient.set(q.clientId, list)
    }

    // 两个事务 → 两个不同的连接
    expect(byClient.size).toBe(2)
    for (const [, sqls] of byClient) {
      // 每个连接上的语句必须**只属于一个事务** —— 不能混进对方的
      const allFirst = sqls.every((s) => s === 'SELECT 1' || s === 'SELECT 2')
      const allSecond = sqls.every((s) => s === 'SELECT 3' || s === 'SELECT 4')
      expect(allFirst || allSecond).toBe(true)
    }
  })

  it('事务失败会回滚', async () => {
    const pool = new FakePool()
    const db = new PostgresDb(pool)

    await expect(
      db.transaction(async () => {
        await db.run('SELECT 1')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(pool.log.some((e) => e.sql === 'ROLLBACK')).toBe(true)
  })
})
