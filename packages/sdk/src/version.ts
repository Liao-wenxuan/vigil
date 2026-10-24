/**
 * SDK 版本号。
 *
 * 这里写死一个字符串，而不是从 package.json 读 —— SDK 要打成单文件浏览器产物，
 * 不能在运行时读 package.json。
 *
 * 代价是可能和 package.json 漂移，所以 tests/version.test.ts 会断言两者一致。
 * 漂了就是那条测试红，不会静默发出去一个版本号对不上的 SDK。
 */
export const SDK_NAME = '@vigil/sdk'
export const SDK_VERSION = '0.1.0'
