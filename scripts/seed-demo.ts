/**
 * 演示数据种子。
 *
 * ⚠️ 走**真实的领域服务**落库（TenancyService / IssueService / PerformanceService），
 *    不用手写 SQL —— 这样种子数据和真实上报在结构、聚合行为、索引上完全一致，
 *    面板看到的就和生产一样。
 *
 * 用法：
 *   npm run seed:demo              # 默认 ./data/vigil.db
 *   npm run seed:demo -- --reset   # 先清空
 */
import fs from 'node:fs'
import { openDb, defaultDbPath } from '../packages/collector/src/infra/db/client.js'
import { TenancyService } from '../packages/collector/src/domains/tenancy/service.js'
import { IssueService } from '../packages/collector/src/domains/issues/service.js'
import { PerformanceService } from '../packages/collector/src/domains/performance/service.js'
import { ArtifactService } from '../packages/collector/src/domains/artifacts/service.js'
import { AlertingService } from '../packages/collector/src/domains/alerting/service.js'
import { ReplayService } from '../packages/collector/src/domains/replay/service.js'
import { computeFingerprint } from '../packages/sdk/src/fingerprint.js'
import type {
  BehaviorEvent,
  ErrorEvent,
  PerformanceEvent,
  ReplayEvent
} from '../packages/protocol/src/index.js'

const args = process.argv.slice(2)
const argValue = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 ? args[index + 1] : fallback
}

const dbPath = argValue('db') ?? defaultDbPath()
const shouldReset = args.includes('--reset')

if (shouldReset) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
  console.log(`[seed] 已清空 ${dbPath}`)
}

const db = openDb(dbPath)
const tenancy = new TenancyService(db)
const artifacts = new ArtifactService(db)
const issues = new IssueService(db, artifacts.sourcemapResolver)
const performance = new PerformanceService(db)
const alerting = new AlertingService(db)
const replayService = new ReplayService(db)

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const MINUTE = 60 * 1000

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/** 造一条 JS 错误事件 */
function jsEvent(options: {
  name: string
  message: string
  file: string
  fn: string
  line: number
  url: string
  occurredAt: number
  userAgent?: string
  release?: string
  environment?: string
}): ErrorEvent {
  const stack = [
    `${options.name}: ${options.message}`,
    `    at ${options.fn} (${options.file}:${options.line}:17)`,
    `    at async loadPage (${options.file}:${options.line + 40}:5)`
  ].join('\n')

  return {
    category: 'javascript',
    kind: 'js',
    name: options.name,
    message: options.message,
    stack,
    frames: [
      { filename: options.file, functionName: options.fn, lineno: options.line, colno: 17 },
      { filename: options.file, functionName: 'loadPage', lineno: options.line + 40, colno: 5 }
    ],
    fingerprint: '',
    url: options.url,
    userAgent: options.userAgent ?? CHROME_UA,
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    viewport: { width: 1920, height: 1080 },
    sessionId: `sess_${options.occurredAt}`,
    release: options.release ?? '1.4.2',
    environment: options.environment ?? 'production',
    occurredAt: options.occurredAt,
    userId: `u_${options.occurredAt % 97}`
  }
}

/** 造一条接口错误事件 */
function httpEvent(options: {
  method: string
  url: string
  status: number
  occurredAt: number
  userAgent?: string
  release?: string
}): ErrorEvent {
  return {
    category: 'http',
    kind: 'http',
    name: 'HttpError',
    message: `HTTP ${options.status} ${options.method} ${options.url.split('?')[0]}`,
    frames: [],
    fingerprint: '',
    url: 'https://shop.example.com/api/orders',
    userAgent: options.userAgent ?? CHROME_UA,
    sessionId: `sess_${options.occurredAt}`,
    release: options.release ?? '1.4.2',
    environment: 'production',
    occurredAt: options.occurredAt,
    http: {
      method: options.method,
      url: options.url,
      status: options.status,
      durationMs: 1200 + (options.occurredAt % 3000)
    }
  }
}

/** 造一条资源加载失败事件 */
function resourceEvent(options: {
  src: string
  tag: string
  type: string
  occurredAt: number
}): ErrorEvent {
  return {
    category: 'resource',
    kind: 'resource',
    name: 'ResourceLoadError',
    message: `Failed to load ${options.tag}: ${options.src}`,
    frames: [],
    fingerprint: '',
    url: 'https://shop.example.com/product/1024',
    userAgent: ANDROID_UA,
    sessionId: `sess_${options.occurredAt}`,
    release: '1.4.2',
    environment: 'production',
    occurredAt: options.occurredAt,
    resource: { tag: options.tag, src: options.src, type: options.type }
  }
}

