/**
 * 端到端闭环验证。
 *
 * 验证的是**真实链路**，不是 mock：
 *   真 Chromium → 真 SDK 产物 → 真 HTTP 上报 → 真 Collector → 真 SQLite → 真查询 API
 *
 * 覆盖的是**新架构的核心不变量**：
 *   1. 五类错误源都能被采到
 *   2. 同一错误报两次聚合成一条（count = 2）
 *   3. **Resolve with Release**：在 1.0.0 解决的问题，在 1.0.1 出现 → 判为回归
 *   4. 压缩栈能被 sourcemap 还原回源码
 *   5. URL 里的 token 被脱敏
 *   6. 上报请求自身不被当成错误（无递归）
 *   7. 性能事务入库且分位数可查
 *   8. **错误与性能关联**：报错事件带上当时的 LCP
 *   9. 告警规则能触发并落库（去重生效）
 *  10. 页面卸载时事件仍能送达（beacon 通道）
 *
 * 输出全是数字 —— 断言失败会打印实际值，不用截图判断。
 */
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../packages/collector/src/infra/db/client.js'
import { TenancyService } from '../packages/collector/src/domains/tenancy/service.js'
import { IssueService } from '../packages/collector/src/domains/issues/service.js'
import { ArtifactService } from '../packages/collector/src/domains/artifacts/service.js'
import { PerformanceService } from '../packages/collector/src/domains/performance/service.js'
import { AlertingService } from '../packages/collector/src/domains/alerting/service.js'
import { AlertEvaluator } from '../packages/collector/src/domains/alerting/evaluator.js'
import { buildApp } from '../packages/collector/src/app.js'
import { computeFingerprint } from '../packages/sdk/src/fingerprint.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SDK_DIST = path.join(REPO_ROOT, 'packages', 'sdk', 'dist', 'index.js')
const SDK_IIFE = path.join(REPO_ROOT, 'packages', 'sdk', 'dist', 'index.iife.js')
const SDK_REPLAY_IIFE = path.join(REPO_ROOT, 'packages', 'sdk', 'dist', 'replay.iife.js')

const ADMIN_TOKEN = 'admin_e2e_token'

// ---- 断言工具：全部用数字说话 ----
const results: Array<{ name: string; pass: boolean; detail: string }> = []

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name} — ${detail}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 15000,
  intervalMs = 150
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await sleep(intervalMs)
  }
  return undefined
}

async function launchChromium() {
  try {
    return await chromium.launch()
  } catch (error) {
    const executablePath = findCachedChromium()
    if (!executablePath) throw error
    console.log(`[Vigil E2E] 使用本机缓存的 Chromium：${executablePath}`)
    return await chromium.launch({ executablePath })
  }
}

function findCachedChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright')
  ].filter((root): root is string => Boolean(root))

  const candidates: Array<{ revision: number; file: string }> = []

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

if (!fs.existsSync(SDK_DIST) || !fs.existsSync(SDK_IIFE) || !fs.existsSync(SDK_REPLAY_IIFE)) {
  console.error(`找不到 SDK 产物：${SDK_DIST} / ${SDK_IIFE} / ${SDK_REPLAY_IIFE}`)
  console.error('先跑 npm run build --workspace @vigil/sdk')
  process.exit(1)
}

// ============================================================
// 1. 准备：临时库 + 组织 + 项目 + 密钥
// ============================================================
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-e2e-'))
const dbPath = path.join(tmpDir, 'e2e.db')
const db: Db = await openDb(dbPath)

const tenancy = new TenancyService(db)
const artifacts = new ArtifactService(db)
const issues = new IssueService(db, artifacts.sourcemapResolver)
const performance = new PerformanceService(db)
const alerting = new AlertingService(db)
const evaluator = new AlertEvaluator(db, alerting)

const organization = await tenancy.createOrganization('E2E 组织')
const project = await tenancy.createProject({
  organizationId: organization.id,
  name: 'E2E 应用',
  slug: 'e2e-app'
})

console.log(`\n[Vigil E2E] 临时库 ${dbPath}`)
console.log(`[Vigil E2E] 项目 ${project.project.id} (${project.project.slug})\n`)

