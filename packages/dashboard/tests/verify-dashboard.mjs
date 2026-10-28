/**
 * 管理面板的端到端验证。
 *
 * ## 验证的是数字，不是截图
 *
 * 面板是给人看的东西，但「看起来对」不等于「渲染对了」。
 * 所以这里的每一条断言都落在 **DOM 里实际渲染出来的文本**上，
 * 并且把实际值打印出来 —— 失败时能直接看出「期望多少、实际多少」。
 *
 * ## 脚本自己保证有数据
 *
 * 没有数据的面板验证不了。所以脚本会先检查采集服务里有没有项目，
 * 没有就建一个，并上报几条不同指纹的错误与几条性能事务，
 * 让「去重错误 / 发生次数 / LCP P95」这些数字有东西可断言。
 *
 * ## 依赖没起来时的行为
 *
 * 采集服务（4318）或面板（5174）没起 → **优雅失败**：
 * 说清楚是哪个没起、怎么起，然后以非 0 退出码结束，不抛栈。
 *
 * 用法：
 *   node packages/dashboard/tests/verify-dashboard.mjs --url http://localhost:5174
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)

function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index !== -1 ? args[index + 1] : fallback
}

const dashboardUrl = argValue('url', 'http://localhost:5174')
const collectorUrl = argValue('collector', 'http://127.0.0.1:4318')
const adminToken = process.env.VIGIL_ADMIN_TOKEN ?? 'vigil_admin_demo'

const results = []

function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name} — ${detail}`)
}

function fail(message) {
  console.log(`\n[Vigil 面板验证] 无法继续：${message}\n`)
  process.exit(1)
}

/* ============================================================
 * HTTP 辅助
 * ============================================================ */

async function ping(url, label) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return true
  } catch (error) {
    fail(
      `${label} 没起来（${url}）：${error instanceof Error ? error.message : String(error)}\n` +
        '  · 采集服务：cd D:\\my\\vigil; npm run dev:collector\n' +
        '  · 管理面板：cd D:\\my\\vigil; npm run dev:dashboard'
    )
    return false
  }
}