/** 造一条 Promise 拒绝事件 */
function promiseEvent(options: {
  message: string
  occurredAt: number
  release?: string
}): ErrorEvent {
  return {
    category: 'javascript',
    kind: 'promise',
    name: 'Error',
    message: options.message,
    stack: `Error: ${options.message}\n    at submitOrder (https://shop.example.com/src/api/order.ts:88:12)`,
    frames: [
      {
        filename: 'https://shop.example.com/src/api/order.ts',
        functionName: 'submitOrder',
        lineno: 88,
        colno: 12
      }
    ],
    fingerprint: '',
    url: 'https://shop.example.com/checkout',
    userAgent: SAFARI_UA,
    sessionId: `sess_${options.occurredAt}`,
    release: options.release ?? '1.4.2',
    environment: 'production',
    occurredAt: options.occurredAt
  }
}

/** 造一个性能事务 */
function transaction(options: {
  name: string
  occurredAt: number
  lcp: number
  fcp: number
  inp: number
  cls: number
  durationMs: number
  browser?: string
  spans?: Array<{
    name: string
    type: 'http' | 'resource' | 'dom' | 'custom'
    durationMs: number
    statusCode?: number
  }>
}): PerformanceEvent {
  return {
    name: options.name,
    type: 'page',
    startedAt: options.occurredAt,
    durationMs: options.durationMs,
    vitals: {
      fcp: options.fcp,
      lcp: options.lcp,
      cls: options.cls,
      inp: options.inp,
      ttfb: 180 + (options.occurredAt % 120),
      tbt: 40 + (options.occurredAt % 200),
      longTaskCount: options.occurredAt % 3
    },
    resourceCount: 18 + (options.occurredAt % 12),
    transferSize: 380000 + (options.occurredAt % 250000),
    pageUrl: `https://shop.example.com${options.name}`,
    userAgent: options.browser ?? CHROME_UA,
    sessionId: `sess_${options.occurredAt}`,
    release: '1.4.2',
    environment: 'production',
    spans: options.spans
  }
}

const now = Date.now()

// ============================================================
// 租户
// ============================================================
const organization = tenancy.createOrganization('示例科技', 'example')
const team = tenancy.createTeam(organization.id, '前端组', 'frontend')

const shop = tenancy.createProject({
  organizationId: organization.id,
  teamId: team.id,
  name: '购物小程序',
  slug: 'shop-miniapp',
  platform: 'vue'
})

const blog = tenancy.createProject({
  organizationId: organization.id,
  teamId: team.id,
  name: '内容平台',
  slug: 'content-platform',
  platform: 'react'
})

// 环境与版本
for (const project of [shop, blog]) {
  tenancy.createEnvironment(project.project.id, 'production', '生产环境', true)
  tenancy.createEnvironment(project.project.id, 'staging', '预发环境', false)
  tenancy.createEnvironment(project.project.id, 'development', '开发环境', false)
}
tenancy.createRelease(shop.project.id, '1.4.2', 'a1b2c3d')
tenancy.createRelease(shop.project.id, '1.4.3', 'e4f5g6h')
tenancy.createRelease(shop.project.id, '1.4.1', 'x9y8z7w')
tenancy.createRelease(blog.project.id, '0.9.0-beta.3')

// ============================================================
// 问题
// ============================================================
/** 指纹必须由**客户端算法**算 —— 服务端只是接收它 */
function withFingerprint(event: ErrorEvent): ErrorEvent {
  return {
    ...event,
    fingerprint: computeFingerprint({
      category: event.category,
      name: event.name,
      message: event.message,
      frames: event.frames,
      resource: event.resource,
      http: event.http
    })
  }
}

