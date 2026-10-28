import { defineConfig } from 'vite'

/**
 * SDK lib 构建的公共配置。
 *
 * ## 为什么每个入口单独构建，而不是多入口一次构建
 *
 * Vite 的 lib 模式配多个 entry 时，会把**两个入口共用的代码**抽成
 * 一个共享 chunk（`vue.js` 和 `index.js` 都用到了 `parse-stack.ts`）。
 * 结果就是产物变成三个文件，`<script type="module">` 直接引就断了。
 *
 * Rollup 的 `inlineDynamicImports` 正是为「合并成一个文件」准备的，
 * 但它和「多入口」互斥 —— 同时配置会直接报错。
 *
 * 所以：**一个入口一次构建**，各自单文件，互不干扰。
 *
 * ## 为什么要额外的 IIFE 产物
 *
 * ESM 产物有个致命限制：**`<script type="module">` 默认是 defer 的**。
 * 也就是说，SDK 的初始化一定发生在 HTML 解析完成之后。
 *
 * 而资源加载错误（`<img src="404.png">`）是在**解析过程中**就触发的 ——
 * 用 ESM 接入，页面上首屏的静态资源失败**一条都收不到**。
 *
 * IIFE 产物可以放在 `<head>` 里同步加载并初始化，
 * 在解析到 `<body>` 之前就把监听器装好，静态资源失败才收得到。
 */

export interface LibConfigOptions {
  /** 是否清空 dist。Vite 默认清空 —— 两次构建时必须显式区分 */
  emptyOutDir?: boolean
  /** 输出格式 */
  formats?: Array<'es' | 'iife'>
  /** IIFE 的全局变量名 */
  globalName?: string
}

export function libConfig(
  entry: string | Record<string, string>,
  name: string,
  options: LibConfigOptions = {}
) {
  const formats = options.formats ?? ['es']

  return defineConfig({
    build: {
      target: 'es2018',
      // SDK 自己也可能抛错，这些栈要能被还原才有排查价值
      sourcemap: true,
      minify: 'esbuild',
      emptyOutDir: options.emptyOutDir ?? false,
      lib: {
        // 传对象时，**键名**就是产物名（`{ replay: 'src/x.ts' }` → `replay.js`）；
        // 传字符串时 Vite 用**文件名**当产物名（`src/replay-entry.ts` → `replay-entry.js`）
        entry,
        formats,
        name: options.globalName,
        fileName: (format, entryName) =>
          format === 'es' ? `${entryName}.js` : `${entryName}.iife.js`
      }
    }
  })
}
