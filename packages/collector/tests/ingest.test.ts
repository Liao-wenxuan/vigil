import { describe, expect, it } from 'vitest'
import { createApp } from '../src/apps.js'
import { Ingestor } from '../src/ingest.js'
import { SourcemapResolver } from '../src/sourcemap.js'
import { fp, makeEvent, setupDb } from './helpers.js'

function makeIngestor(db: ReturnType<typeof setupDb>['db']) {
  return new Ingestor(db, new SourcemapResolver(db))
}

describe('Ingestor 聚合', () => {
  it('同一指纹聚合成一行，count 累加', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    const event = makeEvent({ fingerprint: fp('one') })
    ingestor.ingest(app.appId, [event, { ...event }, { ...event }])

    const row = db
      .prepare('SELECT COUNT(*) AS n, SUM(count) AS c FROM errors WHERE app_id = ?')
      .get(app.appId) as { n: number; c: number }

    expect(row.n).toBe(1)
    expect(row.c).toBe(3)
    db.close()
  })

  it('不同指纹分成不同行', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    ingestor.ingest(app.appId, [
      makeEvent({ fingerprint: fp('a') }),
      makeEvent({ fingerprint: fp('b') }),
      makeEvent({ fingerprint: fp('a') })
    ])

    const row = db
      .prepare('SELECT COUNT(*) AS n, SUM(count) AS c FROM errors WHERE app_id = ?')
      .get(app.appId) as { n: number; c: number }

    expect(row.n).toBe(2)
    expect(row.c).toBe(3)
    db.close()
  })

  it('重复上报不产生重复行（靠 UNIQUE 约束，不靠先查再插）', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    for (let i = 0; i < 5; i++) {
      ingestor.ingest(app.appId, [makeEvent({ fingerprint: fp('same') })])
    }

    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ? AND fingerprint = ?')
      .all(app.appId, fp('same')) as Array<{ n: number }>

    expect(rows).toHaveLength(1)
    expect(rows[0].n).toBe(1)
    db.close()
  })

  it('原始事件明细全部保留（排查要看现场）', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    const event = makeEvent({ fingerprint: fp('detail') })
    ingestor.ingest(app.appId, [event, { ...event }])

    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM error_events WHERE app_id = ?')
      .all(app.appId) as Array<{ n: number }>

    expect(rows[0].n).toBe(2)
    db.close()
  })

  it('明细超过上限时裁剪到 20 条（防止数据库无限膨胀）', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    for (let i = 0; i < 25; i++) {
      ingestor.ingest(app.appId, [makeEvent({ fingerprint: fp('prune') })])
    }

    const row = db
      .prepare('SELECT COUNT(*) AS n FROM error_events WHERE app_id = ? AND fingerprint = ?')
      .get(app.appId, fp('prune')) as { n: number }

    expect(row.n).toBe(20)
    db.close()
  })

  it('多应用隔离：A 应用的事件不会出现在 B 应用名下', () => {
    const { db, app: appA } = setupDb()
    const appB = createApp(db, '另一个应用')
    const ingestor = makeIngestor(db)

    ingestor.ingest(appA.appId, [makeEvent({ fingerprint: fp('shared') })])
    ingestor.ingest(appB.appId, [makeEvent({ fingerprint: fp('shared') })])

    const a = db.prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ?').get(appA.appId) as {
      n: number
    }
    const b = db.prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ?').get(appB.appId) as {
      n: number
    }

    // 同样的指纹在两个应用下是两条独立记录
    expect(a.n).toBe(1)
    expect(b.n).toBe(1)
    db.close()
  })

  it('从 User-Agent 解析出浏览器和系统', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    ingestor.ingest(app.appId, [makeEvent({ fingerprint: fp('ua') })])

    const row = db
      .prepare('SELECT browser, os, device FROM errors WHERE app_id = ?')
      .get(app.appId) as { browser: string; os: string; device: string }

    expect(row.browser).toBe('Chrome')
    expect(row.os).toBe('Windows 10+')
    expect(row.device).toBe('desktop')
    db.close()
  })

  it('指纹缺失时服务端兜底，不同的错误不会塌成一条', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    // 客户端没给指纹（SDK 有 bug / 版本不兼容 / 被篡改）
    ingestor.ingest(app.appId, [
      makeEvent({ fingerprint: '', message: '错误 A' }),
      makeEvent({ fingerprint: '', message: '错误 B' })
    ])

    const rows = db.prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ?').get(app.appId) as {
      n: number
    }

    // 如果照单全收空串，这两条会塌成 1 行
    expect(rows.n).toBe(2)
    db.close()
  })

  it('指纹格式非法时同样走兜底', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    ingestor.ingest(app.appId, [
      makeEvent({ fingerprint: 'not-a-valid-fingerprint' }),
      makeEvent({ fingerprint: 'not-a-valid-fingerprint' })
    ])

    const rows = db
      .prepare('SELECT COUNT(*) AS n, SUM(count) AS c FROM errors WHERE app_id = ?')
      .get(app.appId) as { n: number; c: number }

    // 同一条非法指纹的相同错误仍然聚合成一条
    expect(rows.n).toBe(1)
    expect(rows.c).toBe(2)
    db.close()
  })

  it('空批次不报错', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)
    expect(ingestor.ingest(app.appId, []).accepted).toBe(0)
    db.close()
  })
})
