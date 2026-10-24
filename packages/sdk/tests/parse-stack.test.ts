import { describe, expect, it } from 'vitest'
import { describeThrown, parseStack, safeStringify } from '../src/parse-stack'

describe('parseStack', () => {
  it('解析 Chrome / V8 格式', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      '    at fetchUser (https://app.example.com/assets/index-DnB3xK2l.js:42:17)',
      '    at https://app.example.com/assets/index-DnB3xK2l.js:100:5'
    ].join('\n')

    const frames = parseStack(stack)

    expect(frames).toHaveLength(2)
    expect(frames[0].functionName).toBe('fetchUser')
    expect(frames[0].filename).toBe('https://app.example.com/assets/index-DnB3xK2l.js')
    expect(frames[0].lineno).toBe(42)
    expect(frames[0].colno).toBe(17)
    expect(frames[1].functionName).toBeUndefined()
    expect(frames[1].lineno).toBe(100)
  })

  it('解析 Firefox / SpiderMonkey 格式', () => {
    const stack = [
      'fetchUser@https://app.example.com/index.js:42:17',
      '@https://app.example.com/index.js:100:5'
    ].join('\n')

    const frames = parseStack(stack)

    expect(frames).toHaveLength(2)
    expect(frames[0].functionName).toBe('fetchUser')
    expect(frames[0].lineno).toBe(42)
    expect(frames[0].colno).toBe(17)
  })

  it('带端口的 URL 不会被拆错', () => {
    const stack = '    at fn (http://localhost:3000/assets/a.js:12:3)'
    const frames = parseStack(stack)
    expect(frames[0].filename).toBe('http://localhost:3000/assets/a.js')
    expect(frames[0].lineno).toBe(12)
  })

  it('第一行是消息不是栈帧', () => {
    expect(parseStack('TypeError: boom')).toHaveLength(0)
  })

  it('空输入返回空数组', () => {
    expect(parseStack(undefined)).toEqual([])
    expect(parseStack('')).toEqual([])
  })
})

describe('describeThrown', () => {
  it('Error 对象', () => {
    const error = new TypeError('boom')
    const described = describeThrown(error)
    expect(described.name).toBe('TypeError')
    expect(described.message).toBe('boom')
    expect(described.stack).toBeTruthy()
  })

  it('字符串', () => {
    const described = describeThrown('直接抛的字符串')
    expect(described.message).toBe('直接抛的字符串')
    expect(described.name).toBeUndefined()
  })

  it('普通对象', () => {
    const described = describeThrown({ message: '对象消息', code: 500 })
    expect(described.message).toBe('对象消息')
  })

  it('null 和 undefined 不会抛异常', () => {
    expect(describeThrown(null).message).toBe('null')
    expect(describeThrown(undefined).message).toBe('undefined')
  })
})

describe('safeStringify', () => {
  it('循环引用不抛异常', () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    expect(safeStringify(obj)).toContain('Circular')
  })
})