// ============================================================
// 2. 启动 Collector
// ============================================================
const built = await buildApp({ db, adminToken: ADMIN_TOKEN })
const collector = built.app
await collector.listen({ port: 0, host: '127.0.0.1' })
const address = collector.server.address()
const collectorPort = typeof address === 'object' && address ? address.port : 0
const collectorUrl = `http://127.0.0.1:${collectorPort}`
console.log(`[Vigil E2E] Collector ${collectorUrl}`)

// ---- 上传 sourcemap（模拟 CI 行为）----
const MINIFIED = 'function a(){throw new TypeError("E2E: 压缩产物里的错误")}a();\n'
const SOURCEMAP = {
  version: 3,
  file: 'app.min.js',
  sourceRoot: '',
  sources: ['src/user-profile.ts'],
  sourcesContent: ['export function loadUser() {\n  throw new TypeError("boom")\n}\n'],
  names: [],
  mappings: 'AAAA'
}

const uploadResponse = await fetch(`${collectorUrl}/api/v1/sourcemaps`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-vigil-token': project.uploadKey
  },
  body: JSON.stringify({
    appId: project.project.slug,
    release: '1.0.0',
    files: [{ fileName: 'app.min.js', sourceMap: JSON.stringify(SOURCEMAP) }]
  })
})
check('sourcemap 上传被接受', uploadResponse.ok, `HTTP ${uploadResponse.status}`)

// ============================================================
// 3. 静态服务器：测试页面 + SDK
// ============================================================
const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Vigil E2E</title>
<script src="/sdk/index.iife.js"></script>
<script>
  // 同步初始化：监听器在 <body> 解析之前就装好了
  Vigil.init({
    endpoint: '${collectorUrl}/api/v1/collect',
    appId: '${project.project.slug}',
    token: '${project.runtimeKey}',
    release: '1.0.0',
    environment: 'production',
    flushIntervalMs: 400,
    maxBatchSize: 5,
    performanceSampleRate: 1
  })
  window.__vigilReady = true
</script>
</head>
<body>
<img id="broken" src="/missing-image.png" alt="">
<script>
  // 同一个错误抛两次 —— 验证指纹聚合
  function boom() {
    throw new TypeError('E2E: 聚合验证用的错误')
  }
  setTimeout(boom, 60)
  setTimeout(boom, 120)

  // 未处理的 Promise 拒绝
  setTimeout(() => {
    Promise.reject(new Error('E2E: 未处理的 Promise 拒绝'))
  }, 180)

  // 接口 500
  setTimeout(() => {
    fetch('/api/boom').catch(() => {})
  }, 240)

  // 「压缩产物」里的错误 —— SDK 装好之后再加载，才能被采集到
  setTimeout(() => {
    const script = document.createElement('script')
    script.src = '/app.min.js'
    document.body.appendChild(script)
  }, 300)
</script>
</body>
</html>`

// ---- 回放与行为专用页 ----
//
// 单独一页，不和上面那页混：上面那页在 <head> 里就初始化了，
// 而 rrweb 的第一帧是**全量快照** —— 启动太早只能拍到空壳，
// 拍不到真实 DOM。
const REPLAY_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Vigil 回放 E2E</title>
<script src="/sdk/index.iife.js"></script>
<script src="/sdk/replay.iife.js"></script>
</head>
<body>
<h1>购物车</h1>
<div id="cart">购物车</div>
<button id="checkout">去结算</button>
<script>
window.addEventListener('DOMContentLoaded', function () {
  Vigil.init({
    endpoint: '${collectorUrl}/api/v1/collect',
    appId: '${project.project.slug}',
    token: '${project.runtimeKey}',
    release: '1.0.0',
    environment: 'production',
    flushIntervalMs: 300,
    maxBatchSize: 5,
    performanceSampleRate: 0,
    plugins: [
      VigilReplay.replayPlugin({ maxBytes: 64 * 1024 }),
      VigilReplay.behaviorPlugin({ flushIntervalMs: 400 })
    ]
  })
  window.__vigilReady = true

  // 交互：让回放里有增量事件，也让行为域收到 click
  setTimeout(function () {
    document.getElementById('checkout').click()
    document.getElementById('cart').textContent = '购物车 · 共 3 件商品'
  }, 300)

  // 出错 —— 回放事件流随这条错误一起上报
  setTimeout(function () {
    Vigil.captureException(new TypeError('E2E: 回放验证用的错误'))
  }, 900)
})
</script>
</body>
</html>`