const shopTemplates: ErrorEvent[] = [
  jsEvent({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'price')",
    file: 'https://shop.example.com/assets/index-DnB3xK2l.js',
    fn: 'calcDiscount',
    line: 1024,
    url: 'https://shop.example.com/cart',
    occurredAt: now - 2 * HOUR
  }),
  jsEvent({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'price')",
    file: 'https://shop.example.com/assets/index-DnB3xK2l.js',
    fn: 'calcDiscount',
    line: 1024,
    url: 'https://shop.example.com/cart',
    occurredAt: now - 20 * HOUR
  }),
  jsEvent({
    name: 'ReferenceError',
    message: 'promoCode is not defined',
    file: 'https://shop.example.com/assets/index-Zz9Yx8Wq.js',
    fn: 'applyPromo',
    line: 2210,
    url: 'https://shop.example.com/checkout',
    occurredAt: now - 5 * HOUR,
    userAgent: SAFARI_UA
  }),
  promiseEvent({
    message: 'Payment gateway timeout after 15000ms',
    occurredAt: now - 40 * MINUTE
  }),
  httpEvent({
    method: 'POST',
    url: 'https://shop.example.com/api/orders?couponId=881',
    status: 500,
    occurredAt: now - 3 * HOUR
  }),
  httpEvent({
    method: 'GET',
    url: 'https://shop.example.com/api/products/1024',
    status: 502,
    occurredAt: now - 26 * HOUR
  }),
  httpEvent({
    method: 'POST',
    url: 'https://shop.example.com/api/pay/confirm',
    status: 504,
    occurredAt: now - 90 * MINUTE,
    userAgent: ANDROID_UA
  }),
  resourceEvent({
    src: 'https://cdn.example.com/uploads/8821-large.jpg',
    tag: 'img',
    type: 'image',
    occurredAt: now - 7 * HOUR
  }),
  resourceEvent({
    src: 'https://cdn.example.com/static/vendor-DnB3xK2l.js',
    tag: 'script',
    type: 'script',
    occurredAt: now - 4 * DAY
  })
]

// 每条错误重复发生多次（不同时间戳）→ 聚合后 count 会累加
const REPEAT = [47, 12, 8, 5, 23, 6, 4, 1, 1]

let totalEvents = 0
for (const [index, template] of shopTemplates.entries()) {
  const repeats = REPEAT[index] ?? 1
  for (let i = 0; i < repeats; i++) {
    const event = withFingerprint({
      ...template,
      occurredAt: template.occurredAt - i * 6 * HOUR - (i % 5) * 37 * MINUTE
    })
    issues.ingestEvent(shop.project.id, event)
    totalEvents++
  }
}

const blogTemplates: ErrorEvent[] = [
  jsEvent({
    name: 'RangeError',
    message: 'Maximum call stack size exceeded',
    file: 'https://blog.example.com/assets/editor.js',
    fn: 'flattenTree',
    line: 312,
    url: 'https://blog.example.com/admin/editor',
    occurredAt: now - 30 * HOUR,
    userAgent: SAFARI_UA,
    release: '0.9.0-beta.3',
    environment: 'staging'
  }),
  httpEvent({
    method: 'GET',
    url: 'https://blog.example.com/api/posts?page=2',
    status: 500,
    occurredAt: now - 12 * HOUR,
    userAgent: SAFARI_UA
  })
]

for (const template of blogTemplates) {
  issues.ingestEvent(blog.project.id, withFingerprint(template))
  totalEvents++
}

// ---- 一个已解决的问题 + 一个回归，演示完整生命周期 ----
const resolvedOutcome = issues.ingestEvent(
  shop.project.id,
  withFingerprint(
    jsEvent({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'total')",
      file: 'https://shop.example.com/assets/index-DnB3xK2l.js',
      fn: 'sumCart',
      line: 880,
      url: 'https://shop.example.com/cart',
      occurredAt: now - 3 * DAY,
      release: '1.4.1'
    })
  )
)
issues.resolve(shop.project.id, resolvedOutcome.issueId, {
  release: '1.4.2',
  reason: '已在 1.4.2 修复空指针'
})
// 在更新版本又出现 → 判为回归
issues.ingestEvent(
  shop.project.id,
  withFingerprint(
    jsEvent({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'total')",
      file: 'https://shop.example.com/assets/index-DnB3xK2l.js',
      fn: 'sumCart',
      line: 880,
      url: 'https://shop.example.com/cart',
      occurredAt: now - 1 * HOUR,
      release: '1.4.3'
    })
  )
)
totalEvents++

// ---- 一个归档的问题，演示「归档直到升级」策略 ----
const archivedOutcome = issues.ingestEvent(
  shop.project.id,
  withFingerprint(
    httpEvent({
      method: 'GET',
      url: 'https://shop.example.com/api/recommend',
      status: 503,
      occurredAt: now - 2 * DAY
    })
  )
)
issues.archive(shop.project.id, archivedOutcome.issueId, {
  strategy: 'until_escalating',
  reason: '推荐服务偶尔抖动，先归档'
})

