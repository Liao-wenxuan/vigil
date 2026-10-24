import { libConfig } from './vite.lib'

/**
 * 主入口产物：
 *   dist/index.js      ESM，给 bundler 用（npm install）
 *   dist/index.iife.js 浏览器全局，给 `<script>` 直接引用
 *
 * 这个构建**清空** dist —— 它是第一个跑的。
 */
export default libConfig('src/index.ts', 'index', {
  emptyOutDir: true,
  formats: ['es', 'iife'],
  globalName: 'Vigil'
})