/** 走面板自己的代理读接口 —— 和页面里发出的请求是同一条路径 */
async function api(pathname) {
  const response = await fetch(`${dashboardUrl}/api/v1${pathname}`, {
    headers: { Accept: 'application/json' }
  })
  const text = await response.text()
  if (!response.ok)
    throw new Error(`GET ${pathname} → HTTP ${response.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

/** 直连采集服务写数据（上报接口用项目密钥鉴权，不走面板代理） */
async function ingest(pathname, body, headers = {}) {
  const response = await fetch(`${collectorUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`POST ${pathname} → HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  return text ? JSON.parse(text) : {}
}

/* ============================================================
 * 演示数据
 * ============================================================ */

const ORG_NAME = 'Vigil 验证'
const PROJECT_NAME = '验证演示项目'
const PROJECT_SLUG = 'verify-demo'
/** 面板把选中的项目记在这个键上 —— 脚本注入它，保证页面显示的就是被断言的项目 */
const PROJECT_STORAGE_KEY = 'vigil.projectId'

function fingerprint(label) {
  // 指纹必须是 16 位十六进制 —— 服务端会校验
  let hash = 0
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hex = hash.toString(16).padStart(8, '0')
  return (hex + hex).slice(0, 16)
}

function errorEvent(options) {
  return {
    category: options.category ?? 'javascript',
    kind: options.kind ?? 'js',
    name: options.name ?? 'TypeError',
    message: options.message,
    stack: options.stack,
    frames: options.frames ?? [
      { filename: 'index-DnB3xK2l.js', lineno: 1, colno: 2345, functionName: 'renderList' }
    ],
    fingerprint: options.fingerprint,
    url: options.url ?? 'https://example.com/posts',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
    sessionId: options.sessionId ?? 'session-demo',
    userId: options.userId,
    release: options.release ?? '1.1.0',
    environment: options.environment ?? 'production',
    occurredAt: options.occurredAt ?? Date.now(),
    eventId: options.eventId,
    vitals: options.vitals ?? {
      fcp: 820,
      lcp: 1640,
      cls: 0.04,
      inp: 120,
      ttfb: 90,
      longTaskCount: 1
    }
  }
}

async function ensureDemoData() {
  // ---- 专用的验证项目 ----
  // 不复用库里已有的项目：历史数据可能是直接写库造的（没有活动流、没有事件明细），
  // 断言会落在一堆空数组上，验不出东西。
  const orgsBody = await api('/organizations')
  const orgs = orgsBody.organizations ?? []

  let organization = null
  let project = null

  for (const org of orgs) {
    const body = await api(`/organizations/${org.id}/projects`)
    const found = (body.projects ?? []).find((item) => item.slug === PROJECT_SLUG)
    if (found) {
      organization = org
      project = found
      break
    }
  }

  if (!project) {
    organization =
      orgs.find((org) => org.name === ORG_NAME) ??
      (
        await ingest(
          '/api/v1/organizations',
          { name: ORG_NAME },
          {
            'x-vigil-admin-token': adminToken
          }
        )
      ).organization

    const created = await ingest(
      `/api/v1/organizations/${organization.id}/projects`,
      { name: PROJECT_NAME, slug: PROJECT_SLUG, platform: 'vue' },
      { 'x-vigil-admin-token': adminToken }
    )
    project = created.project
    console.log(`  · 已创建验证项目：${project.name}（${project.slug}，#${project.id}）`)
  }

  // 运行时密钥的明文只在创建 / 轮换时返回 —— 轮换一把拿到可用的明文
  const rotated = await ingest(
    `/api/v1/projects/${project.id}/keys/rotate`,
    { kind: 'runtime' },
    { 'x-vigil-admin-token': adminToken }
  )
  const runtimeKey = rotated.key

  // 环境与版本：回归判定需要版本锚
  const detail = await api(`/projects/${project.id}`)
  if ((detail.environments ?? []).length === 0) {
    for (const [slug, name, isProduction] of [
      ['production', '生产环境', true],
      ['staging', '预发环境', false]
    ]) {
      await ingest(
        `/api/v1/projects/${project.id}/environments`,
        { slug, name, isProduction },
        { 'x-vigil-admin-token': adminToken }
      )
    }
    console.log('  · 已创建 2 个环境')
  }
  if ((detail.releases ?? []).length === 0) {
    for (const version of ['1.0.0', '1.1.0']) {
      await ingest(
        `/api/v1/projects/${project.id}/releases`,
        { version, commitSha: version === '1.1.0' ? 'a1b2c3d' : '9f8e7d6' },
        { 'x-vigil-admin-token': adminToken }
      )
    }
    console.log('  · 已创建 2 个版本')
  }

  const stats = await api(`/projects/${project.id}/stats`)
  if ((stats.stats?.total ?? 0) === 0) {
    await seedIssues(project, runtimeKey)
  }

  const perf = await api(`/projects/${project.id}/performance`)
  if ((perf.summary?.transactions ?? 0) === 0) {
    await seedPerformance(project, runtimeKey)
  }

  await seedAlerts(project.id)
  await seedReplayAndBehavior(project, runtimeKey)

  return project
}

/**
 * 造一份回放事件流。
 *
 * 事件编号必须和 rrweb 对上（`@rrweb/types` 的 EventType）：
 *   2 = 全量快照、3 = 增量快照、4 = Meta
 *
 * 写错的后果很隐蔽：播放器按编号分派，编号错了就**静默播不出来**。
 * 节点类型同理（NodeType）：0 = Document、2 = Element、3 = Text。
 */
function replayStream(base) {
  return [
    {
      type: 4,
      timestamp: base,
      data: { href: 'https://example.com/cart', width: 1280, height: 800 }
    },
    {
      type: 2,
      timestamp: base,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'html',
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 3,
                  tagName: 'body',
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 4,
                      tagName: 'div',
                      attributes: { class: 'cart' },
                      childNodes: [{ type: 3, id: 5, textContent: '购物车' }]
                    }
                  ]
                }
              ]
            }
          ]
        },
        initialOffset: { left: 0, top: 0 }
      }
    },
    {
      type: 3,
      timestamp: base + 1000,
      data: {
        source: 0,
        adds: [{ type: 3, id: 6, parentId: 4, textContent: '共 3 件商品' }],
        removes: [],
        text: '共 3 件商品'
      }
    }
  ]
}

/**
 * 播种回放与行为数据。
 *
 * 回放**随错误一起上报**（挂在事件上），行为走**独立通道** —— 两者的
 * 上报路径不一样，路径不一样就容易只通一条，所以这里两条都验。
 */
