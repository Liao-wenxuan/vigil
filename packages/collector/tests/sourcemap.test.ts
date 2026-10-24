import { describe, expect, it } from 'vitest'
import { saveSourcemap, SourcemapResolver } from '../src/sourcemap.js'
import { setupDb } from './helpers.js'

/**
 * 手写的 sourcemap。
 *
 * mappings 的 VLQ 逐段解码：
 *   "AAAA"    → 生成列 0，源 0，原始行 0，原始列 0
 *   "AACA"    → 生成列 0，源 0，原始行 +1 → 1，原始列 0
 *   "CAAC"    → 生成列 +1 → 1，源 0，原始行 0（不变），原始列 +1 → 1
 *
 * 第 2 行故意放两个 segment，这样**列号对不对**就会体现在结果上 ——
 * 1-based / 0-based 差一位的话，查询列会落到另一个 segment，
 * 断言 original.colno 就能抓到。
 */
const SIMPLE_MAP = {
  version: 3,
  file: 'index.js',
  sourceRoot: '',
  sources: ['src/app.ts'],
  sourcesContent: ['export function foo() {}\nthrow new Error("boom")\n'],
  names: [],
  mappings: 'AAAA;AACA,CAAC'
}

describe('SourcemapResolver', () => {
  it('还原出原始文件与行列', () => {
    const { db, app } = setupDb()
    saveSourcemap(db, app.appId, '1.0.0', 'assets/index.js', JSON.stringify(SIMPLE_MAP))

    const resolver = new SourcemapResolver(db)
    const frames = resolver.resolve(app.appId, '1.0.0', [
      { filename: 'https://a.com/assets/index.js', functionName: 'foo', lineno: 2, colno: 1 }
    ])

    expect(frames[0].original).toBeDefined()
    expect(frames[0].original?.filename).toBe('src/app.ts')
    expect(frames[0].original?.lineno).toBe(2)
    // 栈里的列号是 1-based，sourcemap 是 0-based —— 差一位就会被抓到
    expect(frames[0].original?.colno).toBe(1)
    db.close()
  })

  it('没有 release 时原样返回（没 release 就没有对应的 map）', () => {
    const { db, app } = setupDb()
    saveSourcemap(db, app.appId, '1.0.0', 'assets/index.js', JSON.stringify(SIMPLE_MAP))

    const resolver = new SourcemapResolver(db)
    const frames = resolver.resolve(app.appId, undefined, [
      { filename: 'https://a.com/assets/index.js', lineno: 2, colno: 1 }
    ])

    expect(frames[0].original).toBeUndefined()
    expect(frames[0].lineno).toBe(2)
    db.close()
  })

  it('release 对不上时不还原（不同版本的 map 不能混用）', () => {
    const { db, app } = setupDb()
    saveSourcemap(db, app.appId, '1.0.0', 'assets/index.js', JSON.stringify(SIMPLE_MAP))

    const resolver = new SourcemapResolver(db)
    const frames = resolver.resolve(app.appId, '2.0.0', [
      { filename: 'https://a.com/assets/index.js', lineno: 2, colno: 1 }
    ])

    expect(frames[0].original).toBeUndefined()
    db.close()
  })

  it('找不到 map 时降级返回原帧，不抛异常', () => {
    const { db, app } = setupDb()
    const resolver = new SourcemapResolver(db)
    const frames = resolver.resolve(app.appId, '1.0.0', [
      { filename: 'https://a.com/assets/unknown.js', lineno: 2, colno: 1 }
    ])

    expect(frames[0].original).toBeUndefined()
    expect(frames[0].filename).toBe('https://a.com/assets/unknown.js')
    db.close()
  })

  it('重复上传同一个文件是覆盖而不是报错', () => {
    const { db, app } = setupDb()
    saveSourcemap(db, app.appId, '1.0.0', 'assets/index.js', JSON.stringify(SIMPLE_MAP))
    saveSourcemap(db, app.appId, '1.0.0', 'assets/index.js', JSON.stringify(SIMPLE_MAP))

    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM sourcemaps WHERE app_id = ?')
      .get(app.appId) as { n: number }
    expect(rows.n).toBe(1)
    db.close()
  })

  it('invalidate 清掉指定 release 的缓存', () => {
    const { db, app } = setupDb()
    saveSourcemap(db, app.appId, '1.0.0', 'assets/index.js', JSON.stringify(SIMPLE_MAP))

    const resolver = new SourcemapResolver(db)
    resolver.resolve(app.appId, '1.0.0', [
      { filename: 'https://a.com/assets/index.js', lineno: 2, colno: 1 }
    ])

    // 缓存里已有 → 换掉 map 后 invalidate 才能生效
    saveSourcemap(
      db,
      app.appId,
      '1.0.0',
      'assets/index.js',
      JSON.stringify({ ...SIMPLE_MAP, sources: ['src/changed.ts'] })
    )
    resolver.invalidate(app.appId, '1.0.0')

    const frames = resolver.resolve(app.appId, '1.0.0', [
      { filename: 'https://a.com/assets/index.js', lineno: 2, colno: 1 }
    ])
    expect(frames[0].original?.filename).toBe('src/changed.ts')
    db.close()
  })
})
