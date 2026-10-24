import { libConfig } from './vite.lib'

/**
 * Vue 适配器产物：dist/vue.js
 *
 * **不清空** dist —— 否则会把上一个构建（index.js）删掉。
 *
 * 只有 ESM：Vue 项目都是用 bundler 构建的，不需要 IIFE 版本。
 */
export default libConfig('src/vue.ts', 'vue', { emptyOutDir: false })
