# @vigil/protocol

Vigil 的上报协议：SDK 与 Collector 共用的类型契约。

**纯类型，零运行时** —— 这个包里没有任何 JS，编译后不产生任何代码。
所以它对 SDK 的体积贡献是 0，却能保证两端说的���是同一套字段。

## 安装

```bash
npm install @vigil/protocol
```

## 用法

```ts
import type { ErrorEvent, PerformanceEvent, CollectEnvelope } from '@vigil/protocol'

const envelope: CollectEnvelope = {
  appId: 'your-app-slug',
  sdk: { name: 'vigil', version: '0.1.0' },
  events: [/* ErrorEvent[] */]
}
```

## 覆盖范围

| 文件 | 内容 |
|---|---|
| `error.ts` | 错误事件、资源错误、接口错误 |
| `performance.ts` | 性能事务、span、Web Vitals |
| `replay.ts` | 回放事件流 |
| `issue.ts` | Issue、状态、活动流 |
| `alerting.ts`（`tenancy.ts`） | 告警规则、通道、触发记录 |
| `trend.ts` | 时间范围与趋势 |
| `slo.ts` | SLO 与错误预算 |

## 为什么单独发一个包

协议是**线上契约** —— 改字段就是改契约。
单独成包 + 单独的版本号，改动会体现在依赖树里，
消费方升级时看得见。

## License

MIT
