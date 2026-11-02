/**
 * 发布准备闸门 —— SDK 能不能真的被装上。
 *
 * ## 为什么需要
 *
 * 「代码本地跑得好好的」不等于「npm 上装得上」。
 * 发布前最容易出的几类错，都**不会在本地测试里暴露**：
 *
 * 1. **类型声明引用了不可发布的包** ——
 *    SDK 的 `.d.ts` 里 `import type { ... } from '@vigil/protocol'`，
 *    而那个包标了 `private: true` → 消费者装不到 →
 *    TypeScript 直接报「找不到模块」。
 *    本地是 workspace 链接，**永远看不出来**。
 * 2. **依赖装错位置** —— 已经在产物里的库（rrweb 被打进了 replay chunk）
 *    还挂在 `dependencies` 里 → 每个消费者白白装几百 KB。
 * 3. **产物缺文件 / 混进 source map** —— tarball 里少个 `.d.ts`，
 *    消费者用起来才发现类型全丢。
 * 4. **包太大** —— 无声地把安装时间拖上去。
 *
 * ## 怎么查
 *
 * `npm pack --dry-run --json` 会打出**将要发布的文件清单**，
 * 直接拿它当事实来源，不用猜。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 仓库根目录。
 *
 * ⚠️ **不能写死绝对路径** —— CI 是 Linux，写死 `D:/...` 会直接 ENOENT。
 * 从脚本自身位置推导（脚本在 `<根>/scripts/` 下，所以上一级就是根）。
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 要发布的包 */
const PACKAGES = [
  { dir: 'packages/protocol', name: '@vigil/protocol' },
  { dir: 'packages/sdk', name: '@vigil/sdk' }
]

/** tarball 体积上限（未压缩，字节）。超过说明产物里混进了不该进的东西 */
const SIZE_LIMIT = 800 * 1024

interface PackFile {
  path: string
  size: number
}

interface PackResult {
  name: string
  version: string
  size: number
  unpackedSize: number
  files: PackFile[]
}

const failures: string[] = []

function fail(message: string): void {
  failures.push(message)
  console.log(`  ✗ ${message}`)
}

/** 包清单里的关键字段 */
function readManifest(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

console.log('[发布准备] 检查 npm 包\n')

// ---- 全仓扫描：哪些包可以发布 ----
const workspaceDirs = readdirSync(join(ROOT, 'packages')).filter((d) =>
  existsSync(join(ROOT, 'packages', d, 'package.json'))
)
const publishable = new Set<string>()
for (const dir of workspaceDirs) {
  const manifest = readManifest(join('packages', dir))
  if (manifest.private === true) continue
  publishable.add(manifest.name as string)
}
console.log(`  可发布的包：${[...publishable].join('、') || '（无）'}\n`)

for (const pkg of PACKAGES) {
  console.log(`▸ ${pkg.name}`)
  const manifest = readManifest(pkg.dir)

  // ---- 清单本身 ----
  if (manifest.private === true) fail(`${pkg.name} 标了 private: true —— 装不了`)
  for (const field of ['name', 'version', 'license', 'description', 'repository']) {
    if (manifest[field] === undefined) fail(`${pkg.name} 缺 ${field} 字段`)
  }
  const publishConfig = manifest.publishConfig as { access?: string } | undefined
  if (publishConfig?.access !== 'public') {
    fail(`${pkg.name} 缺 publishConfig.access=public（作用域包默认是私有的）`)
  }

  // ---- 产物与依赖的交叉检查 ----
  // 类型声明里引用的每个**外部** @vigil/* 包，都必须可发布。
  // ⚠️ 子路径导出（`@vigil/sdk/replay`）不是外部包 —— 那是这个包自己的入口。
  const distDir = join(ROOT, pkg.dir, 'dist')
  if (existsSync(distDir)) {
    for (const file of readdirSync(distDir)) {
      if (!file.endsWith('.d.ts')) continue
      const content = readFileSync(join(distDir, file), 'utf8')
      const refs = [...content.matchAll(/from '(@vigil\/[^']+)'/g)].map((m) => m[1])
      for (const ref of new Set(refs)) {
        if (ref === pkg.name || ref.startsWith(`${pkg.name}/`)) continue
        if (!publishable.has(ref)) {
          fail(`${pkg.name}/dist/${file} 引用了不可发布的包 ${ref} —— 消费者会装不到`)
        }
      }
    }
  }

  // ---- tarball 里到底有什么 ----
  let pack: PackResult
  try {
    // ⚠️ Windows 上 npm 是 npm.cmd —— 直接 spawn 会 EINVAL，必须走 shell
    const raw = execFileSync('npm pack --dry-run --json', {
      cwd: join(ROOT, pkg.dir),
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    pack = (JSON.parse(raw) as PackResult[])[0]
  } catch (error) {
    fail(`${pkg.name} 打包失败：${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  const paths = pack.files.map((f) => f.path)
  const maps = paths.filter((p) => p.endsWith('.map'))
  if (maps.length > 0) fail(`${pkg.name} 的 tarball 混进了 ${maps.length} 个 source map`)

  if (!paths.some((p) => p.endsWith('package.json'))) {
    fail(`${pkg.name} 的 tarball 里没有 package.json`)
  }
  if (!paths.some((p) => p.endsWith('README.md'))) {
    fail(`${pkg.name} 的 tarball 里没有 README.md（npm 上会没有说明）`)
  }

  if (pack.unpackedSize > SIZE_LIMIT) {
    fail(
      `${pkg.name} 产物 ${Math.round(pack.unpackedSize / 1024)}KB，超过上限 ${Math.round(SIZE_LIMIT / 1024)}KB`
    )
  }

  console.log(
    `  ${pack.files.length} 个文件 · 打包后 ${Math.round(pack.size / 1024)}KB · 解包 ${Math.round(pack.unpackedSize / 1024)}KB`
  )
  console.log('')
}

console.log('─'.repeat(60))
if (failures.length === 0) {
  console.log(`闸门 1 条，通过 1 条，失败 0 条`)
  console.log('─'.repeat(60))
} else {
  console.log(`闸门 1 条，通过 0 条，失败 1 条（${failures.length} 处问题）`)
  console.log('─'.repeat(60))
  process.exitCode = 1
}