async function seedReplayAndBehavior(project, runtimeKey) {
  const now = Date.now()
  const sessionId = 'session-replay-verify'

  const behavior = await api(`/projects/${project.id}/behavior/summary`)
  if ((behavior.summary?.sessions ?? 0) === 0) {
    await ingest(
      '/api/v1/behavior',
      {
        appId: String(project.id),
        sdk: { name: 'vigil-sdk', version: '0.1.0' },
        events: [
          {
            type: 'pageview',
            name: '/market',
            url: 'https://example.com/market',
            timestamp: now - 3000
          },
          {
            type: 'click',
            name: 'button:去结算',
            url: 'https://example.com/market',
            timestamp: now - 2000
          },
          {
            type: 'route',
            name: '/checkout',
            url: 'https://example.com/checkout',
            timestamp: now - 1000
          }
        ],
        session: {
          sessionId,
          userId: 'user-verify',
          startedAt: now - 5000,
          endedAt: now,
          durationMs: 5000,
          pageViews: 1,
          entryPage: '/market',
          exitPage: '/checkout',
          path: ['/market', '/checkout'],
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
        }
      },
      { 'x-vigil-token': runtimeKey }
    )
    console.log('  · 已上报 3 条行为事件')
  }

  const sessions = await api(`/projects/${project.id}/sessions`)
  const hasReplay = (sessions.sessions ?? []).some((row) => row.hasReplay)
  if (!hasReplay) {
    await ingest(
      '/api/v1/collect',
      {
        appId: String(project.id),
        sdk: { name: 'vigil-sdk', version: '0.1.0' },
        events: [
          {
            ...errorEvent({
              fingerprint: fingerprint('replay'),
              name: 'TypeError',
              message: "Cannot read properties of undefined (reading 'subtotal')",
              sessionId
            }),
            replay: {
              events: replayStream(now - 4000),
              droppedSegments: 0,
              bytes: 2048
            }
          }
        ]
      },
      { 'x-vigil-token': runtimeKey }
    )
    console.log('  · 已上报 1 条带回放的事件')
  }
}

async function seedIssues(project, runtimeKey) {
  const now = Date.now()
  const priceFingerprint = fingerprint('price')
  const refFingerprint = fingerprint('reference')
  const resourceFingerprint = fingerprint('resource')
  const httpFingerprint = fingerprint('http')
  const regressedFingerprint = fingerprint('regressed')

  const events = []

  // 同一指纹多次上报 → 次数累加
  for (let i = 0; i < 6; i++) {
    events.push(
      errorEvent({
        fingerprint: priceFingerprint,
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'price')",
        userId: `user-${i + 1}`,
        eventId: `evt-price-${i}`,
        occurredAt: now - (6 - i) * 60_000,
        stack:
          "TypeError: Cannot read properties of undefined (reading 'price')\n" +
          '    at renderList (index-DnB3xK2l.js:1:2345)\n' +
          '    at setup (index-DnB3xK2l.js:1:9012)'
      })
    )
  }

  for (let i = 0; i < 3; i++) {
    events.push(
      errorEvent({
        fingerprint: refFingerprint,
        name: 'ReferenceError',
        message: 'sidebar is not defined',
        userId: `user-${i + 1}`,
        eventId: `evt-ref-${i}`,
        occurredAt: now - (3 - i) * 120_000
      })
    )
  }

  events.push(
    errorEvent({
      fingerprint: resourceFingerprint,
      category: 'resource',
      kind: 'resource',
      name: 'ResourceError',
      message: '加载图片失败：/static/cover.jpg',
      userId: 'user-1',
      eventId: 'evt-res-1',
      occurredAt: now - 300_000
    })
  )

  for (let i = 0; i < 4; i++) {
    events.push(
      errorEvent({
        fingerprint: httpFingerprint,
        category: 'http',
        kind: 'http',
        name: 'HTTPError',
        message: '请求 /api/v1/posts 失败：HTTP 500',
        userId: `user-${i + 1}`,
        eventId: `evt-http-${i}`,
        occurredAt: now - (4 - i) * 45_000
      })
    )
  }

  // 回归问题：先在 1.0.0 出现 → 解决 → 在 1.1.0 又出现
  const regressedIndex = events.length
  events.push(
    errorEvent({
      fingerprint: regressedFingerprint,
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'total')",
      userId: 'user-1',
      eventId: 'evt-reg-1',
      release: '1.0.0',
      occurredAt: now - 3_600_000
    })
  )

  const collected = await ingest(
    '/api/v1/collect',
    {
      appId: String(project.id),
      sdk: { name: 'vigil-sdk', version: '0.1.0' },
      events
    },
    { 'x-vigil-token': runtimeKey }
  )
  console.log(`  · 已上报 ${collected.accepted} 条错误事件`)

  // 在 1.0.0 上解决它（issueId 直接取上报响应里的映射，不用再猜）
  const issueId = collected.ids?.[String(regressedIndex)]
  if (issueId) {
    await ingest(
      `/api/v1/projects/${project.id}/issues/${issueId}/resolve`,
      { release: '1.0.0', reason: '演示数据：在 1.0.0 修复' },
      { 'x-vigil-admin-token': adminToken }
    )
    console.log(`  · 已把问题 #${issueId} 标记为在 1.0.0 解决`)

    // 新版本再次出现 → 回归
    await ingest(
      '/api/v1/collect',
      {
        appId: String(project.id),
        sdk: { name: 'vigil-sdk', version: '0.1.0' },
        events: [
          errorEvent({
            fingerprint: regressedFingerprint,
            name: 'TypeError',
            message: "Cannot read properties of undefined (reading 'total')",
            userId: 'user-2',
            eventId: 'evt-reg-2',
            release: '1.1.0',
            occurredAt: Date.now()
          })
        ]
      },
      { 'x-vigil-token': runtimeKey }
    )
    console.log('  · 已在 1.1.0 重新上报该问题（应判定为回归）')
  }
}