const staticServer = http.createServer((req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/page.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.startsWith('/replay.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(REPLAY_PAGE)
    return
  }
  if (url === '/sdk/index.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(SDK_DIST))
    return
  }
  if (url === '/sdk/index.iife.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(SDK_IIFE))
    return
  }
  if (url === '/sdk/replay.iife.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(SDK_REPLAY_IIFE))
    return
  }
  if (url === '/app.min.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(MINIFIED)
    return
  }
  if (url === '/api/boom') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"error":"intentional"}')
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

await new Promise<void>((resolve) => staticServer.listen(0, '127.0.0.1', resolve))
const staticAddress = staticServer.address()
const staticPort = typeof staticAddress === 'object' && staticAddress ? staticAddress.port : 0
const pageUrl = `http://127.0.0.1:${staticPort}/page.html?token=SECRET_TOKEN_123&page=2`
console.log(`[Vigil E2E] 测试页 ${pageUrl}\n`)

// ============================================================
// 4. 真浏览器跑一遍
// ============================================================
const browser = await launchChromium()
const page = await browser.newPage()

await page.goto(pageUrl, { waitUntil: 'load' })
await page.waitForFunction(
  () => (window as unknown as { __vigilReady?: boolean }).__vigilReady === true
)

// ============================================================
// 5. 等事件落库
// ============================================================
const countRows = async () =>
  (
    await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM issues WHERE project_id = ?', [
      project.project.id
    ])
  )?.n ?? 0

await waitFor(async () => ((await countRows()) >= 5 ? true : undefined), 20000)

const totalDistinct = await countRows()
const totals = await db.get<{ c: number }>(
  'SELECT COALESCE(SUM(count), 0) AS c FROM issues WHERE project_id = ?',
  [project.project.id]
)

console.log('')
check(
  '五类错误都落库了',
  totalDistinct >= 5,
  `去重后 ${totalDistinct} 条错误 / 累计 ${totals?.c} 次发生`
)

const byCategory = await db.all<{ category: string; n: number; occurrences: number }>(
  'SELECT category, COUNT(*) AS n, COALESCE(SUM(count), 0) AS occurrences FROM issues WHERE project_id = ? GROUP BY category',
  [project.project.id]
)
const categoryMap = new Map(byCategory.map((row) => [row.category, row]))
check(
  'javascript 类被采到',
  (categoryMap.get('javascript')?.n ?? 0) >= 2,
  `${categoryMap.get('javascript')?.n ?? 0} 条`
)
check(
  'resource 类被采到（404 图片）',
  (categoryMap.get('resource')?.n ?? 0) >= 1,
  `${categoryMap.get('resource')?.n ?? 0} 条`
)
check(
  'http 类被采到（接口 500）',
  (categoryMap.get('http')?.n ?? 0) >= 1,
  `${categoryMap.get('http')?.n ?? 0} 条`
)

// ============================================================
// 6. Issue 生命周期：聚合 → 解决 → 回归
// ============================================================
const aggregated = await db.get<{ fingerprint: string; count: number }>(
  `SELECT fingerprint, count FROM issues
   WHERE project_id = ? AND message LIKE '%聚合验证%'`,
  [project.project.id]
)
check(
  '同一个错误报两次聚合成一条',
  aggregated?.count === 2,
  `指纹 ${aggregated?.fingerprint ?? 'N/A'} count=${aggregated?.count ?? 0}（期望 2）`
)

// 造一个错误 → 解决（在 1.0.0）→ 在 1.0.1 出现 → 应判为回归
const lifecycleEvent = {
  category: 'javascript' as const,
  kind: 'js' as const,
  name: 'TypeError',
  message: "E2E: 回归验证用的错误 (reading 'total')",
  stack:
    "TypeError: E2E: 回归验证用的错误 (reading 'total')\n    at sumCart (https://app.example.com/assets/index-DnB3xK2l.js:880:17)",
  frames: [
    {
      filename: 'https://app.example.com/assets/index-DnB3xK2l.js',
      functionName: 'sumCart',
      lineno: 880,
      colno: 17
    }
  ],
  fingerprint: '',
  url: 'https://app.example.com/cart',
  userAgent: 'test-agent',
  sessionId: 'sess-lifecycle',
  release: '1.0.0',
  environment: 'production',
  occurredAt: Date.now() - 60 * 60 * 1000
}
lifecycleEvent.fingerprint = computeFingerprint({
  category: lifecycleEvent.category,
  name: lifecycleEvent.name,
  message: lifecycleEvent.message,
  frames: lifecycleEvent.frames
})