// ============================================================
// 用户行为与会话回放
// ============================================================
//
// 行为数据走**真实的 BehaviorService**（行为域），回放走 **ReplayService**。
// 不手写 SQL —— 这样种子数据和真实上报在结构、聚合上完全一致。
const behaviorPages = ['/', '/cart', '/checkout', '/product/1024', '/order/list', '/me']
let behaviorCount = 0

for (let session = 0; session < 40; session++) {
  const sessionId = `sess_demo_${session}`
  const userId = `u_${session % 12}`
  const startedAt = now - session * 3 * HOUR - (session % 5) * 17 * MINUTE
  const path: string[] = []
  const events: BehaviorEvent[] = []

  // 每次会话 2~5 步
  const steps = 2 + (session % 4)
  for (let step = 0; step < steps; step++) {
    const page = behaviorPages[(session + step) % behaviorPages.length]
    path.push(page)

    events.push({
      type: step === 0 ? 'pageview' : 'route',
      name: page,
      url: `https://shop.example.com${page}`,
      timestamp: startedAt + step * 45_000,
      durationMs: 12_000 + ((session * 7 + step * 13) % 40_000),
      sessionId,
      userId
    })

    // 偶尔点一下
    if (step > 0 && (session + step) % 3 === 0) {
      events.push({
        type: 'click',
        name: `button:立即购买`,
        url: `https://shop.example.com${page}`,
        timestamp: startedAt + step * 45_000 + 3_000,
        durationMs: 900,
        sessionId,
        userId,
        data: { tag: 'button' }
      })
    }
  }

  replayService.ingestBehavior(shop.project.id, {
    appId: shop.project.slug,
    sdk: { name: '@vigil/sdk', version: '0.1.0' },
    events,
    session: {
      sessionId,
      userId,
      startedAt,
      endedAt: startedAt + steps * 45_000,
      durationMs: steps * 45_000,
      pageViews: 1,
      entryPage: path[0],
      exitPage: path[path.length - 1],
      path,
      userAgent: CHROME_UA,
      referrer: 'https://www.google.com/'
    }
  })
  behaviorCount += events.length
}

// 造一份回放事件流（rrweb 格式：Meta + FullSnapshot + 增量）
//
// type 4 = Meta，type 3 = FullSnapshot，type 2 = IncrementalSnapshot
// 真实回放流是连续的，播放器依赖第一个 FullSnapshot 建立 DOM 镜像。
const replaySessionId = 'sess_demo_replay'
const replayEvents: ReplayEvent[] = [
  {
    type: 4,
    data: { href: 'https://shop.example.com/cart', width: 1440, height: 900 },
    timestamp: now - 300_000
  },
  {
    type: 3,
    data: { node: { type: 0, childNodes: [], id: 1, tagName: 'html' } },
    timestamp: now - 300_000
  },
  {
    type: 3,
    data: { node: { type: 0, childNodes: [], id: 2, tagName: 'body' } },
    timestamp: now - 299_990
  },
  {
    type: 3,
    data: {
      node: { type: 1, childNodes: [], id: 3, tagName: 'div', attributes: { class: 'cart' } }
    },
    timestamp: now - 299_980
  },
  { type: 2, data: { source: 3, adds: [], removes: [], text: '购物车' }, timestamp: now - 299_000 }
]
replayService.saveReplay(shop.project.id, replaySessionId, {
  events: replayEvents,
  droppedSegments: 0,
  bytes: JSON.stringify(replayEvents).length
})

// 让一个错误带上这份回放（回放就是随错误一起送来的）
const replayOutcome = issues.ingestEvent(
  shop.project.id,
  withFingerprint(
    jsEvent({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'subtotal')",
      file: 'https://shop.example.com/assets/index-DnB3xK2l.js',
      fn: 'calcSubtotal',
      line: 1420,
      url: 'https://shop.example.com/cart',
      occurredAt: now - 4 * MINUTE
    })
  )
)
// 给事件补上回放与 sessionId
db.run(`UPDATE issue_events SET session_id = ?, vitals_json = ? WHERE issue_id = ?`, [
  replaySessionId,
  JSON.stringify({ lcp: 2400, fcp: 1100, inp: 180, longTaskCount: 2 }),
  replayOutcome.issueId
])
replayService.upsertSession(shop.project.id, {
  sessionId: replaySessionId,
  userId: 'u_replay',
  startedAt: now - 6 * MINUTE,
  endedAt: now,
  durationMs: 6 * MINUTE,
  pageViews: 2,
  entryPage: '/',
  exitPage: '/cart',
  path: ['/', '/cart'],
  userAgent: CHROME_UA,
  referrer: 'https://shop.example.com/'
})
replayService.incrementSessionError(shop.project.id, replaySessionId)