async function seedPerformance(project, runtimeKey) {
  const now = Date.now()
  const transactions = []

  for (let i = 0; i < 6; i++) {
    transactions.push({
      name: '/posts',
      type: 'route',
      startedAt: now - i * 30_000,
      durationMs: 900 + i * 240,
      vitals: {
        fcp: 700 + i * 90,
        lcp: 1500 + i * 310,
        cls: 0.03 + i * 0.01,
        inp: 90 + i * 25,
        ttfb: 70 + i * 10
      },
      pageUrl: 'https://example.com/posts',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
      sessionId: `session-${i}`,
      userId: `user-${i + 1}`,
      release: '1.1.0',
      environment: 'production',
      resourceCount: 12,
      transferSize: 240_000,
      spans: [
        {
          name: 'GET /api/v1/posts',
          type: 'http',
          durationMs: 320 + i * 90,
          startedAt: now - i * 30_000 + 100,
          statusCode: 200,
          url: 'https://example.com/api/v1/posts'
        },
        {
          name: 'chunk-vendors.js',
          type: 'resource',
          durationMs: 120 + i * 20,
          startedAt: now - i * 30_000 + 50
        }
      ]
    })
  }

  for (let i = 0; i < 3; i++) {
    transactions.push({
      name: '/market',
      type: 'route',
      startedAt: now - i * 45_000,
      durationMs: 1800 + i * 420,
      vitals: {
        fcp: 950 + i * 120,
        lcp: 2600 + i * 520,
        cls: 0.06 + i * 0.02,
        inp: 180 + i * 40,
        ttfb: 140
      },
      pageUrl: 'https://example.com/market',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36',
      sessionId: `session-m${i}`,
      userId: `user-${i + 1}`,
      release: '1.1.0',
      environment: 'production',
      resourceCount: 24,
      transferSize: 880_000,
      spans: [
        {
          name: 'GET /api/v1/orders',
          type: 'http',
          durationMs: 780 + i * 210,
          startedAt: now - i * 45_000 + 120,
          statusCode: 200,
          url: 'https://example.com/api/v1/orders'
        }
      ]
    })
  }

  const accepted = await ingest(
    '/api/v1/performance',
    {
      appId: String(project.id),
      sdk: { name: 'vigil-sdk', version: '0.1.0' },
      transactions
    },
    { 'x-vigil-token': runtimeKey }
  )
  console.log(`  · 已上报 ${accepted.accepted} 条性能事务`)
}

async function seedAlerts(projectId) {
  const rules = await api(`/projects/${projectId}/alert-rules`)
  if ((rules.rules ?? []).length === 0) {
    await ingest(
      `/api/v1/projects/${projectId}/channels`,
      { name: '研发群机器人', type: 'webhook', config: { url: 'https://example.com/hook' } },
      { 'x-vigil-admin-token': adminToken }
    )
    const channels = await api(`/projects/${projectId}/channels`)
    const channelId = (channels.channels ?? [])[0]?.id

    await ingest(
      `/api/v1/projects/${projectId}/alert-rules`,
      {
        name: '致命错误立即通知',
        type: 'issue.new',
        threshold: 1,
        windowSeconds: 300,
        ...(channelId ? { channelIds: [channelId] } : {})
      },
      { 'x-vigil-admin-token': adminToken }
    )
    await ingest(
      `/api/v1/projects/${projectId}/alert-rules`,
      {
        name: 'LCP P95 超过 3 秒',
        type: 'metric.lcp_p95',
        threshold: 3000,
        windowSeconds: 600
      },
      { 'x-vigil-admin-token': adminToken }
    )
    console.log('  · 已创建 2 条告警规则 + 1 个通知通道')
  }

  // 评估一次，让触发历史里有东西
  await ingest(
    `/api/v1/projects/${projectId}/alerts/evaluate`,
    {},
    {
      'x-vigil-admin-token': adminToken
    }
  )
}

/* ============================================================
 * Playwright
 * ============================================================ */

async function launchChromium() {
  try {
    return await chromium.launch()
  } catch (error) {
    const executablePath = findCachedChromium()
    if (!executablePath) throw error
    console.log(`[Vigil 面板验证] 使用本机缓存的 Chromium：${executablePath}`)
    return await chromium.launch({ executablePath })
  }
}

function findCachedChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright')
  ].filter((root) => Boolean(root))

  const candidates = []

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root)) {
      const match = dir.match(/^chromium(?:_headless_shell)?-(\d+)$/)
      if (!match) continue
      const revision = Number(match[1])
      const files = [
        path.join(root, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        path.join(root, dir, 'chrome-win64', 'chrome.exe'),
        path.join(root, dir, 'chrome-win', 'chrome.exe')
      ]
      for (const file of files) {
        if (fs.existsSync(file)) candidates.push({ revision, file })
      }
    }
  }

  candidates.sort((a, b) => b.revision - a.revision)
  return candidates[0]?.file
}