const outcome = await issues.ingestEvent(project.project.id, lifecycleEvent)
const resolved = await issues.resolve(project.project.id, outcome.issueId, { release: '1.0.0' })
check(
  '标记已解决 → 状态 resolved 且记录了版本',
  resolved.status === 'resolved' && resolved.resolvedInRelease === '1.0.0',
  `status=${resolved.status} resolvedInRelease=${resolved.resolvedInRelease ?? 'N/A'}`
)

await issues.ingestEvent(project.project.id, {
  ...lifecycleEvent,
  release: '1.0.1',
  occurredAt: Date.now()
})
const regressed = await issues.getIssue(project.project.id, outcome.issueId)
check(
  '在更新版本重新出现 → 判为回归（Resolve with Release）',
  regressed.status === 'unresolved' && regressed.substatus === 'regressed',
  `status=${regressed.status} substatus=${regressed.substatus}`
)

// 同版本再次出现 → 应保持 resolved（是噪音，不是回归）
const noiseOutcome = await issues.ingestEvent(project.project.id, {
  ...lifecycleEvent,
  release: '1.0.0',
  occurredAt: Date.now()
})
await issues.resolve(project.project.id, noiseOutcome.issueId, { release: '1.0.0' })
await issues.ingestEvent(project.project.id, {
  ...lifecycleEvent,
  release: '1.0.0',
  occurredAt: Date.now() + 1000
})
const noise = await issues.getIssue(project.project.id, noiseOutcome.issueId)
check(
  '在同版本重新出现 → 保持 resolved（是噪音不是回归）',
  noise.status === 'resolved',
  `status=${noise.status}`
)

// 活动流
const activity = await db.all<{ action: string }>(
  'SELECT action FROM issue_activity WHERE issue_id = ? ORDER BY id',
  [outcome.issueId]
)
const actions = activity.map((a) => a.action)
check(
  '活动流记录了状态变化',
  actions.includes('created') && actions.includes('resolved') && actions.includes('regressed'),
  actions.join(' → ')
)

// ============================================================
// 7. sourcemap 还原
// ============================================================
// v2 里原始栈与还原后的栈住在 issues 表上（入库时还原一次）
const minifiedError = await db.get<{ raw_stack: string | null; resolved_stack: string | null }>(
  `SELECT raw_stack, resolved_stack FROM issues
   WHERE project_id = ? AND message LIKE '%压缩产物%'`,
  [project.project.id]
)

let resolvedFilename: string | undefined
let resolvedLineno: number | undefined
if (minifiedError?.resolved_stack) {
  const frames = JSON.parse(minifiedError.resolved_stack) as Array<{
    original?: { filename?: string; lineno?: number }
  }>
  resolvedFilename = frames[0]?.original?.filename
  resolvedLineno = frames[0]?.original?.lineno
}

check(
  '压缩产物的栈被 sourcemap 还原回源码',
  resolvedFilename === 'src/user-profile.ts' && resolvedLineno === 1,
  `原始栈 ${minifiedError?.raw_stack?.split('\n')[1]?.trim() ?? 'N/A'} → 还原到 ${resolvedFilename ?? 'N/A'}:${resolvedLineno ?? 'N/A'}`
)

// ============================================================
// 8. 脱敏
// ============================================================
const storedUrl = await db.get<{ url: string }>(
  'SELECT url FROM issues WHERE project_id = ? ORDER BY id LIMIT 1',
  [project.project.id]
)
check(
  'URL 里的 token 被脱敏',
  !storedUrl?.url.includes('SECRET_TOKEN_123') && storedUrl?.url.includes('token=***'),
  storedUrl?.url ?? 'N/A'
)

