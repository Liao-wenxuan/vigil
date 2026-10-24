/**
 * 端到端闭环验证。
 *
 * 验证的是**真实链路**，不是 mock：
 *   真 Chromium → 真 SDK 产物 → 真 HTTP 上报 → 真 Collector → 真 SQLite → 真查询
 *
 * 覆盖五类错误源 + 三条关键不变量：
 *   1. 五种错误都能被采到（JS / Promise / 资源 / 接口 / 压缩产物）
 *   2. 同一个错误报两次会**聚合成一条**（count = 2）
 *   3. 压缩产物的栈能被 sourcemap **还原回源码位置**
 *   4. URL 里的 token 被**脱敏**
 *   5. 上报请求自身**不**被当成错误（否则会无限递归）
 *
 * 输出全是数字 —— 断言失败会打印实际值，不用截图判断。
 */
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from '../packages/collector/src/db.js'
import { createApp } from '../packages/collector/src/apps.js'
import { buildApp } from '../packages/collector/src/app.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SDK_DIST = path.join(REPO_ROOT, 'packages', 'sdk', 'dist', 'index.js')
const SDK_IIFE = path.join(REPO_ROOT, 'packages', 'sdk', 'dist', 'index.iife.js')

const ADMIN_TOKEN = 'admin_e2e_token'
const RELEASE = '1.0.0'

// ---- 断言工具：全部用数字说话 ----
const results: Array<{ name: string; pass: boolean; detail: string }> = []

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name} — ${detail}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询数据库直到条件满足或超时。
 *
 * 用固定 sleep 猜时间是不可靠的 —— CI 机器慢一点就会假失败。
 */
async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 15000,
  intervalMs = 150
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value !== undefined) return value
    await sleep(intervalMs)
  }
  return undefined
}

/**
 * 启动 Chromium。
 *
 * Playwright 期望的浏览器修订号和本机缓存的可能对不上
 * （比如 Playwright 1.64.1 要 revision 1248，本机缓存的是 1243），
 * 这时重新下载既慢又不一定下得动。
 *
 * 所以：先按默认方式启动，失败就**扫本地缓存**找现成的 chromium 用。
 * 补丁版本只差几个修订号时，Playwright 和浏览器的通信协议是兼容的。
 */
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

/** 找本机 ms-playwright 缓存里的 chromium 可执行文件 */
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
        path.join(root, dir, 'chrome-win', 'chrome.exe'),
        path.join(root, dir, 'chrome-headless-shell-linux', 'chrome-headless-shell'),
        path.join(root, dir, 'chrome-linux', 'chrome')
      ]
      for (const file of files) {
        if (fs.existsSync(file)) candidates.push({ revision, file })
      }
    }
  }

  // 修订号越大越新，优先用
  candidates.sort((a, b) => b.revision - a.revision)
  return candidates[0]?.file
}

// ---- 1. 准备：临时库 + 应用注册 ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-e2e-'))
const dbPath = path.join(tmpDir, 'e2e.db')
const db = createDb(dbPath)
const app = createApp(db, 'E2E 应用')

console.log(`\n[Vigil E2E] 临时库 ${dbPath}`)
console.log(`[Vigil E2E] appId ${app.appId}\n`)

if (!fs.existsSync(SDK_DIST) || !fs.existsSync(SDK_IIFE)) {
  console.error(
    `找不到 SDK 产物：${SDK_DIST} / ${SDK_IIFE}\n先跑 npm run build --workspace @vigil/sdk`
  )
  process.exit(1)
}

// ---- 2. 启动 Collector ----
const collector = buildApp({ db, adminToken: ADMIN_TOKEN })
await collector.listen({ port: 0, host: '127.0.0.1' })
const collectorAddress = collector.server.address()
const collectorPort =
  typeof collectorAddress === 'object' && collectorAddress ? collectorAddress.port : 0
const collectorUrl = `http://127.0.0.1:${collectorPort}`
console.log(`[Vigil E2E] Collector ${collectorUrl}`)

// ---- 3. 上传 sourcemap（模拟 CI 行为）----
// app.min.js 是「压缩产物」，只有 sourcemap 能把它还原回源码
const MINIFIED = 'function a(){throw new TypeError("E2E: 压缩产物里的错误")}a();\n'
const SOURCEMAP = {
  version: 3,
  file: 'app.min.js',
  sourceRoot: '',
  sources: ['src/user-profile.ts'],
  sourcesContent: ['export function loadUser() {\n  throw new TypeError("boom")\n}\n'],
  names: [],
  // 只有一段映射，覆盖第 1 行的所有列 —— 任意列都能还原到原始位置
  mappings: 'AAAA'
}

const uploadResponse = await fetch(`${collectorUrl}/api/v1/sourcemaps`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-vigil-app-id': app.appId,
    'x-vigil-upload-token': app.uploadToken
  },
  body: JSON.stringify({
    appId: app.appId,
    release: RELEASE,
    files: [{ fileName: 'app.min.js', sourceMap: JSON.stringify(SOURCEMAP) }]
  })
})
check('sourcemap 上传被接受', uploadResponse.ok, `HTTP ${uploadResponse.status}`)

