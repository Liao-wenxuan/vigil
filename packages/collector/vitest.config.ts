import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // better-sqlite3 是原生模块，多线程跑要各自持有独立连接，
    // 这里串行跑，避免 SQLite 文件锁互相干扰
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
})