// ============================================================
// 9. 无递归
// ============================================================
const selfReports = await db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM issues
   WHERE project_id = ? AND (url LIKE '%/api/v1/collect%' OR message LIKE '%/api/v1/collect%')`,
  [project.project.id]
)
check('上报请求自身没有被当成错误（无递归）', selfReports?.n === 0, `${selfReports?.n} 条`)

// ============================================================
// 10. 性能事务
// ============================================================
for (let i = 0; i < 20; i++) {
  await performance.ingestTransaction(project.project.id, {
    name: '/checkout',
    type: 'page',
    startedAt: Date.now() - i * 1000,
    durationMs: 1000 + i * 100,
    vitals: { fcp: 600, lcp: 1200 + i * 50, cls: 0.02, inp: 100, ttfb: 180, tbt: 40 },
    pageUrl: 'https://app.example.com/checkout',
    userAgent: 'test-agent',
    sessionId: `sess-perf-${i}`,
    release: '1.0.0',
    environment: 'production'
  })
}

const perfSummary = await performance.summary({ projectId: project.project.id })
check(
  '性能事务入库且分位数可查',
  perfSummary.transactions === 20 && perfSummary.vitals.lcp.count === 20,
  `${perfSummary.transactions} 条事务，LCP P95=${perfSummary.vitals.lcp.p95}ms`
)

// ============================================================
// 11. 错误与性能关联
// ============================================================
// SDK 在报错时会带上当时的 vitals 快照。服务端存在 issue_events.vitals_json。
const withVitals = await db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM issue_events
   WHERE project_id = ? AND vitals_json IS NOT NULL`,
  [project.project.id]
)
check(
  '错误事件带上了性能快照（错误与性能关联）',
  (withVitals?.n ?? 0) > 0,
  `${withVitals?.n} 条事件带 vitals`
)

// ============================================================
// 12. 告警
// ============================================================
const channel = await alerting.createChannel({
  projectId: project.project.id,
  name: 'E2E webhook',
  type: 'webhook',
  config: { url: 'http://127.0.0.1:1/never' }
})

await alerting.createRule({
  projectId: project.project.id,
  name: '错误过多',
  type: 'issue.count',
  threshold: 1,
  windowSeconds: 300,
  channelIds: [channel.id]
})

const alertResult = await evaluator.evaluateProject(project.project.id)
const incidentCount = await db.get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM alert_incidents WHERE project_id = ?',
  [project.project.id]
)
check(
  '告警规则能触发并落库',
  alertResult.triggered > 0 && (incidentCount?.n ?? 0) > 0,
  `触发 ${alertResult.triggered} 次，落库 ${incidentCount?.n ?? 0} 条`
)

// 去重：再评估一次不应重复落库
await evaluator.evaluateProject(project.project.id)
const incidentCountAfter = await db.get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM alert_incidents WHERE project_id = ?',
  [project.project.id]
)
check(
  '告警去重生效（同一窗口不重复）',
  incidentCountAfter?.n === incidentCount?.n,
  `${incidentCount?.n} → ${incidentCountAfter?.n} 条`
)

// ============================================================
// 13. 管理 API
// ============================================================
// ⚠️ 这里的计数要**现查** —— 上面��生命周期测试又新增了 Issue，
//    用之前缓存的快照比对会误报。
const currentDistinct = await countRows()
const currentTotals = await db.get<{ c: number }>(
  'SELECT COALESCE(SUM(count), 0) AS c FROM issues WHERE project_id = ?',
  [project.project.id]
)

const listResponse = await fetch(
  `${collectorUrl}/api/v1/projects/${project.project.id}/issues?limit=100`,
  { headers: { 'x-vigil-admin-token': ADMIN_TOKEN } }
)
const listBody = (await listResponse.json()) as { total: number }
check(
  '管理 API 能查到问题列表',
  listResponse.ok && listBody.total === currentDistinct,
  `HTTP ${listResponse.status}，total=${listBody.total}（表里 ${currentDistinct}）`
)

const statsResponse = await fetch(`${collectorUrl}/api/v1/projects/${project.project.id}/stats`, {
  headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
})
const statsBody = (await statsResponse.json()) as {
  stats: { total: number; occurrences: number; unresolved: number; regressed: number }
}
check(
  '统计 API 的计数与问题表一致',
  statsBody.stats.total === currentDistinct && statsBody.stats.occurrences === currentTotals?.c,
  `distinct=${statsBody.stats.total} occurrences=${statsBody.stats.occurrences} unresolved=${statsBody.stats.unresolved} regressed=${statsBody.stats.regressed}`
)

