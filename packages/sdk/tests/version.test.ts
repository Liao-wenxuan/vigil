import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
import { SDK_NAME, SDK_VERSION } from '../src/version'

describe('版本号', () => {
  it('SDK_VERSION 与 package.json 一致', () => {
    // 漂了就是这条测试红 —— 不会静默发出去一个版本号对不上的 SDK
    expect(SDK_VERSION).toBe(pkg.version)
  })

  it('SDK_NAME 是发布包名', () => {
    expect(SDK_NAME).toBe('@vigil/sdk')
  })
})
