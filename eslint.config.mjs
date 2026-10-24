import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.d.ts']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Vue 单文件组件 —— 不配的话 .vue 文件会被 ESLint 静默跳过
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      // .vue 里的 <script setup lang="ts"> 不会像 .ts 那样被自动关掉 no-undef，
      // 所以浏览器全局要显式声明一遍
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        performance: 'readonly',
        crypto: 'readonly',
        sessionStorage: 'readonly',
        localStorage: 'readonly',
        history: 'readonly',
        screen: 'readonly',
        requestAnimationFrame: 'readonly'
      }
    }
  },
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
    // Node 侧的脚本：.mjs 不是 TS，typescript-eslint 不会帮它关掉 no-undef，
    // 所以这里显式声明 Node 内置全局。
    files: ['scripts/**/*.mjs', '**/*.config.mjs', '**/*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    }
  }
)
