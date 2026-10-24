import { describe, expect, it } from 'vitest'
import { createApp } from '../src/apps.js'
import { Ingestor } from '../src/ingest.js'
import { SourcemapResolver } from '../src/sourcemap.js'
import { makeEvent, setupDb } from './helpers.js'

function makeIngestor(db: ReturnType<typeof setupDb>['db']) {
  return new Ingestor(db, new SourcemapResolver(db))
}

describe('Ingestor 聚合', () => {
  it('同一指纹聚合成一行，count 累加', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    const event = makeEvent({ fingerprint: 'fp_1' })
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
      makeEvent({ fingerprint: 'fp_a' }),
      makeEvent({ fingerprint: 'fp_b' }),
      makeEvent({ fingerprint: 'fp_a' })
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
      ingestor.ingest(app.appId, [makeEvent({ fingerprint: 'fp_same' })])
    }

    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ? AND fingerprint = ?')
      .all(app.appId, 'fp_same') as Array<{ n: number }>

    expect(rows).toHaveLength(1)
    expect(rows[0].n).toBe(1)
    db.close()
  })

  it('原始事件明细全部保留（排查要看现场）', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)

    const event = makeEvent({ fingerprint: 'fp_detail' })
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
      ingestor.ingest(app.appId, [makeEvent({ fingerprint: 'fp_prune' })])
    }

    const row = db
      .prepare('SELECT COUNT(*) AS n FROM error_events WHERE app_id = ? AND fingerprint = ?')
      .get(app.appId, 'fp_prune') as { n: number }

    expect(row.n).toBe(20)
    db.close()
  })

  it('多应用隔离：A 应用的事件不会出现在 B 应用名下', () => {
    const { db, app: appA } = setupDb()
    const appB = createApp(db, '另一个应用')
    const ingestor = makeIngestor(db)

    ingestor.ingest(appA.appId, [makeEvent({ fingerprint: 'shared_fp' })])
    ingestor.ingest(appB.appId, [makeEvent({ fingerprint: 'shared_fp' })])

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

    ingestor.ingest(app.appId, [makeEvent({ fingerprint: 'fp_ua' })])

    const row = db
      .prepare('SELECT browser, os, device FROM errors WHERE app_id = ?')
      .get(app.appId) as { browser: string; os: string; device: string }

    expect(row.browser).toBe('Chrome')
    expect(row.os).toBe('Windows 10+')
    expect(row.device).toBe('desktop')
    db.close()
  })

  it('空批次不报错', () => {
    const { db, app } = setupDb()
    const ingestor = makeIngestor(db)
    expect(ingestor.ingest(app.appId, []).accepted).toBe(0)
    db.close()
  })
})
