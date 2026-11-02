#!/usr/bin/env node

/**
 * 部署冒烟：跑在**服务器上**，验证容器拓扑真的通了。
 *
 * ## 为什么需要它
 *
 * `docker compose ps` 全 Up 不代表能用。这套部署有三个
 * 「看起来正常、实际全废」的坑，每一个都不会报错：
 *
 *   1. 面板 nginx 没注入管理 token → 页面能打开，每个接口 401，全站空白
 *   2. SDK 没托管 → 业务页面 <script src> 404，一条数据都收不到
 *   3. 面板没有登录 → 一切正常，但任何人都能读走全部数据
 *
 * 这三条都只能靠**发真实请求**才能发现。
 *
 * ## 用法
 *
 *   node scripts/smoke-deploy.mjs
 *   VIGIL_URL=https://vigil.example.com node scripts/smoke-deploy.mjs
 *
 * 需要的环境变量与 .env 一致：VIGIL_ADMIN_TOKEN / VIGIL_PANEL_USER /
 * VIGIL_PANEL_PASSWORD。从 .env 读也行（脚本自己 load）。
 */

import fs from 'node:fs'
import path from 'node:path'

const BASE = (process.env.VIGIL_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')

/** 读 .env（没有就跳过），只补环境里缺失的键 */
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match) continue
    const [, key, raw] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = raw.replace(/^['"]|['"]$/g, '')
  }
}

loadDotEnv()

const PANEL_USER = process.env.VIGIL_PANEL_USER ?? 'admin'
const PANEL_PASSWORD = process.env.VIGIL_PANEL_PASSWORD ?? ''

const basic =
  PANEL_PASSWORD === ''
    ? undefined
    : `Basic ${Buffer.from(`${PANEL_USER}:${PANEL_PASSWORD}`).toString('base64')}`

const results = []

function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name} — ${detail}`)
  return pass
}

/** 发请求，不抛错 */
async function request(pathname, init = {}) {
  try {
    const response = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(basic ? { authorization: basic } : {}) },
      signal: AbortSignal.timeout(10_000)
    })
    const body = await response.text()
    return { status: response.status, body, headers: response.headers }
  } catch (error) {
    // headers 给 null 而不是空 Headers：调用方一律用可选链读，
    // 这样连不上和连上了但没有响应头是两种情况，不会混淆
    return { status: 0, body: String(error), headers: null }
  }
}

console.log(`\n[Vigil 部署冒烟] ${BASE}\n`)

// ---- 1. 面板可达 ----
const panel = await request('/')
check('面板可访问', panel.status === 200, `HTTP ${panel.status}`)

// ---- 2. 面板登录真的生效（不是摆设）----
if (PANEL_PASSWORD !== '') {
  const anonymous = await fetch(`${BASE}/api/v1/organizations`, {
    signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined)
  check(
    '未登录时管理接口被拒绝',
    anonymous?.status === 401,
    `HTTP ${anonymous?.status ?? '连接失败'}（期望 401）`
  )
} else {
  console.log('  · 未设置 VIGIL_PANEL_PASSWORD，跳过登录校验 —— ⚠️ 面板当前无保护')
}

// ---- 3. 管理接口通（同时验证 nginx 注入 token + 数据库）----
const orgs = await request('/api/v1/organizations', { headers: { accept: 'application/json' } })
let orgsOk = false
try {
  orgsOk = orgs.status === 200 && JSON.parse(orgs.body).ok === true
} catch {
  orgsOk = false
}
check(
  '管理接口可用（token 注入 + 数据库）',
  orgsOk,
  orgsOk
    ? `HTTP 200，${JSON.parse(orgs.body).organizations?.length ?? 0} 个组织`
    : `HTTP ${orgs.status}：${orgs.body.slice(0, 120)}`
)

// ---- 4. SDK 产物在托管 ----
const sdk = await request('/sdk/index.iife.js')
const sdkLooksRight = sdk.status === 200 && sdk.body.includes('Vigil')
check(
  'SDK 产物可下载',
  sdkLooksRight,
  sdkLooksRight
    ? `HTTP 200，${(sdk.body.length / 1024).toFixed(0)}KB，${sdk.headers?.get('content-type') ?? ''}`
    : `HTTP ${sdk.status}（业务页面会引不到 SDK）`
)

// ---- 5. 上报通道活着，且要求项目密钥 ----
const ingest = await request('/api/v1/collect', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ appId: 'smoke', events: [{ category: 'javascript' }] })
})
check(
  '上报通道可用且要求项目密钥',
  ingest.status === 401,
  `HTTP ${ingest.status}（期望 401 —— 没带项目密钥就该被拒）`
)

// ---- 汇总 ----
const failed = results.filter((r) => !r.pass)
console.log('\n' + '─'.repeat(60))
console.log(
  `断言 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条`
)
console.log('─'.repeat(60) + '\n')

if (failed.length > 0) {
  console.log('排查：docs/deploy.md 第 8 节\n')
  process.exit(1)
}