/* ============================================================
 * 主流程
 * ============================================================ */

console.log(`\n[Vigil 面板验证] 面板 ${dashboardUrl} · 采集服务 ${collectorUrl}\n`)

await ping(`${collectorUrl}/api/health`, '采集服务')
await ping(`${dashboardUrl}/`, '管理面板')

console.log('  · 准备演示数据')
const project = await ensureDemoData()
console.log(`  · 当前项目：${project.name}（${project.slug}，#${project.id}）\n`)

const statsBody = await api(`/projects/${project.id}/stats`)
const stats = statsBody.stats
const issuesBody = await api(
  `/projects/${project.id}/issues?status=unresolved&limit=50&sort=priority`
)
const issues = issuesBody.issues ?? []
const perfBody = await api(`/projects/${project.id}/performance`)
const perf = perfBody.summary
const rulesBody = await api(`/projects/${project.id}/alert-rules`)
const channelsBody = await api(`/projects/${project.id}/channels`)
const incidentsBody = await api(`/projects/${project.id}/alert-incidents`)
const orgsBody = await api('/organizations')
const allProjects = []
for (const org of orgsBody.organizations ?? []) {
  const body = await api(`/organizations/${org.id}/projects`)
  allProjects.push(...(body.projects ?? []))
}

const browser = await launchChromium()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

// 让面板一上来就选中被断言的那个项目（不依赖库里项目的顺序）
await page.addInitScript(
  ([key, projectId]) => {
    window.localStorage.setItem(key, String(projectId))
  },
  [PROJECT_STORAGE_KEY, project.id]
)

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() !== 'error') return
  const location = message.location()?.url ?? ''
  if (location.includes('favicon')) return
  consoleErrors.push(`${message.text()}: ${location}`)
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

// ---- 总览页 ----
await page.goto(dashboardUrl, { waitUntil: 'load' })
await page.waitForSelector('.stat-card', { timeout: 20000 })
await page.waitForFunction(() => document.querySelectorAll('.stat-card').length >= 4, undefined, {
  timeout: 20000
})

const navCount = await page.locator('.nav-item').count()
check('侧边导航有 8 个导航项', navCount === 8, `${navCount} 个`)

const envNavHref = await page
  .locator('.nav-item', { hasText: '环境与版本' })
  .first()
  .getAttribute('href')
check(
  '「环境与版本」导航项指向设置页的环境区块',
  (envNavHref ?? '').includes('/settings') && (envNavHref ?? '').includes('section=environments'),
  `href=${envNavHref ?? '—'}`
)

const cardLabels = await page.locator('.stat-label').allTextContents()
const cardValues = await page.locator('.stat-value').allTextContents()
const cardMap = new Map(cardLabels.map((label, i) => [label.trim(), (cardValues[i] ?? '').trim()]))

check(
  '「去重错误」卡片显示 stats.total',
  cardMap.get('去重错误') === stats.total.toLocaleString('zh-CN'),
  `卡片=${cardMap.get('去重错误')} · 接口=${stats.total.toLocaleString('zh-CN')}`
)
check(
  '「累计发生」卡片显示 stats.occurrences',
  cardMap.get('累计发生') === stats.occurrences.toLocaleString('zh-CN'),
  `卡片=${cardMap.get('累计发生')} · 接口=${stats.occurrences.toLocaleString('zh-CN')}`
)
check(
  '「待处理」卡片显示 stats.unresolved',
  cardMap.get('待处理') === stats.unresolved.toLocaleString('zh-CN'),
  `卡片=${cardMap.get('待处理')} · 接口=${stats.unresolved.toLocaleString('zh-CN')}`
)
check(
  '「回归中」卡片显示 stats.regressed',
  cardMap.get('回归中') === stats.regressed.toLocaleString('zh-CN'),
  `卡片=${cardMap.get('回归中')} · 接口=${stats.regressed.toLocaleString('zh-CN')}`
)

// 图表从 SVG 改成 HTML/CSS 之后，选择器跟着变了：
// SVG 里是 `.bar-chart > g`，HTML 里是 `.bar-row`。
const topBars = await page.locator('[data-panel="Top 问题"] .bar-row').count()
check(
  '总览渲染了 Top 问题条形图',
  topBars === Math.min(10, issues.length),
  `页面=${topBars} 根条形 · 接口=${Math.min(10, issues.length)} 条问题`
)

/**
 * 回归防护：**同屏图表的标签字号必须一致**。
 *
 * 之前 BarList 是 SVG + `preserveAspectRatio`，字号是 viewBox 单位，
 * 实际渲染大小 = 字号 × (面板宽 / 900) —— 面板宽度不同，
 * 同一个「12px」渲染出来就是两个大小。改成 HTML/CSS 之后才是真实 px。
 * 这个断言就是为了不让它退回去。
 */