// ---- 4. 启动静态服务器（测试页面 + SDK + 会失败的资源）----
//
// ⚠️ 这里用的是 **IIFE 产物**，而且在 <head> 里同步初始化。
//    ESM 产物（<script type="module">）默认 defer，初始化一定发生在
//    HTML 解析完成之后 —— 那样首屏静态资源的失败一条都收不到。
//    这个差异是真实存在的，页面 A / 页面 B 分别验证两种接入方式。
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
    appId: '${app.appId}',
    token: '${app.token}',
    release: '${RELEASE}',
    environment: 'e2e',
    flushIntervalMs: 400,
    maxBatchSize: 5
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

// ESM 接入的对照页：验证 ESM 产物本身也能正常上报
const PAGE_ESM = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Vigil E2E ESM</title></head>
<body>
<script type="module">
  import { init } from '/sdk/index.js'
  init({
    endpoint: '${collectorUrl}/api/v1/collect',
    appId: '${app.appId}',
    token: '${app.token}',
    release: '${RELEASE}',
    environment: 'e2e',
    flushIntervalMs: 400
  })
  setTimeout(() => {
    throw new Error('E2E: ESM 产物验证')
  }, 100)
  window.__vigilReady = true
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
  if (url.startsWith('/page-esm.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE_ESM)
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
const esmPageUrl = `http://127.0.0.1:${staticPort}/page-esm.html`
console.log(`[Vigil E2E] 测试页 ${pageUrl}`)
console.log(`[Vigil E2E] ESM 页 ${esmPageUrl}\n`)

// ---- 5. 真浏览器跑一遍 ----
const browser = await launchChromium()
const context = await browser.newContext()
const page = await context.newPage()

const consoleErrors: string[] = []
page.on('pageerror', (error) => {
  // 页面里故意抛的错（E2E 的测试用例本身就是靠抛错触发的），只留意外错误
  const text = error.message
  if (!text.includes('E2E:')) consoleErrors.push(text)
})

// ---- 6. 计数工具 ----
const countRows = () =>
  db.prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ?').get(app.appId) as { n: number }

/** 等到错误条数达到 n */
async function waitForCount(n: number, timeoutMs = 20000): Promise<number> {
  const result = await waitFor(() => {
    const rows = countRows()
    return rows.n >= n ? rows.n : undefined
  }, timeoutMs)
  return result ?? countRows().n
}

/**
 * 等到某一条特定错误出现。
 *
 * 比「凑够 N 条」可靠得多 —— 凑数的话，页面里错误的产生顺序一变，
 * 就可能在最后一条上报之前就跳到下一个页面，测出来的失败
 * 其实是自己跳页跳太快，不是产品的问题。
 */
async function waitForError(pattern: string, timeoutMs = 20000): Promise<number> {
  const result = await waitFor(() => {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM errors WHERE app_id = ? AND message LIKE ?')
      .get(app.appId, `%${pattern}%`) as { n: number }
    return row.n > 0 ? row.n : undefined
  }, timeoutMs)
  return result ?? 0
}

// 第一个页面：IIFE 接入（<head> 同步初始化）
await page.goto(pageUrl, { waitUntil: 'load' })
await page.waitForFunction(
  () => (window as unknown as { __vigilReady?: boolean }).__vigilReady === true
)

// ⚠️ 必须等这一页的错误落库再跳走 —— 页面里的错误是 setTimeout 触发的，
//    立刻导航走的话定时器根本不会执行，错误一条都产生不了。
//    （这是第一次跑 E2E 时真的踩到的坑：跳页跳太快，测出来的「0 条错误」
//     其实是测试写错了，不是 SDK 的问题。）
const minifiedCount = await waitForError('压缩产物')
const afterFirstPage = await waitForCount(4)
console.log(`[Vigil E2E] IIFE 页落库 ${afterFirstPage} 条（压缩产物错误 ${minifiedCount} 条）`)

// 第二个页面：ESM 产物接入（验证 ESM 产物本身也能上报）
await page.goto(esmPageUrl, { waitUntil: 'load' })
await page.waitForFunction(
  () => (window as unknown as { __vigilReady?: boolean }).__vigilReady === true
)

await waitForError('ESM 产物验证')

const totalDistinct = countRows().n
const totals = db
  .prepare('SELECT COALESCE(SUM(count), 0) AS c FROM errors WHERE app_id = ?')
  .get(app.appId) as { c: number }

console.log('')
check(
  '五类错误都落库了',
  totalDistinct >= 5,
  `去重后 ${totalDistinct} 条错误 / 累计 ${totals.c} 次发生`
)

// ---- 7. 分类断言 ----
const byCategory = db
  .prepare(
    'SELECT category, COUNT(*) AS n, COALESCE(SUM(count), 0) AS occurrences FROM errors WHERE app_id = ? GROUP BY category'
  )
  .all(app.appId) as Array<{ category: string; n: number; occurrences: number }>

const categoryMap = new Map(byCategory.map((row) => [row.category, row]))
check(
  'javascript 类被采到',
  (categoryMap.get('javascript')?.n ?? 0) >= 2,
  `${categoryMap.get('javascript')?.n ?? 0} 条（JS 聚合错误 + 压缩产物错误）`
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

// 首屏静态资源的失败必须收得到 —— 这正是要用 IIFE 产物在 <head> 同步初始化的原因
const resourceError = db
  .prepare(
    `SELECT resource_json, message FROM errors
     WHERE app_id = ? AND category = 'resource' LIMIT 1`
  )
  .get(app.appId) as { resource_json: string | null; message: string } | undefined

let resourceSrc: string | undefined
if (resourceError?.resource_json) {
  resourceSrc = (JSON.parse(resourceError.resource_json) as { src?: string }).src
}

check(
  '首屏静态资源失败被采到（IIFE 在 <head> 同步初始化）',
  resourceSrc?.includes('/missing-image.png') === true,
  resourceSrc ?? '未捕获到资源错误'
)

// ESM 产物接入也要能上报
const esmError = db
  .prepare(`SELECT COUNT(*) AS n FROM errors WHERE app_id = ? AND message LIKE '%ESM 产物验证%'`)
  .get(app.appId) as { n: number }

check('ESM 产物接入也能上报', esmError.n >= 1, `${esmError.n} 条`)

// ---- 8. 指纹聚合断言 ----
const aggregated = db
  .prepare(
    `SELECT fingerprint, message, count FROM errors
     WHERE app_id = ? AND message LIKE '%聚合验证%'`
  )
  .get(app.appId) as { fingerprint: string; message: string; count: number } | undefined

check(
  '同一个错误报两次聚合成一条',
  (aggregated?.count ?? 0) === 2,
  `指纹 ${aggregated?.fingerprint ?? 'N/A'} count=${aggregated?.count ?? 0}（期望 2）`
)

// ---- 9. sourcemap 还原断言 ----
const minifiedError = db
  .prepare(
    `SELECT fingerprint, message, raw_stack, resolved_stack FROM errors
     WHERE app_id = ? AND message LIKE '%压缩产物%'`
  )
  .get(app.appId) as
  | {
      fingerprint: string
      message: string
      raw_stack: string | null
      resolved_stack: string | null
    }
  | undefined

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

// ---- 10. 脱敏断言 ----
const storedUrl = db
  .prepare('SELECT url FROM errors WHERE app_id = ? ORDER BY id LIMIT 1')
  .get(app.appId) as { url: string }

check(
  'URL 里的 token 被脱敏',
  !storedUrl.url.includes('SECRET_TOKEN_123') && storedUrl.url.includes('token=***'),
  storedUrl.url
)

// ---- 11. 上报请求自身不被当成错误（防递归）----
const selfReports = db
  .prepare(
    `SELECT COUNT(*) AS n FROM errors
     WHERE app_id = ? AND (url LIKE '%/api/v1/collect%' OR http_json LIKE '%/api/v1/collect%')`
  )
  .get(app.appId) as { n: number }

check('上报请求自身没有被当成错误（无递归）', selfReports.n === 0, `${selfReports.n} 条`)

// ---- 12. 管理接口能查到 ----
const listResponse = await fetch(`${collectorUrl}/api/v1/apps/${app.appId}/errors?limit=100`, {
  headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
})
const listBody = (await listResponse.json()) as { total: number; errors: unknown[] }
check(
  '管理接口能查到错误列表',
  listResponse.ok && listBody.total === totalDistinct,
  `HTTP ${listResponse.status}，total=${listBody.total}`
)

const statsResponse = await fetch(`${collectorUrl}/api/v1/apps/${app.appId}/stats`, {
  headers: { 'x-vigil-admin-token': ADMIN_TOKEN }
})
const statsBody = (await statsResponse.json()) as {
  totals: { distinct_errors: number; occurrences: number }
  byCategory: Array<{ category: string }>
}
check(
  '统计接口的计数与错误表一致',
  statsBody.totals.distinct_errors === totalDistinct && statsBody.totals.occurrences === totals.c,
  `distinct=${statsBody.totals.distinct_errors} occurrences=${statsBody.totals.occurrences}，分类 ${statsBody.byCategory.length} 种`
)

// ---- 13. 页面卸载时的 beacon 通道 ----
// 导航离开会触发 pagehide → SDK 走 sendBeacon 发最后一批
const beforeUnload = totals.c
await page.goto('about:blank')
await sleep(1200)
const afterUnload = db
  .prepare('SELECT COALESCE(SUM(count), 0) AS c FROM errors WHERE app_id = ?')
  .get(app.appId) as { c: number }
check(
  '页面卸载后事件仍能送达（beacon 通道）',
  afterUnload.c >= beforeUnload,
  `卸载前 ${beforeUnload} 次 → 卸载后 ${afterUnload.c} 次`
)

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
