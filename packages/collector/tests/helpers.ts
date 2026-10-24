import { createHash } from 'node:crypto'
import type { ErrorEvent } from '@vigil/protocol'
import type { Database } from 'better-sqlite3'
import { createApp } from '../src/apps.js'
import { createDb } from '../src/db.js'

/**
 * 建一个内存库 + 一个已注册的应用。
 *
 * 返回类型必须显式写出来 —— 推断出来的类型会引用
 * `BetterSqlite3.Database`，这个名字在声明文件里无法被命名，
 * 导出时 TS 会报 TS4058。
 */
export function setupDb(): { db: Database; app: ReturnType<typeof createApp> } {
  const db = createDb(':memory:')
  const app = createApp(db, '测试应用')
  return { db, app }
}

/**
 * 把可读标签转成**合法的 16 位十六进制指纹**。
 *
 * 必须用合法格式 —— Collector 会校验指纹，
 * 格式不对的会走服务端兜底，指纹就不再由测试控制了。
 * 测试应该模拟 SDK 真实产出的格式，而不是一个假想的格式。
 */
export function fp(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 16)
}

/** 造一条最小事件 */
export function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    category: 'javascript',
    kind: 'js',
    name: 'TypeError',
    message: 'Cannot read properties of undefined',
    stack: 'TypeError: boom\n    at foo (https://a.com/index.js:10:5)',
    frames: [{ filename: 'https://a.com/index.js', functionName: 'foo', lineno: 10, colno: 5 }],
    fingerprint: fp('default'),
    url: 'https://a.com/page',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    sessionId: 'session-1',
    release: '1.0.0',
    environment: 'production',
    occurredAt: Date.now(),
    ...overrides
  }
}
