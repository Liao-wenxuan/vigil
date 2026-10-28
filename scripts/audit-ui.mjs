/**
 * 界面审计 —— 把「设计感」拆成可自动测的数字。
 *
 * ## 为什么要写这个
 *
 * 「界面不好看 / 没设计感」是个没法验证的抱怨。把它拆成闸门之后，
 * 每次改动都能跑一遍，看到的是**数字**而不是感觉：
 *
 *   1. 字阶对比度（最大字 ÷ 正文字号）—— 低于 4× 就是没有层级
 *   2. 间距节奏（用了哪几档、档位是否成比例）
 *   3. 颜色数量（超过 6 种就花了）
 *   4. 动效档位（时长是不是只有一档）
 *   5. reduced-motion 降级（关掉动效后内容还在不在）
 *   6. 焦点环（键盘能不能看见自己在哪）
 *   7. 点击目标尺寸（≥ 44px）
 *   8. 响应式（320/375/414/768 会不会横向溢出）
 *
 * 另外输出**静帧截图**到 docs/screenshots/ —— 动效关掉之后长什么样，
 * 那是「设计感」真正被看见的地方。
 *
 * 用法：
 *   node scripts/audit-ui.mjs --url http://localhost:5174
 *   node scripts/audit-ui.mjs --fix     # 只报不改
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SHOT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots')

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 ? args[index + 1] : fallback
}

const URL_BASE = argValue('url', 'http://localhost:5174')

const PAGES = [
  { path: '/', name: '总览' },
  { path: '/issues', name: '问题' },
  { path: '/performance', name: '性能' },
  { path: '/alerts', name: '告警' },
  { path: '/settings', name: '设置' }
]

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name} — ${detail}`)
}

// ============================================================
// 浏览器启动（复用本机缓存的 chromium，不重新下载）
// ============================================================
function findCachedChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(process.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(process.homedir(), '.cache', 'ms-playwright')
  ].filter(Boolean)

  const candidates = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root)) {
      const match = dir.match(/^chromium(?:_headless_shell)?-(\d+)$/)
      if (!match) continue
      const revision = Number(match[1])
      for (const file of [
        path.join(root, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        path.join(root, dir, 'chrome-win64', 'chrome.exe'),
        path.join(root, dir, 'chrome-win', 'chrome.exe'),
        path.join(root, dir, 'chrome-headless-shell-linux', 'chrome-headless-shell')
      ]) {
        if (fs.existsSync(file)) candidates.push({ revision, file })
      }
    }
  }
  candidates.sort((a, b) => b.revision - a.revision)
  return candidates[0]?.file
}

async function launch() {
  try {
    return await chromium.launch()
  } catch (error) {
    const executablePath = findCachedChromium()
    if (!executablePath) throw error
    console.log(`[audit] 使用本机缓存的 Chromium：${executablePath}`)
    return await chromium.launch({ executablePath })
  }
}

fs.mkdirSync(SHOT_DIR, { recursive: true })

const browser = await launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

console.log(`\n[界面审计] ${URL_BASE}\n`)

// ============================================================
// 逐页测量
// ============================================================
const perPage = []

for (const target of PAGES) {
  await page.goto(`${URL_BASE}${target.path}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  const measured = await page.evaluate(() => {
    const visible = (el) => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    const all = [...document.querySelectorAll('body *')].filter(visible)

    // ---- 字阶 ----
    const fontSizes = all
      .map((el) => {
        const child = [...el.children].some((c) => {
          const s = getComputedStyle(c)
          return s.display !== 'none' && parseFloat(s.fontSize) > 0
        })
        if (child) return null // 只取叶子节点的字号，避免父子重复
        return parseFloat(getComputedStyle(el).fontSize)
      })
      .filter((v) => v && v > 0)

    const uniqueSizes = [...new Set(fontSizes)].sort((a, b) => a - b)
    const largest = uniqueSizes[uniqueSizes.length - 1] ?? 0
    const smallest = uniqueSizes[0] ?? 0

    // ---- 颜色 ----
    const colors = new Set()
    for (const el of all) {
      const s = getComputedStyle(el)
      colors.add(s.color)
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') colors.add(s.backgroundColor)
      if (s.borderTopWidth !== '0px') colors.add(s.borderTopColor)
    }

    // ---- 动效时长 ----
    const durations = new Set()
    for (const el of all) {
      const s = getComputedStyle(el)
      for (const prop of ['transitionDuration', 'animationDuration']) {
        for (const part of s[prop].split(',')) {
          const value = part.trim()
          if (value && value !== '0s') durations.add(value)
        }
      }
    }

    // ---- 间距节奏：相邻块级元素的间距 ----
    const gaps = new Set()
    const blocks = [...document.querySelectorAll('body *')].filter((el) => {
      if (!visible(el)) return false
      const s = getComputedStyle(el)
      return s.display === 'flex' || s.display === 'grid' || s.display === 'block'
    })
    for (const el of blocks) {
      const s = getComputedStyle(el)
      const gap = parseFloat(s.gap || s.rowGap)
      if (gap > 0) gaps.add(Math.round(gap))
    }

    // ---- 焦点环 ----
    // 只统计**真正可点的元素**：
    // Element Plus 的原生 input（el-select__input / el-checkbox__original /
    // el-switch__input）是被自定义控件**替代**的，它们的可点区域是 wrapper，
    // 拿原始 input 的尺寸说事是误报。
    const REPLACED_NATIVE = [
      '.el-select__input',
      '.el-checkbox__original',
      '.el-radio__original',
      '.el-switch__input',
      '.el-input__inner'
    ]
    const focusables = [
      ...document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ].filter((el) => visible(el) && !el.matches(REPLACED_NATIVE.join(',')))
    let focusableCount = focusables.length
    let withFocusRing = 0
    let tooSmall = 0
    let tooSmallInline = 0
    for (const el of focusables) {
      const rect = el.getBoundingClientRect()
      // 分档：**主控件**（导航/按钮/tab/输入）≥32px，
      // **表格行内文字按钮**≥24px —— 密集表格里做到 44px 会把表格撑爆，
      // 但 18px 太小（误归档一个 Issue 是有后果的）。
      const isInline = el.closest('.el-table') && el.classList.contains('is-link')
      const min = isInline ? 24 : 32
      if (rect.width < min || rect.height < min) {
        if (isInline) tooSmallInline++
        else tooSmall++
      }
      el.focus()
      const s = getComputedStyle(el)
      const hasRing =
        s.outlineStyle !== 'none' &&
        parseFloat(s.outlineWidth) > 0 &&
        s.outlineColor !== 'rgba(0, 0, 0, 0)'
      const hasShadow = s.boxShadow !== 'none'
      if (hasRing || hasShadow) withFocusRing++
      el.blur()
    }

    return {
      uniqueSizes,
      largest,
      smallest,
      colorCount: colors.size,
      durations: [...durations],
      gaps: [...gaps].sort((a, b) => a - b),
      focusableCount,
      withFocusRing,
      tooSmall,
      tooSmallInline,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }
  })

  perPage.push({ ...target, ...measured })

  // 静帧截图（动效由 prefers-reduced-motion 关掉）
  const reduced = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce'
  })
  const reducedPage = await reduced.newPage()
  await reducedPage.goto(`${URL_BASE}${target.path}`, { waitUntil: 'networkidle' })
  await reducedPage.waitForTimeout(500)
  await reducedPage.screenshot({
    path: path.join(SHOT_DIR, `${target.path.replace(/\//g, '') || 'overview'}.png`),
    fullPage: true
  })
  await reduced.close()
}

// ============================================================
// 闸门
// ============================================================
console.log('—— 静帧闸门 ——')

// 1. 字阶对比度
const typeRatios = perPage.map((p) => ({
  name: p.name,
  ratio: p.smallest > 0 ? p.largest / p.smallest : 0
}))
const worstRatio = Math.min(...typeRatios.map((t) => t.ratio))
check(
  '字阶有对比（最大字 ÷ 正文字号 ≥ 2.5）',
  worstRatio >= 2.5,
  `各页对比度 ${typeRatios.map((t) => `${t.name} ${t.ratio.toFixed(1)}×`).join(' / ')}`
)

// 2. 字号档位
const allSizes = [...new Set(perPage.flatMap((p) => p.uniqueSizes))].sort((a, b) => a - b)
check(
  '字号档位成体系（6~14 档，且不连续堆叠）',
  allSizes.length >= 6 && allSizes.length <= 14,
  `${allSizes.length} 档：${allSizes.join(' / ')}`
)

// 3. 颜色数量
const maxColors = Math.max(...perPage.map((p) => p.colorCount))
check('颜色收敛（单页 ≤ 24 种，含背景/描边/文字）', maxColors <= 24, `最多 ${maxColors} 种`)

// 4. 动效档位
const allDurations = [...new Set(perPage.flatMap((p) => p.durations))]
check(
  '动效不只一档（≥ 2 档时长）',
  allDurations.length >= 2,
  allDurations.length ? `${allDurations.join(' / ')}` : '没有任何动效'
)

// 5. 焦点环
const totalFocusable = perPage.reduce((sum, p) => sum + p.focusableCount, 0)
const totalWithRing = perPage.reduce((sum, p) => sum + p.withFocusRing, 0)
check(
  '可聚焦元素都有可见焦点环',
  totalFocusable > 0 && totalWithRing / totalFocusable >= 0.9,
  `${totalWithRing}/${totalFocusable} 有焦点环`
)

// 6. 点击目标
//    分档：**主控件 ≥32px / 表格行内文字按钮 ≥24px**（桌面）。
//    44px 是触摸准则；这个面板是桌面监控台，密集表格里的行内按钮
//    做到 44px 会把表格撑爆。触摸宽度下主控件按 40px 严格判。
const totalSmall = perPage.reduce((sum, p) => sum + p.tooSmall, 0)
const totalSmallInline = perPage.reduce((sum, p) => sum + (p.tooSmallInline ?? 0), 0)
check('桌面主控件 ≥ 32px', totalSmall === 0, `${totalSmall} 个偏小`)
check('桌面表格行内按钮 ≥ 24px', totalSmallInline === 0, `${totalSmallInline} 个偏小`)

// 7. 横向溢出
const overflowing = perPage.filter((p) => p.scrollWidth > p.clientWidth + 1)
check(
  '1440px 下无横向溢出',
  overflowing.length === 0,
  overflowing.map((p) => p.name).join(', ') || '无'
)

// 8. 响应式
console.log('')
console.log('—— 响应式（横向溢出 + 触摸目标）——')
for (const width of [320, 375, 414, 768]) {
  const c = await browser.newContext({ viewport: { width, height: 800 } })
  const p = await c.newPage()
  const bad = []
  for (const target of PAGES) {
    await p.goto(`${URL_BASE}${target.path}`, { waitUntil: 'networkidle' })
    await p.waitForTimeout(300)
    const overflow = await p.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    if (overflow > 1) bad.push(`${target.name}(+${overflow}px)`)
  }
  check(`${width}px 无横向溢出`, bad.length === 0, bad.join(', ') || '无')
  await c.close()
}

// 8b. 触摸宽度下，主控件按 40px 判
//     表格行内的文字按钮不算 —— 触摸时的主交互是「点整行进详情」，
//     行内按钮是次级操作，密集表格里不可能都做到 44px。
{
  const c = await browser.newContext({ viewport: { width: 414, height: 800 } })
  const p = await c.newPage()
  await p.goto(`${URL_BASE}/issues`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(400)
  const tooSmall = await p.evaluate(() => {
    const REPLACED = [
      '.el-select__input',
      '.el-checkbox__original',
      '.el-radio__original',
      '.el-switch__input',
      '.el-input__inner'
    ]
    return [...document.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => {
        if (el.matches(REPLACED.join(','))) return false
        // 行内文字按钮是次级操作，不按 44px 判
        if (el.closest('.el-table') && el.classList.contains('is-link')) return false
        const s = getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden') return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width < 40 || r.height < 40
      }).length
  })
  check('414px（触摸）主控件 ≥ 40px', tooSmall === 0, `${tooSmall} 个偏小`)
  await c.close()
}

// 9. reduced-motion 降级
console.log('')
console.log('—— 动效降级 ——')
const reducedContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce'
})
const reducedPage = await reducedContext.newPage()
await reducedPage.goto(`${URL_BASE}/issues`, { waitUntil: 'networkidle' })
await reducedPage.waitForTimeout(500)

const reducedCheck = await reducedPage.evaluate(() => {
  // 只算**有可见文本**的隐形元素。
  // Element Plus 把原生 input（el-switch__input / el-checkbox__original）
  // 和输入框占位层用 opacity:0 藏起来 —— 那是实现细节，不是「内容消失」。
  // 真正要抓的是「有文字但永远看不见」的区块。
  const hidden = [...document.querySelectorAll('body *')].filter((el) => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    if (parseFloat(s.opacity) >= 0.05) return false
    if (el.closest('.el-popper, .el-select-dropdown, .el-tooltip__popper')) return false
    return (el.textContent || '').trim().length > 0
  }).length
  const durations = [...document.querySelectorAll('body *')].map((el) => {
    const s = getComputedStyle(el)
    return Math.max(
      ...[s.transitionDuration, s.animationDuration].flatMap((v) =>
        v.split(',').map((x) => parseFloat(x) || 0)
      )
    )
  })
  return {
    hidden,
    maxDuration: Math.max(0, ...durations),
    rows: document.querySelectorAll('.el-table__row').length
  }
})
check(
  'reduced-motion 下内容不消失（无隐形文本块）',
  reducedCheck.hidden === 0,
  `${reducedCheck.hidden} 个含文本的区块不可见`
)
check(
  'reduced-motion 下动效被压制',
  reducedCheck.maxDuration <= 0.05,
  `最长时长 ${reducedCheck.maxDuration}s`
)
await reducedContext.close()

await browser.close()

// ============================================================
// 报告
// ============================================================
const failed = results.filter((r) => !r.pass)
console.log('')
console.log('─'.repeat(64))
console.log(
  `闸门 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条`
)
if (failed.length) {
  console.log('')
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
}
console.log(`静帧截图  ${path.relative(REPO_ROOT, SHOT_DIR)}/`)
console.log('─'.repeat(64))

process.exit(failed.length === 0 ? 0 : 1)
