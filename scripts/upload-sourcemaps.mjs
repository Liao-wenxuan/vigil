/**
 * 上传 sourcemap 到 Vigil Collector。
 *
 * 放在 CI 里跑，**不放在构建产物目录里**：
 * sourcemap 等于源码，公开可下载的文件等于公开源码。
 * 所以 map 只上传到 Collector，由 Collector 在服务端还原。
 *
 * 用法：
 *   node scripts/upload-sourcemaps.mjs \
 *     --app-id app_xxx \
 *     --upload-token vup_xxx \
 *     --release 1.0.0 \
 *     --dir dist/assets
 *
 * 环境变量也可以（CI 里更方便）：
 *   VIGIL_APP_ID / VIGIL_UPLOAD_TOKEN / VIGIL_COLLECTOR_URL / VIGIL_RELEASE
 *
 * 匹配规则：找到 `xxx.js` 就找同名的 `xxx.js.map`，
 * 上传时 fileName 用**产物路径**（如 assets/index-DnB3xK2l.js），
 * 因为浏览器上报的栈里就是这个路径。
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith('--')) continue
    args[key.slice(2)] = argv[i + 1]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const appId = args['app-id'] ?? process.env.VIGIL_APP_ID
const uploadToken = args['upload-token'] ?? process.env.VIGIL_UPLOAD_TOKEN
const release = args.release ?? process.env.VIGIL_RELEASE
const collectorUrl = args.collector ?? process.env.VIGIL_COLLECTOR_URL ?? 'http://localhost:4318'
const dir = args.dir ?? 'dist/assets'

if (!appId || !uploadToken || !release) {
  console.error('缺少参数：--app-id / --upload-token / --release（或对应环境变量）')
  process.exit(1)
}

if (!fs.existsSync(dir)) {
  console.error(`目录不存在：${dir}`)
  process.exit(1)
}

function walk(dirPath, out = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const all = walk(dir)
const jsFiles = all.filter((f) => f.endsWith('.js'))
const files = []

for (const jsFile of jsFiles) {
  const mapFile = `${jsFile}.map`
  if (!fs.existsSync(mapFile)) continue

  // fileName 用**产物路径**，去掉目录前缀 —— 浏览器上报的栈里就是这个相对路径
  const relative = path.relative(dir, jsFile).split(path.sep).join('/')
  files.push({
    fileName: relative,
    sourceMap: fs.readFileSync(mapFile, 'utf8')
  })
}

if (files.length === 0) {
  console.log(`没有找到 .js.map 文件，跳过（目录 ${dir}）`)
  process.exit(0)
}

console.log(`准备上传 ${files.length} 个 sourcemap，release=${release}`)

const response = await fetch(`${collectorUrl}/api/v1/sourcemaps`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-vigil-app-id': appId,
    'x-vigil-upload-token': uploadToken
  },
  body: JSON.stringify({ appId, release, files })
})

if (!response.ok) {
  console.error(`上传失败：HTTP ${response.status}`)
  console.error(await response.text())
  process.exit(1)
}

const body = await response.json()
console.log(`✓ 上传成功：${body.uploaded} 个文件`)
