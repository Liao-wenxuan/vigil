import { describe, expect, it } from 'vitest'
import {
  basename,
  computeFingerprint,
  normalizeMessage,
  pathOf,
  stripBuildHash
} from '../src/fingerprint'

/** 造一条 JS 错误事件 */
function jsEvent(
  frames: Array<{ filename: string; functionName?: string; lineno?: number; colno?: number }>
) {
  return {
    category: 'javascript' as const,
    name: 'TypeError',
    message: 'Cannot read properties of undefined',
    frames
  }
}

describe('computeFingerprint', () => {
  it('同样的输入永远得到同样的指纹', () => {
    const input = jsEvent([{ filename: 'https://a.com/index.js', functionName: 'foo', lineno: 10 }])
    expect(computeFingerprint(input)).toBe(computeFingerprint(input))
  })

  it('行号变化不影响指纹（改一行代码不该让历史断掉）', () => {
    const a = computeFingerprint(
      jsEvent([{ filename: '/a/index.js', functionName: 'foo', lineno: 10, colno: 5 }])
    )
    const b = computeFingerprint(
      jsEvent([{ filename: '/a/index.js', functionName: 'foo', lineno: 99, colno: 1 }])
    )
    expect(a).toBe(b)
  })

  it('构建 hash 变化不影响指纹（否则每次发版所有错误都变成新的）', () => {
    const a = computeFingerprint(
      jsEvent([{ filename: '/a/index-DnB3xK2l.js', functionName: 'foo', lineno: 10 }])
    )
    const b = computeFingerprint(
      jsEvent([{ filename: '/a/index-Zz9Yx8Wq.js', functionName: 'foo', lineno: 10 }])
    )
    expect(a).toBe(b)
  })

  it('不同函数名得到不同指纹', () => {
    const a = computeFingerprint(jsEvent([{ filename: '/a/index.js', functionName: 'foo' }]))
    const b = computeFingerprint(jsEvent([{ filename: '/a/index.js', functionName: 'bar' }]))
    expect(a).not.toBe(b)
  })

  it('跳过 node_modules 帧，让应用代码主导指纹', () => {
    const withLib = computeFingerprint(
      jsEvent([
        { filename: '/a/node_modules/lodash/index.js', functionName: 'lodashFn' },
        { filename: '/a/src/app.ts', functionName: 'appFn' }
      ])
    )
    const appOnly = computeFingerprint(
      jsEvent([{ filename: '/a/src/app.ts', functionName: 'appFn' }])
    )
    expect(withLib).toBe(appOnly)
  })

  it('没有可用栈时退化成「错误名 + 归一化消息」', () => {
    const a = computeFingerprint({
      category: 'javascript',
      name: 'Error',
      message: '用户 12345 不存在',
      frames: []
    })
    const b = computeFingerprint({
      category: 'javascript',
      name: 'Error',
      message: '用户 67890 不存在',
      frames: []
    })
    expect(a).toBe(b)
  })

  it('HTTP 错误按「方法 + 路径 + 状态码」分组，忽略 query', () => {
    const a = computeFingerprint({
      category: 'http',
      message: '',
      frames: [],
      http: { method: 'GET', url: 'https://a.com/api/posts?page=1', status: 500 }
    })
    const b = computeFingerprint({
      category: 'http',
      message: '',
      frames: [],
      http: { method: 'GET', url: 'https://a.com/api/posts?page=99', status: 500 }
    })
    expect(a).toBe(b)
  })

  it('HTTP 不同状态码是不同指纹', () => {
    const a = computeFingerprint({
      category: 'http',
      message: '',
      frames: [],
      http: { method: 'GET', url: '/api/posts', status: 500 }
    })
    const b = computeFingerprint({
      category: 'http',
      message: '',
      frames: [],
      http: { method: 'GET', url: '/api/posts', status: 503 }
    })
    expect(a).not.toBe(b)
  })

  it('资源错误忽略 query（图片的 ?v=123 是缓存版本号）', () => {
    const a = computeFingerprint({
      category: 'resource',
      message: '',
      frames: [],
      resource: { tag: 'img', src: 'https://a.com/a.png?v=1', type: 'image' }
    })
    const b = computeFingerprint({
      category: 'resource',
      message: '',
      frames: [],
      resource: { tag: 'img', src: 'https://a.com/a.png?v=2', type: 'image' }
    })
    expect(a).toBe(b)
  })
})

describe('stripBuildHash', () => {
  it('剥掉 Vite 风格的 hash', () => {
    expect(stripBuildHash('index-DnB3xK2l.js')).toBe('index.js')
  })

  it('剥掉 webpack 风格的 hash', () => {
    expect(stripBuildHash('index.abc12345.js')).toBe('index.js')
  })

  it('不动正常文件名', () => {
    expect(stripBuildHash('vendor.chunk.js')).toBe('vendor.chunk.js')
    expect(stripBuildHash('main.js')).toBe('main.js')
  })
})

describe('normalizeMessage', () => {
  it('数字归一化', () => {
    expect(normalizeMessage('用户 12345 不存在')).toBe('用户 # 不存在')
  })

  it('UUID 归一化', () => {
    expect(normalizeMessage('order 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed')).toBe(
      'order <uuid> failed'
    )
  })
})

describe('pathOf', () => {
  it('去掉 origin 和 query', () => {
    expect(pathOf('https://a.com/api/posts?x=1')).toBe('/api/posts')
  })

  it('相对路径原样返回', () => {
    expect(pathOf('/api/posts')).toBe('/api/posts')
  })
})

describe('basename', () => {
  it('取最后一段', () => {
    expect(basename('https://a.com/assets/index.js')).toBe('index.js')
  })
})
