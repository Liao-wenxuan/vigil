import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 采集器跑在浏览器里，用 jsdom 提供 window / document / navigator
    environment: 'jsdom',
    include: ['tests/**/*.test.ts']
  }
})