const labelSizes = await page.evaluate(() => {
  const pick = (panel) =>
    [...document.querySelectorAll(`[data-panel="${panel}"] .bar-label`)].map(
      (el) => Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10
    )
  return {
    top: pick('Top 问题'),
    category: pick('分类分布'),
    culprit: pick('Top 责任点')
  }
})
const allSizes = [...labelSizes.top, ...labelSizes.category, ...labelSizes.culprit]
const sizeSet = [...new Set(allSizes)]
check(
  '同屏图表的标签字号一致',
  sizeSet.length <= 1,
  sizeSet.length <= 1
    ? `统一 ${sizeSet[0]}px（${allSizes.length} 个标签）`
    : `出现 ${sizeSet.length} 种字号：${sizeSet.join(' / ')}`
)

const overviewRows = await page.locator('.issue-item').count()
check(
  '总览的待处理列表渲染了 N 行',
  overviewRows === Math.min(10, issues.length),
  `页面=${overviewRows} 行 · 接口=${Math.min(10, issues.length)} 行`
)

const sidebarSlug = (await page.locator('.foot-slug').textContent())?.trim() ?? ''
check(
  '侧边栏底部显示项目标识',
  sidebarSlug === project.slug,
  `侧边栏=${sidebarSlug} · 接口=${project.slug}`
)

const topbarProject = (await page.locator('.crumb-project').textContent())?.trim() ?? ''
check('顶栏显示当前项目名', topbarProject === project.name, `顶栏=${topbarProject}`)

// ---- 问题列表页 ----
await page.locator('.nav-item', { hasText: '问题' }).first().click()
await page.waitForURL('**/issues', { timeout: 20000 })
await page.waitForSelector('.el-table__row', { timeout: 20000 })
await page.waitForFunction(
  () => document.querySelectorAll('.el-table__row').length > 0,
  undefined,
  { timeout: 20000 }
)

const tabCount = await page.locator('.status-tabs .el-tabs__item').count()
check('问题页有 7 个状态标签页', tabCount === 7, `${tabCount} 个`)

const tableRows = await page.locator('.el-table__row').count()
check(
  '问题表格渲染了 N 行',
  tableRows === Math.min(issues.length, 50),
  `页面=${tableRows} 行 · 接口=${Math.min(issues.length, 50)} 行`
)

const firstRowId = issues[0]?.id
const firstRowTitle =
  (await page.locator('.el-table__row .issue-name').first().textContent())?.trim() ?? ''
check(
  '表格第一行是接口返回的第一条问题',
  firstRowTitle === (issues[0]?.title ?? ''),
  `页面="${firstRowTitle}" · 接口="${issues[0]?.title ?? ''}"`
)

// ---- 问题详情页 ----
await page.locator('.el-table__row .issue-name').first().click()
await page.waitForFunction((id) => window.location.pathname === `/issues/${id}`, firstRowId, {
  timeout: 20000
})
const detailPath = new URL(page.url()).pathname
check('点击行后跳到 /issues/<id>', detailPath === `/issues/${firstRowId}`, `URL=${detailPath}`)

await page.waitForSelector('.detail-page', { timeout: 20000 })
await page.waitForFunction(
  () => (document.querySelector('.detail-page')?.textContent ?? '').length > 0,
  undefined,
  { timeout: 20000 }
)
const detailText = (await page.locator('.detail-page').textContent()) ?? ''
check('详情页出现「活动流」', detailText.includes('活动流'), '包含「活动流」标题')
check('详情页出现「发生次数」', detailText.includes('发生次数'), '包含「发生次数」字段')
check(
  '详情页显示指纹',
  detailText.includes(issues[0]?.fingerprint ?? 'ffffffffffffffff'),
  `指纹=${issues[0]?.fingerprint ?? '—'}`
)

const apiIssue = (await api(`/projects/${project.id}/issues/${firstRowId}`)).issue
const timelineItems = await page.locator('.timeline .el-timeline-item').count()
check(
  '活动流条目数与接口一致',
  timelineItems === (apiIssue.activity?.length ?? 0),
  `页面=${timelineItems} 条 · 接口=${apiIssue.activity?.length ?? 0} 条`
)

const eventRows = await page.locator('[data-panel="发生记录"]').locator('.el-table__row').count()
check(
  '发生记录表渲染了 N 行',
  eventRows === (apiIssue.events?.length ?? 0),
  `页面=${eventRows} 行 · 接口=${apiIssue.events?.length ?? 0} 行`
)

const actionButtons = await page.locator('.actions .el-button').count()
check('详情页有 6 个状态操作按钮', actionButtons === 6, `${actionButtons} 个`)