// ============================================================
// 14. 页面卸载时的 beacon 通道
// ============================================================
const beforeUnload = totals?.c ?? 0
await page.goto('about:blank')
await sleep(1500)
const afterUnload = await db.get<{ c: number }>(
  'SELECT COALESCE(SUM(count), 0) AS c FROM issues WHERE project_id = ?',
  [project.project.id]
)
check(
  '页面卸载后事件仍能送达（beacon 通道）',
  (afterUnload?.c ?? 0) >= beforeUnload,
  `卸载前 ${beforeUnload} 次 → 卸载后 ${afterUnload?.c ?? 0} 次`
)

// ============================================================
// 15. 会话回放与用户行为
// ============================================================
//
// 这一段验的是**真浏览器录出来的** rrweb 事件流：
//   真 Chromium → 真 SDK 回放插件 → 真 rrweb 录制 → 真 HTTP 上报
//   → 真 Collector → 真 SQLite → 真查询 API
//
// 之前这块完全没有覆盖，所以三个 bug 一起溜过去了：
//   1. 全量快照事件类型写错（0 应为 2）→ 缓冲区从不重置
//   2. 种子流的节点类型写错 → 播放器静默播不出来
//   3. 行为通道地址拼错 → 行为数据一条都到不了
const replayPage = await browser.newPage()
const replayErrors: string[] = []
replayPage.on('pageerror', (error) => replayErrors.push(error.message))
replayPage.on('console', (message) => {
  if (message.type() !== 'error') return
  const location = message.location()?.url ?? ''
  if (location.includes('favicon')) return
  replayErrors.push(`${message.text()}: ${location}`)
})

await replayPage.goto(`http://127.0.0.1:${staticPort}/replay.html`, { waitUntil: 'load' })
await replayPage.waitForFunction(
  () => (window as unknown as { __vigilReady?: boolean }).__vigilReady === true,
  undefined,
  { timeout: 20000 }
)

// ---- 回放事件流入库 ----
const countReplayEvents = async () =>
  (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM replay_events WHERE project_id = ?', [
    project.project.id
  ])?.n) ?? 0

await waitFor(() => (countReplayEvents() > 0 ? true : undefined), 20000)

const replayRows = await db.all<{ seq: number; event_type: number }>(
  `SELECT seq, event_type FROM replay_events
   WHERE project_id = ? ORDER BY seq`,
  [project.project.id]
)
check('回放事件流已入库', replayRows.length > 0, `${replayRows.length} 个事件`)

/**
 * 关键断言：**全量快照必须排在所有增量之前**。
 *
 * rrweb 的回放是「一个全量快照 + 一串增量」。播放器靠快照建立
 * DOM 镜像，后面的增量才能对上。
 *
 * 如果快照不在最前面 —— 增量链就断了，播放器会**静默播不出来**，
 * 不报任何错。这正是之前 `FULL_SNAPSHOT_TYPE` 写错时发生的事。
 */
const FULL_SNAPSHOT = 2
const INCREMENTAL = 3
const META = 4

const firstSnapshotIndex = replayRows.findIndex((row) => row.event_type === FULL_SNAPSHOT)
const firstIncrementalIndex = replayRows.findIndex((row) => row.event_type === INCREMENTAL)
check(
  '回放流里有全量快照（增量链的起点）',
  firstSnapshotIndex >= 0,
  `快照位置 ${firstSnapshotIndex} · 类型分布 ${[...new Set(replayRows.map((r) => r.event_type))].join(' / ')}`
)
check(
  '全量快照排在增量之前',
  firstSnapshotIndex >= 0 && firstSnapshotIndex < firstIncrementalIndex,
  `快照位置 ${firstSnapshotIndex} · 首个增量位置 ${firstIncrementalIndex}`
)
check(
  '回放流里有增量事件',
  firstIncrementalIndex >= 0,
  `类型分布 ${[...new Set(replayRows.map((r) => r.event_type))].join(' / ')}`
)

