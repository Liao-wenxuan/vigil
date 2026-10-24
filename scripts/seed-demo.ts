/**
 * 演示数据种子。
 *
 * ⚠️ 走**真实的 Ingestor** 落库，不用手写 SQL ——
 *    这样种子数据和真实上报的数据在结构、聚合行为、索引上完全一致，
 *    面板看到的就和生产一样。
 *
 * 用法：
 *   npm run seed:demo              # 默认 ./data/vigil.db
 *   npm run seed:demo -- --db ./data/demo.db --reset
 */
import fs from 'node:fs'
import { createDb, defaultDbPath } from '../packages/collector/src/db.js'
import { createApp } from '../packages/collector/src/apps.js'
import { Ingestor } from '../packages/collector/src/ingest.js'
import { SourcemapResolver } from '../packages/collector/src/sourcemap.js'
import { computeFingerprint } from '../packages/sdk/src/fingerprint.js'
import type { ErrorEvent } from '../packages/protocol/src/index.js'

const args = process.argv.slice(2)
const argValue = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 ? args[index + 1] : fallback
}

const dbPath = argValue('db') ?? defaultDbPath()
const shouldReset = args.includes('--reset')

if (shouldReset && fs.existsSync(dbPath)) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
  console.log(`[seed] 已清空 ${dbPath}`)
}

const db = createDb(dbPath)
const resolver = new SourcemapResolver(db)
const ingestor = new Ingestor(db, resolver)

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const MINUTE = 60 * 1000

/**
 * 种子事件。
 *
 * `copies` 表示这条错误发生过多少次 —— 同一条错误要多次投喂，
 * 才能看出聚合的效果（count 累加到几十次）。
 * 这个字段不是协议的一部分，落库前会剥掉。
 */
type SeedEvent = ErrorEvent & { copies?: number }

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
  count?: number
  release?: string
}): SeedEvent {
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
    environment: 'production',
    occurredAt: options.occurredAt,
    copies: options.count ?? 1
  }
}

/** 造一条接口错误事件 */
function httpEvent(options: {
  method: string
  url: string
  status: number
  occurredAt: number
  userAgent?: string
  count?: number
}): SeedEvent {
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
    release: '1.4.2',
    environment: 'production',
    occurredAt: options.occurredAt,
    copies: options.count ?? 1,
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
}): SeedEvent {
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
    copies: 1,
    resource: { tag: options.tag, src: options.src, type: options.type }
  }
}

/** 造一条 Promise 拒绝事件 */
function promiseEvent(options: { message: string; occurredAt: number; count?: number }): SeedEvent {
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
    release: '1.4.2',
    environment: 'production',
    occurredAt: options.occurredAt,
    copies: options.count ?? 1
  }
}

const now = Date.now()

// ---- 应用 1：主应用（生产环境，错误多）----
const shop = createApp(db, '购物小程序')

const shopEvents: ErrorEvent[] = [
  jsEvent({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'price')",
    file: 'https://shop.example.com/assets/index-DnB3xK2l.js',
    fn: 'calcDiscount',
    line: 1024,
    url: 'https://shop.example.com/cart',
    occurredAt: now - 2 * HOUR,
    count: 47
  }),
  jsEvent({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'price')",
    file: 'https://shop.example.com/assets/index-DnB3xK2l.js',
    fn: 'calcDiscount',
    line: 1024,
    url: 'https://shop.example.com/cart',
    occurredAt: now - 20 * HOUR,
    count: 12
  }),
  jsEvent({
    name: 'ReferenceError',
    message: 'promoCode is not defined',
    file: 'https://shop.example.com/assets/index-Zz9Yx8Wq.js',
    fn: 'applyPromo',
    line: 2210,
    url: 'https://shop.example.com/checkout',
    occurredAt: now - 5 * HOUR,
    userAgent: SAFARI_UA,
    count: 8
  }),
  promiseEvent({
    message: 'Payment gateway timeout after 15000ms',
    occurredAt: now - 40 * MINUTE,
    count: 5
  }),
  httpEvent({
    method: 'POST',
    url: 'https://shop.example.com/api/orders?couponId=881',
    status: 500,
    occurredAt: now - 3 * HOUR,
    count: 23
  }),
  httpEvent({
    method: 'GET',
    url: 'https://shop.example.com/api/products/1024',
    status: 502,
    occurredAt: now - 26 * HOUR,
    count: 6
  }),
  httpEvent({
    method: 'POST',
    url: 'https://shop.example.com/api/pay/confirm',
    status: 504,
    occurredAt: now - 90 * MINUTE,
    userAgent: ANDROID_UA,
    count: 4
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

// ---- 应用 2：内容平台（staging，错误少）----
const blog = createApp(db, '内容平台')

const blogEvents: ErrorEvent[] = [
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
    count: 3
  }),
  httpEvent({
    method: 'GET',
    url: 'https://blog.example.com/api/posts?page=2',
    status: 500,
    occurredAt: now - 12 * HOUR,
    userAgent: SAFARI_UA
  })
]

let totalEvents = 0

for (const [app, events] of [
  [shop, shopEvents],
  [blog, blogEvents]
] as const) {
  for (const seed of events) {
    const copies = seed.copies ?? 1
    const batch: ErrorEvent[] = []

    for (let i = 0; i < copies; i++) {
      // 同一个错误的多次发生分布在过去 7 天内
      // copies 是种子专用字段，落库前剥掉 —— 它不是协议的一部分
      const { copies: _copies, ...raw } = seed
      const event: ErrorEvent = {
        ...raw,
        occurredAt: seed.occurredAt - i * (7 * HOUR) - ((seed.occurredAt + i * 977) % HOUR)
      }

      // 指纹是**客户端**算的（SDK 的职责）。种子必须走同一条路，
      // 否则所有事件的指纹都是空串，会被聚合成一条 ——
      // 数据看着有量，实际全是同一条错误。
      event.fingerprint = computeFingerprint({
        category: event.category,
        name: event.name,
        message: event.message,
        frames: event.frames,
        resource: event.resource,
        http: event.http
      })

      batch.push(event)
    }

    ingestor.ingest(app.appId, batch)
    totalEvents += batch.length
  }
}

const errorCount = (db.prepare('SELECT COUNT(*) AS n FROM errors').get() as { n: number }).n
const occurrenceCount = (
  db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM errors').get() as { n: number }
).n

console.log('')
console.log('[seed] 演示数据写入完成')
console.log(`  数据库      ${dbPath}`)
console.log(`  应用        ${shop.name} (${shop.appId}) / ${blog.name} (${blog.appId})`)
console.log(`  去重错误    ${errorCount} 条`)
console.log(`  累计发生    ${occurrenceCount} 次（写入 ${totalEvents} 条事件）`)
console.log('')
console.log('  运行时 token（上报用）：')
console.log(`    ${shop.name}  ${shop.token}`)
console.log(`    ${blog.name}  ${blog.token}`)
console.log('')
console.log('  上传 token（sourcemap 用，只在 CI）：')
console.log(`    ${shop.name}  ${shop.uploadToken}`)
console.log('')

db.close()