// ============================================================
// 性能
// ============================================================
const pages = ['/', '/cart', '/checkout', '/product/1024', '/order/list']
let totalTransactions = 0

for (let i = 0; i < 160; i++) {
  const name = pages[i % pages.length]
  const slow = name === '/checkout'
  performance.ingestTransaction(
    shop.project.id,
    transaction({
      name,
      occurredAt: now - i * 45 * MINUTE,
      fcp: slow ? 1400 + (i % 900) : 600 + (i % 400),
      lcp: slow ? 3200 + (i % 1800) : 1200 + (i % 700),
      inp: slow ? 320 + (i % 260) : 80 + (i % 90),
      cls: Math.round((slow ? 0.14 + (i % 10) / 100 : 0.02 + (i % 5) / 100) * 10000) / 10000,
      durationMs: slow ? 4200 + (i % 2000) : 1500 + (i % 900),
      browser: i % 5 === 0 ? SAFARI_UA : i % 7 === 0 ? ANDROID_UA : CHROME_UA,
      spans: [
        { name: 'GET /api/products', type: 'http', durationMs: 120 + (i % 300), statusCode: 200 },
        { name: 'GET /api/recommend', type: 'http', durationMs: 260 + (i % 900), statusCode: 200 },
        { name: 'POST /api/orders', type: 'http', durationMs: 400 + (i % 1200), statusCode: 200 }
      ]
    })
  )
  totalTransactions++
}

// ============================================================
// 告警
// ============================================================
const webhook = alerting.createChannel({
  projectId: shop.project.id,
  name: '前端群 Webhook',
  type: 'webhook',
  config: { url: 'https://hooks.example.com/vigil' }
})

const feishu = alerting.createChannel({
  projectId: shop.project.id,
  name: '飞书告警群',
  type: 'feishu',
  config: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx' }
})

alerting.createRule({
  projectId: shop.project.id,
  name: '新问题出现',
  type: 'issue.new',
  threshold: 1,
  windowSeconds: 300,
  channelIds: [feishu.id]
})

alerting.createRule({
  projectId: shop.project.id,
  name: '单问题 10 分钟内超过 20 次',
  type: 'issue.count',
  threshold: 20,
  windowSeconds: 600,
  conditions: { environment: ['production'] },
  channelIds: [feishu.id, webhook.id]
})

alerting.createRule({
  projectId: shop.project.id,
  name: 'LCP P95 超过 2.5 秒',
  type: 'metric.lcp_p95',
  threshold: 2500,
  windowSeconds: 900,
  channelIds: [webhook.id]
})

// ============================================================
// 汇总
// ============================================================
const stats = issues.stats(shop.project.id)
const perf = performance.summary({ projectId: shop.project.id })

console.log('')
console.log('[seed] 演示数据写入完成')
console.log(`  数据库        ${dbPath}`)
console.log(`  组织 / 团队   ${organization.name} / ${team.name}`)
console.log(
  `  项目          ${shop.project.name} (${shop.project.id}) / ${blog.project.name} (${blog.project.id})`
)
console.log(`  去重问题      ${stats.total} 条（累计 ${stats.occurrences} 次）`)
console.log(`  写入事件      ${totalEvents} 条`)
console.log(
  `    待处理      ${stats.unresolved}（新建 ${stats.new} · 回归 ${stats.regressed} · 升级 ${stats.escalating}）`
)
console.log(`    已解决      ${stats.resolved}   已归档 ${stats.archived}`)
console.log(`  性能事务      ${totalTransactions} 条（LCP P95 ${perf.vitals.lcp.p95}ms）`)
console.log(`  行为事件      ${behaviorCount} 条`)
console.log(`  告警规则      3 条 · 通知通道 2 个`)
console.log('')
console.log('  ⚠️  密钥只显示这一次，数据库里只存哈希：')
console.log(`     运行时（上报用）  ${shop.runtimeKey}`)
console.log(`     上传（sourcemap）  ${shop.uploadKey}`)
console.log('')

db.close()
