import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/infra/db/client.js'
import { TenancyService } from '../src/domains/tenancy/service.js'
import { fp, makeEvent } from './helpers.js'

/**
 * 配额。
 *
 * 守的是两件事：
 *   1. 配额判定**不再**扫 issue_events 全表（成本必须和事件数无关）
 *   2. 计数器单调 —— 保留策略删掉旧数据后，配额不能自己「洗回来」
 */

const ADMIN = 'admin_quota_token'

async function setup(eventQuota: number) {
  const db = await openDb(':memory:')
  const tenancy = new TenancyService(db)
  const organization = await tenancy.createOrganization('配额组织')
  const created = await tenancy.createProject({
    organizationId: organization.id,
    name: '配额应用',
    eventQuota
  })
  const built = await buildApp({ db, adminToken: ADMIN })

  return {
    db,
    built,
    app: built.app,
    usage: built.usage,
    project: created.project,
    runtimeKey: created.runtimeKey
  }
}

function post(
  app: Awaited<ReturnType<typeof setup>>['app'],
  runtimeKey: string,
  slug: string,
  n: number
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/collect',
    headers: { 'x-vigil-token': runtimeKey },
    payload: {
      appId: slug,
      events: Array.from({ length: n }, (_, i) =>
        makeEvent({ fingerprint: fp(`q-${Date.now()}-${i}`), occurredAt: Date.now() + i })
      )
    }
  })
}

describe('配额', () => {
  it('配额内正常上报，用量累加到计数表', async () => {
    const { app, usage, project, runtimeKey, db } = await setup(10)

    const response = await post(app, runtimeKey, project.slug, 3)
    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(3)

    expect((await usage.snapshot(project)).eventsTotal).toBe(3)

    // 只有一行计数器，不是每次上报插一条
    const rows = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM project_usage WHERE project_id = ?',
      [project.id]
    )
    expect(Number(rows?.n)).toBe(1)
  })

  it('超出配额 → 429，且不再写入数据', async () => {
    const { app, usage, project, runtimeKey, db } = await setup(3)

    expect((await post(app, runtimeKey, project.slug, 2)).statusCode).toBe(200)

    // 再来 2 条 = 4 > 3，整批拒绝
    const overflow = await post(app, runtimeKey, project.slug, 2)
    expect(overflow.statusCode).toBe(429)
    expect(overflow.json().error).toContain('配额')

    expect((await usage.snapshot(project)).eventsTotal).toBe(2)
    const events = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM issue_events WHERE project_id = ?',
      [project.id]
    )
    expect(Number(events?.n)).toBe(2)
  })

  it('计数器单调：事件被保留策略删掉后，用量不回退', async () => {
    const { app, usage, project, runtimeKey, db } = await setup(1000)

    await post(app, runtimeKey, project.slug, 4)
    expect((await usage.snapshot(project)).eventsTotal).toBe(4)

    // 模拟保留策略把事件删光
    await db.run('DELETE FROM issue_events WHERE project_id = ?', [project.id])

    // 用量仍然记着「这个项目一共摄入过 4 条」——
    // 否则项目只要等 retention 跑完就能把配额洗回来
    expect((await usage.snapshot(project)).eventsTotal).toBe(4)
  })

  it('项目详情接口能读到用量（配额唯一的可观测出口）', async () => {
    const { app, project, runtimeKey } = await setup(1000)

    await post(app, runtimeKey, project.slug, 2)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
      headers: { 'x-vigil-admin-token': ADMIN }
    })

    expect(detail.statusCode).toBe(200)
    expect(detail.json().usage.eventsTotal).toBe(2)
    expect(detail.json().usage.eventQuota).toBe(1000)
  })
})
