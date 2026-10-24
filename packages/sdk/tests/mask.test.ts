import { describe, expect, it } from 'vitest'
import { isSensitiveKey, maskRecord, maskUrl, scrubText } from '../src/mask'

describe('isSensitiveKey', () => {
  it('识别常见敏感键', () => {
    expect(isSensitiveKey('token')).toBe(true)
    expect(isSensitiveKey('password')).toBe(true)
    expect(isSensitiveKey('Authorization')).toBe(true)
    expect(isSensitiveKey('userPassword')).toBe(true)
    expect(isSensitiveKey('access_token')).toBe(true)
    expect(isSensitiveKey('phone')).toBe(true)
  })

  it('不误伤包含敏感词的正常字段', () => {
    // 子串匹配会把这些全干掉 —— 词段匹配才不会
    expect(isSensitiveKey('monkey')).toBe(false)
    expect(isSensitiveKey('statusCode')).toBe(false)
    expect(isSensitiveKey('errorCode')).toBe(false)
    expect(isSensitiveKey('zipcode')).toBe(false)
    expect(isSensitiveKey('keyboard')).toBe(false)
  })

  it('整键是 code 时算敏感（OAuth code），但 statusCode 不算', () => {
    expect(isSensitiveKey('code')).toBe(true)
    expect(isSensitiveKey('statusCode')).toBe(false)
  })
})

describe('maskUrl', () => {
  it('脱敏 query 里的敏感参数', () => {
    expect(maskUrl('/api/users?token=abc123&page=2')).toBe('/api/users?token=***&page=2')
  })

  it('保留相对路径原样（不能用 new URL，否则会拼出主机名）', () => {
    expect(maskUrl('/api/x?password=1')).toBe('/api/x?password=***')
  })

  it('没有 query 时原样返回', () => {
    expect(maskUrl('/api/x')).toBe('/api/x')
  })

  it('保留 hash', () => {
    expect(maskUrl('/api/x?token=1#section')).toBe('/api/x?token=***#section')
  })
})

describe('scrubText', () => {
  it('脱敏 JSON 里的敏感值', () => {
    expect(scrubText('{"token":"abc"}')).toBe('{"token":"***"}')
  })

  it('脱敏 key=value 形式', () => {
    expect(scrubText('password=hunter2')).toBe('password=***')
  })

  it('不碰无害的赋值', () => {
    expect(scrubText('statusCode=500')).toBe('statusCode=500')
  })

  it('脱敏 Bearer 凭证', () => {
    expect(scrubText('Authorization: Bearer eyJhbGciOi.J9.abc')).toBe('Authorization: Bearer ***')
  })
})

describe('maskRecord', () => {
  it('递归脱敏嵌套对象', () => {
    const masked = maskRecord({
      user: { name: '张三', password: 'x' },
      token: 'abc'
    })
    expect(masked.token).toBe('***')
    expect((masked.user as Record<string, unknown>).password).toBe('***')
    expect((masked.user as Record<string, unknown>).name).toBe('张三')
  })

  it('超过最大深度时截断，不无限递归', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } }
    const masked = maskRecord(deep)
    expect(JSON.stringify(masked)).toContain('truncated')
  })
})
