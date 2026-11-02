# @vigil/sdk

Vigil 浏览器端采集 SDK：错误监控、性能 RUM、会话回放、用户行为。

零框架依赖，TypeScript 类型完整，三个入口按需引入 —— 核心 43KB（gzip 约 13KB），
回放是**独立入口**，不引就不打包。

## 安装

```bash
npm install @vigil/sdk
```

## 快速开始

```ts
import { init } from '@vigil/sdk'

init({
  appId: 'your-app-slug',
  token: 'vsk_xxx',
  endpoint: 'https://vigil.example.com/api/v1/collect'
})
```

`init` 之后自动采集：未捕获异常、`unhandledrejection`、资源加载失败、接口错误、
Web Vitals（LCP / CLS / INP / TTFB）。

## 三个入口

| 入口 | 内容 | 体积 |
|---|---|---|
| `@vigil/sdk` | 错误 + 性能 + 行为 | 43KB（gzip 13KB） |
| `@vigil/sdk/vue` | Vue 3 适配器 | 2.7KB |
| `@vigil/sdk/replay` | 会话回放（rrweb） | 279KB（gzip 75KB） |

## 会话回放（独立入口）

```ts
import { initReplay } from '@vigil/sdk/replay'

initReplay({ appId: 'your-app-slug', token: 'vsk_xxx' })
```

回放**不记录任何输入内容**（密码、输入框内容都会被屏蔽）。

## 隐私与安全

- 采集端脱敏：URL 里的 token、密码类查询参数在**上报前**就被替换
- sourcemap 不进 SDK，也不进静态资源目录 —— 只在服务端还原
- 行为事件不记录输入内容

## 文档

完整说明见仓库：https://github.com/Liao-wenxuan/vigil

## License

MIT
