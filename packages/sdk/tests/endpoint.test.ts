import { describe, expect, it } from 'vitest'
import { resolveApiRoot, resolveChannelEndpoint } from '../src/endpoint'

/**
 * 采集接口地址解析的测试。
 *
 * 这里守的是一个**静默失败**的 bug：
 * 把通道路径直接拼在 endpoint 后面，会得到
 * `.../api/v1/collect/api/v1/behavior` —— 请求发出去了、服务端也收到了，
 * 只是路由不匹配，返回 404。SDK 侧一切正常，日志里连一条警告都没有。
 */

describe('resolveApiRoot', () => {
  it('去掉最后一段路径', () => {
    expect(resolveApiRoot('http://127.0.0.1:4318/api/v1/collect')).toBe(
      'http://127.0.0.1:4318/api/v1'
    )
  })

  it('末尾斜杠不影响结果', () => {
    expect(resolveApiRoot('http://127.0.0.1:4318/api/v1/collect/')).toBe(
      'http://127.0.0.1:4318/api/v1'
    )
  })

  it('相对地址保持相对（不能给相对地址安一个假 origin）', () => {
    expect(resolveApiRoot('/api/v1/collect')).toBe('/api/v1')
  })

  it('带路径前缀的部署不会丢前缀', () => {
    expect(resolveApiRoot('https://example.com/vigil/api/v1/collect')).toBe(
      'https://example.com/vigil/api/v1'
    )
  })

  it('只有一个路径段时整段当根', () => {
    expect(resolveApiRoot('http://example.com/ingest')).toBe('http://example.com')
  })
})

describe('resolveChannelEndpoint', () => {
  it('行为通道挂在 API 根下面', () => {
    expect(resolveChannelEndpoint('http://127.0.0.1:4318/api/v1/collect', 'behavior')).toBe(
      'http://127.0.0.1:4318/api/v1/behavior'
    )
  })

  it('性能通道挂在 API 根下面', () => {
    expect(resolveChannelEndpoint('http://127.0.0.1:4318/api/v1/collect', 'performance')).toBe(
      'http://127.0.0.1:4318/api/v1/performance'
    )
  })

  it('拼出来的地址里不能再有 collect —— 那是路由不匹配的根源', () => {
    const behavior = resolveChannelEndpoint('http://127.0.0.1:4318/api/v1/collect', 'behavior')
    expect(behavior).not.toContain('/collect')
  })
})
