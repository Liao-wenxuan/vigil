import { describe, expect, it } from 'vitest'
import type { Db } from '../src/infra/db/types.js'
import { SourcemapResolver } from '../src/domains/artifacts/sourcemap.js'
import { setupDb } from './helpers.js'

/**
 * sourcemap 解析缓存。
 *
 * 摄入热路径每条事件要跑 5 次 DB 往返，其中一次是查 sourcemap。
 * 没上传 map 的项目**很常见**，而未命中如果不缓存，
 * 每条事件都要白跑一次库 —— 在 PG 部署下那是一次网络往返。
 */
describe('sourcemap 解析缓存', () => {
  /** 只数查 sourcemaps 表的读查询 */
  function countingSourcemapReads(inner: Db): { db: Db; reads: () => number } {
    let reads = 0
    const db: Db = {
      dialect: inner.dialect,
      exec: (sql) => inner.exec(sql),
      all: (sql, params) => {
        if (sql.includes('FROM sourcemaps')) reads++
        return inner.all(sql, params)
      },
      get: (sql, params) => {
        if (sql.includes('FROM sourcemaps')) reads++
        return inner.get(sql, params)
      },
      run: (sql, params) => inner.run(sql, params),
      insert: (sql, params) => inner.insert(sql, params),
      transaction: (fn) => inner.transaction(fn),
      close: () => inner.close()
    }
    return { db, reads: () => reads }
  }

  const FRAME = {
    filename: 'https://a.com/assets/index-DnB3xK2l.js',
    functionName: 'minified',
    lineno: 2,
    colno: 1
  }

  /** 一份能用的最小 sourcemap：第 2 行映射到 src/api/user.ts 的 fetchUserProfile */
  const MAP_JSON = JSON.stringify({
    version: 3,
    sources: ['src/api/user.ts'],
    names: ['fetchUserProfile'],
    mappings: 'AAAA;AACA'
  })

  it('未命中也被缓存 —— 第二次解析不再查库', async () => {
    const { db, project } = await setupDb()
    const spy = countingSourcemapReads(db)
    const resolver = new SourcemapResolver(spy.db)

    await resolver.resolve(project.id, '1.0.0', [FRAME])
    const afterFirst = spy.reads()
    await resolver.resolve(project.id, '1.0.0', [FRAME])

    expect(afterFirst).toBe(1)
    expect(spy.reads()).toBe(1)
  })

  it('命中也被缓存 —— 第二次解析不再查库', async () => {
    const { db, artifacts, project } = await setupDb()
    await artifacts.uploadSourcemap({
      projectId: project.id,
      release: '1.0.0',
      fileName: 'index-DnB3xK2l.js',
      mapJson: MAP_JSON
    })

    const spy = countingSourcemapReads(db)
    const resolver = new SourcemapResolver(spy.db)

    const first = await resolver.resolve(project.id, '1.0.0', [FRAME])
    const afterFirst = spy.reads()
    const second = await resolver.resolve(project.id, '1.0.0', [FRAME])

    expect(afterFirst).toBe(1)
    expect(spy.reads()).toBe(1)
    expect(first[0].original?.lineno).toBe(2)
    expect(second[0].original?.lineno).toBe(2)
  })

  it('后补传的 map 能生效（未命中缓存被 invalidate 清掉）', async () => {
    const { artifacts, project } = await setupDb()
    // ⚠️ 必须用 ArtifactService **自己那个** resolver ——
    //    上传后调 invalidate 的正是它。
    //    生产环境里 IssueService 和 ArtifactService 共用同一个实例
    //    （setupDb 里就是这么接线的），所以失效能真正生效。
    const resolver = artifacts.sourcemapResolver

    // 先解析一次 —— 此时没有 map，被记成未命中
    const before = await resolver.resolve(project.id, '1.0.0', [FRAME])
    expect(before[0].original).toBeUndefined()

    // 再补传 map —— 上传会让缓存失效
    await artifacts.uploadSourcemap({
      projectId: project.id,
      release: '1.0.0',
      fileName: 'index-DnB3xK2l.js',
      mapJson: MAP_JSON
    })

    const after = await resolver.resolve(project.id, '1.0.0', [FRAME])
    expect(after[0].original?.lineno).toBe(2)
    expect(after[0].original?.source).toBe('src/api/user.ts')
  })

  it('坏掉的 map 也被记住 —— 不会每条事件都重新解析一遍', async () => {
    const { db, artifacts, project } = await setupDb()
    await artifacts.uploadSourcemap({
      projectId: project.id,
      release: '1.0.0',
      fileName: 'index-DnB3xK2l.js',
      mapJson: '{ 根本不是 json'
    })

    const spy = countingSourcemapReads(db)
    const resolver = new SourcemapResolver(spy.db)

    await resolver.resolve(project.id, '1.0.0', [FRAME])
    await resolver.resolve(project.id, '1.0.0', [FRAME])

    expect(spy.reads()).toBe(1)
  })

  it('没有 release 或没有栈帧时根本不查库', async () => {
    const { db, project } = await setupDb()
    const spy = countingSourcemapReads(db)
    const resolver = new SourcemapResolver(spy.db)

    await resolver.resolve(project.id, undefined, [FRAME])
    await resolver.resolve(project.id, '1.0.0', [])

    expect(spy.reads()).toBe(0)
  })
})