// ---- 性能页 ----
await page.locator('.nav-item', { hasText: '性能' }).first().click()
await page.waitForURL('**/performance', { timeout: 20000 })
await page.waitForSelector('.vital-card', { timeout: 20000 })

const lcpCard = page.locator('.vital-card', { hasText: 'LCP' }).first()
const lcpText = (await lcpCard.locator('.vital-p95').textContent())?.trim() ?? ''
const expectedLcp = `${perf.vitals.lcp.p95.toLocaleString('zh-CN')}ms`
check('性能页显示 LCP 的 P95', lcpText === expectedLcp, `页面=${lcpText} · 接口=${expectedLcp}`)

// 同上：SVG → HTML/CSS 之后，`.pc-chart g` 变成 `.pc-row`
const percentileBars = await page.locator('.pc-row').count()
check('性能页渲染了 4 条分位数区间', percentileBars === 4, `${percentileBars} 条`)

const byNameRows = await page.locator('[data-panel="页面维度"]').locator('.el-table__row').count()
check(
  '页面维度表渲染了 N 行',
  byNameRows === perf.byName.length,
  `页面=${byNameRows} 行 · 接口=${perf.byName.length} 行`
)

const spanRows = await page.locator('[data-panel="最慢接口"]').locator('.el-table__row').count()
check(
  '最慢接口表渲染了 N 行',
  spanRows === perf.topSpans.length,
  `页面=${spanRows} 行 · 接口=${perf.topSpans.length} 行`
)

// ---- 会话回放页 ----
const sessionsBody = await api(`/projects/${project.id}/sessions`)
const sessionRows = sessionsBody.sessions ?? []
const replaySessions = sessionRows.filter((row) => row.hasReplay)

await page.locator('.nav-item', { hasText: '会话回放' }).first().click()
await page.waitForURL('**/sessions', { timeout: 20000 })
await page.waitForSelector('.el-table__row', { timeout: 20000 })

const sessionTableRows = await page
  .locator('[data-panel="会话列表"]')
  .locator('.el-table__row')
  .count()
check(
  '会话表格渲染了 N 行',
  sessionTableRows === Math.min(sessionRows.length, 50),
  `页面=${sessionTableRows} 行 · 接口=${sessionRows.length} 个会话`
)

const sessionStatValues = await page.locator('.stat-value').allTextContents()
const sessionStatLabels = await page.locator('.stat-label').allTextContents()
const sessionStatMap = new Map(
  sessionStatLabels.map((label, i) => [label.trim(), (sessionStatValues[i] ?? '').trim()])
)
check(
  '「会话总数」卡片显示接口的 total',
  sessionStatMap.get('会话总数') === Number(sessionRows.length).toLocaleString('zh-CN'),
  `卡片=${sessionStatMap.get('会话总数')} · 接口=${sessionRows.length}`
)
check(
  '「有回放」卡片显示有回放的会话数',
  sessionStatMap.get('有回放') === replaySessions.length.toLocaleString('zh-CN'),
  `卡片=${sessionStatMap.get('有回放')} · 接口=${replaySessions.length}`
)

// 打开一个回放，验证播放器真的挂上了
if (replaySessions.length > 0) {
  const replayButton = page
    .locator('.el-table__row')
    .filter({ hasText: replaySessions[0].sessionId })
    .locator('button')
    .first()
  await replayButton.click()

  await page.waitForSelector('.replay', { timeout: 20000 })
  // 播放器是**动态加载**的 chunk —— 要等它真的挂上
  await page.waitForSelector('.player-host .replayer-wrapper', { timeout: 20000 })
  const playerMounted = await page.locator('.player-host .replayer-wrapper').count()
  check('回放播放器挂载成功', playerMounted === 1, `${playerMounted} 个播放器`)

  // 会话 ID 在**抽屉头部**（不在内容区里）—— 断言要落在具体那个元素上
  const drawerSessionId = (await page.locator('.drawer-sub').textContent())?.trim() ?? ''
  check(
    '回放抽屉显示会话 ID',
    drawerSessionId === replaySessions[0].sessionId,
    `抽屉=${drawerSessionId} · 接口=${replaySessions[0].sessionId}`
  )

  // 控制条是我们自己画的：播放按钮 + 进度条 + 倍速
  const controlCount = await page
    .locator('.controls .play-btn, .controls .seek, .controls .speed')
    .count()
  check('回放控制条有 3 个控件', controlCount === 3, `${controlCount} 个`)

  const clockText = (await page.locator('.controls .clock').textContent()) ?? ''
  check('回放显示时间读数', /\d+:\d+/.test(clockText), `读数=${clockText.trim()}`)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
} else {
  check('回放播放器挂载成功', false, '没有带回放的会话 —— 种子数据没生效')
}

