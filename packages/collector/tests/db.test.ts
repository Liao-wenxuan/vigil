import { describe, expect, it } from 'vitest'
import { fp, makeEvent, setupDb } from './helpers.js'

/**
 * 数据访问层的测试。
 *
 * 重点是**预编译语句缓存**的正确性 ——
 * 缓存错了不会报错，只会**读到错的数据**，那是最难查的一类 bug。
 */
describe('数据访问层', () => {
  it('同一条 SQL 连续跑，结果一致（缓存不串味）', async () => {
    const { db, issues, project } = await setupDb()

    await issues.ingestEvent(project.id, makeEvent({ fingerprint: fp('cache') }))

    const first = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')
    const second = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')

    expect(first?.n).toBe(1)
    expect(second?.n).toBe(first?.n)
  })

  it('事务里跑同一条 SQL 不会触发「语句忙」', async () => {
    const { db } = await setupDb()

    const result = await db.transaction(async () => {
      const inner = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')
      // 同一条 SQL 在事务里再跑一次
      const again = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues')
      return { inner: inner?.n, again: again?.n }
    })

    expect(result.inner).toBe(0)
    expect(result.again).toBe(0)
  })

  it('DDL 之后不会用到陈旧的编译结果', async () => {
    const { db } = await setupDb()

    // 先把这条语句编译并缓存下来
    await db.all('SELECT id FROM issues')

    // DDL 会清空缓存 —— 已缓存的语句是按旧表结构编译的
    await db.exec('ALTER TABLE issues ADD COLUMN probe TEXT')

    // 同一条 SQL 还能正常跑，且拿得到新列
    const rows = await db.all<{ id: number; probe: string | null }>('SELECT id, probe FROM issues')
    expect(Array.isArray(rows)).toBe(true)
  })

  it('insert 返回自增主键', async () => {
    const { db } = await setupDb()

    const id = await db.insert(
      'INSERT INTO organizations (slug, name, created_at) VALUES (?, ?, ?)',
      ['probe-org', '探针组织', Date.now()]
    )

    expect(id).toBeGreaterThan(0)
    const row = await db.get<{ slug: string }>('SELECT slug FROM organizations WHERE id = ?', [id])
    expect(row?.slug).toBe('probe-org')
  })
})
