/**
 * 管理面板的端到端验证。
 *
 * 验证的是**渲染出来的数字**，不是截图：
 *   - 应用下拉里有几个应用
 *   - 错误表格渲染了几行
 *   - 统计卡片的数字对不对
 *   - 点一行能不能打开详情、里面有没有栈
 *
 * 面板是给人看的东西，但「看起来对」不等于「渲染对了」——
 * 断言落在 DOM 的实际文本上，才有说服力。
 *
 * 用法：
 *   node --import tsx scripts/verify-dashboard.ts --url http://localhost:5174
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const argValue = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 ? args[index + 1] : fallback
}

const url = argValue('url', 'http://localhost:5174')

const results: Array<{ name: string; pass: boolean; detail: string }> = []

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name} — ${detail}`)
}

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

console.log(`\n[Vigil 面板验证] ${url}\n`)

const browser = await launchChromium()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const consoleErrors: string[] = []
page.on('console', (message) => {
  if (message.type() !== 'error') return
  // 404 的 favicon 之类不算页面报错，但 URL 在 location 里不在 text 里
  const url = message.location()?.url ?? ''
  if (url.includes('favicon')) return
  consoleErrors.push(`${message.text()}: ${url}`)
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

await page.goto(url, { waitUntil: 'load' })

// 等错误表格出现
await page.waitForSelector('.el-table__row', { timeout: 20000 })

// ---- 1. 顶栏 ----
const brand = await page.locator('.brand-name').textContent()
check('页面标题渲染', brand?.trim() === 'Vigil', `brand-name = "${brand?.trim()}"`)

// ---- 2. 应用下拉 ----
// ⚠️ 必须限定在**可见的**下拉里：页面有两个 el-select（应用 + 分类），
//    Element Plus 把两个 popper 都挂在 body 上，未展开的那个也在 DOM 里。
//    不限定就会把分类的 3 个选项一起数进来。
await page.locator('.app-select').click()
await page.waitForSelector('.el-select__popper:visible', { timeout: 8000 })
const appOptions = await page
  .locator('.el-select__popper:visible .el-select-dropdown__item')
  .count()
check('应用下拉里有 2 个应用', appOptions === 2, `${appOptions} 个`)
await page.keyboard.press('Escape')

// ---- 3. 统计卡片 ----
const cardValues = await page.locator('.card-value').allTextContents()
const cardLabels = await page.locator('.card-label').allTextContents()
const cardMap = new Map(cardLabels.map((label, i) => [label.trim(), cardValues[i]?.trim() ?? '']))

check(
  '「去重错误」卡片显示 8',
  cardMap.get('去重错误') === '8',
  `去重错误 = ${cardMap.get('去重错误')}`
)
check(
  '「累计发生」卡片显示 107',
  cardMap.get('累计发生') === '107',
  `累计发生 = ${cardMap.get('累计发生')}`
)

// ---- 4. 错误表格 ----
const rowCount = await page.locator('.el-table__row').count()
check('错误表格渲染了 8 行', rowCount === 8, `${rowCount} 行`)

// 表格默认按「最近出现」排序，不是按次数。
// 所以断言要落在**具体那一行**上，而不是「第一行」。
const priceRow = page.locator('.el-table__row', { hasText: 'price' }).first()
const priceRowText = (await priceRow.textContent()) ?? ''
const priceRowCount = (await priceRow.locator('.err-count').textContent())?.trim() ?? ''
check(
  '聚合最多的那条错误显示 59 次',
  priceRowCount === '59' && priceRowText.includes('price'),
  `含 "price" 的行次数 = ${priceRowCount}`
)

const categoryTags = await page.locator('.el-table__row .el-tag').allTextContents()
const distinctCategories = new Set(categoryTags.map((tag) => tag.trim()))
check(
  '表格里出现了 3 种分类标签',
  distinctCategories.size === 3,
  [...distinctCategories].join(' / ')
)

// ---- 5. 分布区块 ----
const distBlocks = await page.locator('.dist-block').count()
check('分布区块有 3 组（分类 / 接口 / 浏览器）', distBlocks === 3, `${distBlocks} 组`)

// ---- 6. 点开详情抽屉 ----
// ⚠️ 点**有栈的那一行**（JS 错误）。资源错误本来就没有栈 ——
//    对它断言「有原始栈」是在断言一件不存在的事。
await priceRow.click()
await page.waitForSelector('.el-drawer__body', { timeout: 8000 })

const drawerText = (await page.locator('.el-drawer__body').textContent()) ?? ''
check('详情抽屉打开了', drawerText.length > 0, `抽屉内容 ${drawerText.length} 字符`)
check('详情里有原始栈', drawerText.includes('原始栈'), '包含「原始栈」区块')
check('详情里有指纹', /[0-9a-f]{16}/.test(drawerText), '包含 16 位十六进制指纹')
check('详情里有发生次数', drawerText.includes('发生次数'), '包含「发生次数」字段')

// ---- 7. 控制台没有报错 ----
const realErrors = consoleErrors.filter(
  (text) => !text.includes('favicon') && !text.includes('DevTools')
)
check('页面没有 JS 报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || '无')

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