// ---- 用户行为页 ----
const behaviorBody = await api(`/projects/${project.id}/behavior/summary`)
const behaviorSummary = behaviorBody.summary

await page.locator('.nav-item', { hasText: '用户行为' }).first().click()
await page.waitForURL('**/behavior', { timeout: 20000 })
await page.waitForSelector('.stat-card', { timeout: 20000 })

const behaviorValues = await page.locator('.stat-value').allTextContents()
const behaviorLabels = await page.locator('.stat-label').allTextContents()
const behaviorMap = new Map(
  behaviorLabels.map((label, i) => [label.trim(), (behaviorValues[i] ?? '').trim()])
)
check(
  '「访问次数」卡片显示接口的 pageViews',
  behaviorMap.get('访问次数') === Number(behaviorSummary.pageViews).toLocaleString('zh-CN'),
  `卡片=${behaviorMap.get('访问次数')} · 接口=${behaviorSummary.pageViews}`
)
check(
  '「会话数」卡片显示接口的 sessions',
  behaviorMap.get('会话数') === Number(behaviorSummary.sessions).toLocaleString('zh-CN'),
  `卡片=${behaviorMap.get('会话数')} · 接口=${behaviorSummary.sessions}`
)

const topPageRows = await page.locator('[data-panel="热门页面"]').locator('.el-table__row').count()
check(
  '热门页面表渲染了 N 行',
  topPageRows === behaviorSummary.topPages.length,
  `页面=${topPageRows} 行 · 接口=${behaviorSummary.topPages.length} 行`
)

// 隐私边界写在**页面描述**里（由布局渲染，不在视图根节点内）
const behaviorDesc = (await page.locator('.page-desc').textContent())?.trim() ?? ''
check(
  '行为页说明不记录输入内容',
  behaviorDesc.includes('不记录输入内容'),
  `页面描述="${behaviorDesc}"`
)

// ---- 告警页 ----
await page.locator('.nav-item', { hasText: '告警' }).first().click()
await page.waitForURL('**/alerts', { timeout: 20000 })
await page.waitForSelector('.el-table__row', { timeout: 20000 })

const ruleRows = await page.locator('[data-panel="告警规则"]').locator('.el-table__row').count()
check(
  '告警规则表渲染了 N 行',
  ruleRows === (rulesBody.rules ?? []).length,
  `页面=${ruleRows} 行 · 接口=${(rulesBody.rules ?? []).length} 行`
)

const channelRows = await page.locator('[data-panel="通知通道"]').locator('.el-table__row').count()
check(
  '通知通道表渲染了 N 行',
  channelRows === (channelsBody.channels ?? []).length,
  `页面=${channelRows} 行 · 接口=${(channelsBody.channels ?? []).length} 行`
)

const incidentRows = await page.locator('[data-panel="触发历史"]').locator('.el-table__row').count()
check(
  '触发历史表渲染了 N 行',
  incidentRows === (incidentsBody.incidents ?? []).length,
  `页面=${incidentRows} 行 · 接口=${(incidentsBody.incidents ?? []).length} 行`
)

const ruleTypeText = (await page.locator('[data-panel="告警规则"]').textContent()) ?? ''
check(
  '告警规则类型显示中文',
  ruleTypeText.includes('出现新问题') || ruleTypeText.includes('LCP P95'),
  '包含中文类型名'
)

// ---- 设置页 ----
await page.locator('.nav-item', { hasText: '设置' }).first().click()
await page.waitForURL('**/settings', { timeout: 20000 })
await page.waitForSelector('.el-table__row', { timeout: 20000 })

const orgRows = await page.locator('[data-panel="组织"]').locator('.el-table__row').count()
check(
  '设置页组织表渲染了 N 行',
  orgRows === (orgsBody.organizations ?? []).length,
  `页面=${orgRows} 行 · 接口=${(orgsBody.organizations ?? []).length} 行`
)

const projectRows = await page.locator('[data-panel="项目"]').locator('.el-table__row').count()
check(
  '设置页项目表渲染了 N 行',
  projectRows === allProjects.length,
  `页面=${projectRows} 行 · 接口=${allProjects.length} 行`
)

const settingsText = (await page.locator('.settings-page').textContent()) ?? ''
check('设置页有项目密钥区', settingsText.includes('项目密钥'), '包含「项目密钥」标题')
check(
  '设置页有运行时密钥轮换按钮',
  settingsText.includes('轮换运行时密钥'),
  '包含「轮换运行时密钥」按钮'
)

// ---- 控制台 ----
const realErrors = consoleErrors.filter(
  (text) => !text.includes('favicon') && !text.includes('DevTools')
)
check('页面没有 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '无')

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log('')
console.log('─'.repeat(64))
console.log(
  `断言 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条`
)
if (failed.length > 0) {
  console.log('')
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
}
console.log('─'.repeat(64))

process.exit(failed.length === 0 ? 0 : 1)