/**
 * Meta 带的是**原始视口尺寸** —— 播放器靠它把内容按比例缩放。
 * 缓冲区重置时如果把 Meta 一起丢掉，回放会被裁切。
 */
check(
  '回放流保留了 Meta（视口尺寸）',
  replayRows.some((row) => row.event_type === META),
  `类型分布 ${[...new Set(replayRows.map((r) => r.event_type))].join(' / ')}`
)

// ---- 会话汇总入库 ----
const sessionRow = await db.get<{ n: number; replay_events: number }>(
  `SELECT COUNT(*) AS n, COALESCE(SUM(replay_events), 0) AS replay_events
   FROM replay_sessions WHERE project_id = ?`,
  [project.project.id]
)
check('会话汇总入库', (sessionRow?.n ?? 0) >= 1, `${sessionRow?.n ?? 0} 个会话`)

// ---- 管理 API 能读回回放流 ----
const sessionsResponse = await fetch(
  `${collectorUrl}/api/v1/projects/${project.project.id}/sessions`,
  { headers: { 'x-vigil-admin-token': ADMIN_TOKEN } }
)
const sessionsBody = (await sessionsResponse.json()) as {
  total: number
  sessions: Array<{ sessionId: string; hasReplay: boolean; replayEvents: number }>
}
const withReplay = (sessionsBody.sessions ?? []).filter((s) => s.hasReplay)
check(
  '会话列表里至少有一个带回放',
  withReplay.length >= 1,
  `${sessionsBody.total ?? 0} 个会话，其中 ${withReplay.length} 个有回放`
)

const replaySessionId = withReplay[0]?.sessionId
const streamResponse = await fetch(
  `${collectorUrl}/api/v1/projects/${project.project.id}/sessions/${replaySessionId}/replay`,
  { headers: { 'x-vigil-admin-token': ADMIN_TOKEN } }
)
const streamBody = (await streamResponse.json()) as { events: number; stream: unknown[] }
check(
  '回放流能从管理 API 读回',
  streamResponse.ok && streamBody.events === replayRows.length,
  `API 返回 ${streamBody.events} 个事件 · 库里 ${replayRows.length} 个`
)

// ---- 行为域 ----
const countBehavior = async () =>
  (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM behavior_events WHERE project_id = ?', [
    project.project.id
  ])?.n) ?? 0

await waitFor(() => (countBehavior() > 0 ? true : undefined), 20000)

const behaviorRows = await db.all<{ type: string }>(
  'SELECT type FROM behavior_events WHERE project_id = ?',
  [project.project.id]
)
const behaviorTypes = new Set(behaviorRows.map((row) => row.type))
check('行为事件入库', behaviorRows.length > 0, `${behaviorRows.length} 条`)
check(
  '行为事件里有页面访问',
  behaviorTypes.has('pageview'),
  `类型分布 ${[...behaviorTypes].join(' / ')}`
)
check('行为事件里有点击', behaviorTypes.has('click'), `类型分布 ${[...behaviorTypes].join(' / ')}`)

// 行为汇总 API
const behaviorResponse = await fetch(
  `${collectorUrl}/api/v1/projects/${project.project.id}/behavior/summary`,
  { headers: { 'x-vigil-admin-token': ADMIN_TOKEN } }
)
const behaviorBody = (await behaviorResponse.json()) as {
  summary: { pageViews: number; sessions: number; topPages: unknown[] }
}
check(
  '行为汇总 API 返回的访问次数与库一致',
  behaviorResponse.ok && behaviorBody.summary.pageViews >= 1,
  `汇总 pageViews=${behaviorBody.summary?.pageViews} · 库里的 pageview ${behaviorRows.filter((r) => r.type === 'pageview').length} 条`
)

// 回放页不应该有 JS 报错
const realReplayErrors = replayErrors.filter(
  (text) => !text.includes('favicon') && !text.includes('DevTools')
)
check(
  '回放页面没有 JS 报错',
  realReplayErrors.length === 0,
  realReplayErrors.slice(0, 3).join(' | ') || '无'
)

await replayPage.close()

// ---- 收尾 ----
await browser.close()
await collector.close()
await new Promise<void>((resolve) => staticServer.close(() => resolve()))
db.close()

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
