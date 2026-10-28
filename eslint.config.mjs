import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

/**
 * 浏览器全局。
 *
 * .vue 里的 <script setup lang="ts"> 不会像 .ts 那样被自动关掉 no-undef，
 * 所以这些必须显式声明。
 */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  fetch: 'readonly',
  Blob: 'readonly',
  FormData: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  sessionStorage: 'readonly',
  localStorage: 'readonly',
  history: 'readonly',
  screen: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  MediaQueryList: 'readonly',
  MediaQueryListEvent: 'readonly',
  // DOM 类型名（TypeScript 的类型标注里也要能解析）
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  MouseEvent: 'readonly',
  KeyboardEvent: 'readonly',
  CustomEvent: 'readonly',
  // Playwright 的 page.evaluate() 里的代码跑在**浏览器**里，
  // 但 ESLint 按当前文件的语法环境解析 —— 这几个是浏览器全局
  getComputedStyle: 'readonly',
  cancelAnimationFrame: 'readonly'
}

/** Node 全局 */
const nodeGlobals = {
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setImmediate: 'readonly'
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.d.ts']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Vue 单文件组件 —— 不配的话 .vue 文件会被 ESLint 静默跳过
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    rules: {
      // SDK 要在浏览器里跑，unknown 比 any 安全；这里把 any 降级成 warning 而不是禁用，
      // 因为第三方类型（DOM / Fastify）偶尔还是会漏出 any。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-console': 'off'
    }
  },
  {
    // 面板是浏览器应用：src 下的 .ts 和 .vue 都要浏览器全局
    files: ['packages/dashboard/src/**/*.ts', 'packages/dashboard/src/**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: browserGlobals
    }
  },
  {
    // 通用 .vue（其它包里可能还有）
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: browserGlobals
    }
  },
  {
    // Node 侧脚本。
    // 浏览器全局也要声明 —— Playwright 的 page.evaluate() 里的代码
    // 是在**浏览器**里跑的，但 ESLint 按 Node 解析这个文件。
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...nodeGlobals, ...browserGlobals }
    }
  },
  {
    // 端到端验证脚本：跑在 Node 里，但要在页面上下文里 evaluate，
    // 所以 window / document 也会被 ESLint 看到
    files: ['**/tests/**/*.mjs', '**/tests/**/*.ts'],
    languageOptions: {
      globals: { ...nodeGlobals, ...browserGlobals }
    }
  },
  {
    // 配置文件
    files: ['**/*.config.mjs', '**/*.config.js'],
    languageOptions: {
      globals: nodeGlobals
    }
  }
)
