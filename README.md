# Vigil · 前端可观测性平台

多应用可接入的前端监控：**浏览器 SDK + 采集服务 + 管理面板**。

不只是"错误日志"—— 错误、性能、行为三者在同一个 Issue 上打通，
能回答"这个错误是不是拖慢了这页"。

---

## 它解决什么

| 能力 | 说明 |
|---|---|
| **Issue 生命周期** | 错误不是一条记录，是**一个工单**：有状态、负责人、评论、活动历史 |
| **Resolve with Release** | 在 `1.4.3` 上解决的问题，只有 `1.4.4+` 出现才算**回归** |
| **性能 RUM** | Web Vitals（LCP/CLS/INP/TTFB）、长任务/TBT、接口 span、路由事务 |
| **错误与性能关联** | 报错事件带上**当刻的 LCP/FCP/长任务数** |
| **告警引擎** | 6 类规则 × 5 种通道，带去重静默（避免告警疲劳） |
| **多租户** | 组织 → 团队 → 项目 → 环境 / 版本，三层隔离 |
| **安全** | 双密钥分离、采集端脱敏、sourcemap 不出服务端 |

---

## 架构

```
┌──────────────┐   /collect（错误·全量）    ┌──────────────────────┐
│              │ ─────────────────────────▶ │                      │
│   浏览器页面  │   /performance（性能·采样）  │   Vigil Collector    │
│  @vigil/sdk  │ ─────────────────────────▶ │  Fastify + SQLite    │
│              │   /sourcemaps（仅 CI）      │  模块化单体           │
└──────────────┘ ─────────────────────────▶ └──────────┬───────────┘
                                                        │
                              ┌─────────────────────────┼──────────────────────┐
                              ▼                         ▼                      ▼
                      ┌───────────────┐         ┌──────────────┐      ┌─────────────┐
                      │  问题域        │         │  性能域       │      │  告警域      │
                      │  Issue 状态机  │         │  事务/span    │      │  规则/通道   │
                      │  活动流/回归   │         │  分位数聚合    │      │  评估/去重   │
                      └───────────────┘         └──────────────┘      └─────────────┘
                              │                         │                      │
                              └─────────────────────────┴──────────────────────┘
                                                        │
                                              ┌──────────────────────┐
                                              │   Vigil Dashboard     │
                                              │  Vue3 + Element Plus  │
                                              └──────────────────────┘
```

**四个包**：

| 包 | 作用 | 依赖 |
|---|---|---|
| `@vigil/protocol` | 上报协议的类型契约（纯类型，零运行时） | 无 |
| `@vigil/sdk` | 浏览器采集 SDK（ESM + IIFE 两个产物） | 无框架依赖 |
| `@vigil/collector` | 采集服务 + 管理 API | Fastify、better-sqlite3 |
| `@vigil/dashboard` | 管理面板 | Vue 3、Element Plus、vue-router |

---

## 快速开始

```bash
npm install
npm run demo
# → 面板  http://localhost:5174
# → 接口  http://localhost:4318
```

分开起：

```bash
npm run dev:collector       # 采集服务，:4318
npm run dev:dashboard       # 管理面板，:5174
npm run seed:demo -- --reset # 重置演示数据
```

建组织 / 项目 / 环境 / 版本：

```bash
npm --prefix packages/collector run cli -- org create "我的组织"
npm --prefix packages/collector run cli -- project create 1 "我的应用"
npm --prefix packages/collector run cli -- env add 1 production "生产环境" --production
npm --prefix packages/collector run cli -- release add 1 1.4.2
```

---

## 接入 SDK

```html
<head>
  <!-- ⚠️ 放 <head> 同步加载：ESM 的 module script 是 defer 的，
       初始化会晚于首屏静态资源的加载失败（那样一条都收不到） -->
  <script src="https://cdn.example.com/vigil.iife.js"></script>
  <script>
    Vigil.init({
      endpoint: 'https://collector.example.com/api/v1/collect',
      appId: 'shop-miniapp',
      token: 'vsk_xxx',
      release: '1.4.2',
      environment: 'production',
      userId: 'u_123',
      performanceSampleRate: 0.1
    })
  </script>
</head>
```

bundler 项目走 ESM：

```ts
import { init } from '@vigil/sdk'
const vigil = init({ endpoint, appId, token, release })

// SPA 路由切换时上报一个路由事务
vigil.startRoute('/orders')
```

Vue 项目接组件错误：

```ts
import { installVueErrorHandler } from '@vigil/sdk/vue'
installVueErrorHandler(app, (err) => vigil.captureException(err))
```

详见 [`docs/integration.md`](docs/integration.md)。

---

## Issue 生命周期

这是本项目和"错误日志"最大的区别。

```
                        ┌──────────────────────────┐
                        │                          │
   [新事件] ──▶ unresolved(new)                 │
                        │                          │
                  7 天无新事件 / 人工已阅           │
                        ▼                          │
                 unresolved(ongoing)              │
                        │                          │
        ┌───────────────┼───────────────┐          │
        ▼               ▼               ▼          │
   resolved        archived    (escalating) ────────┘
        │               │
        │          事件量超基线
        │               ▼
        │          escalating ──▶ unresolved(ongoing)
        │
   新事件且 release > 解决它的 release
        │
        ▼
   regressed ──(7 天)──▶ unresolved(ongoing)
```

**Resolve with Release** 是精华：在 `1.4.3` 标为已解决后，
`1.4.3` 及更早版本再报都算噪音，只有 `1.4.4+` 出现才算回归。
这直接回答"这个 bug 是不是我上次的修复引入的"。

每一次状态变化都写**活动流**，记录 actor（人 or SYSTEM）和原因 ——
系统改自己的主意时也留痕。

---

## 验证

**全部用数字验证，不看截图。**

```bash
npm run test              # 125 条单元测试
npm run verify            # 20 条端到端断言（真 Chromium → 真 HTTP → 真 SQLite）
npm run verify:dashboard  # 面板渲染断言
npm run typecheck
npm run lint
```

`npm run verify` 跑的是**真实链路**，断言覆盖：

```
✓ 五类错误都落库了 — 去重后 5 条 / 累计 6 次
✓ 同一个错误报两次聚合成一条 — count=2
✓ 标记已解决 → 状态 resolved 且记录了版本 — resolvedInRelease=1.0.0
✓ 在更新版本重新出现 → 判为回归 — substatus=regressed
✓ 在同版本重新出现 → 保持 resolved（是噪音不是回归）
✓ 活动流记录状态变化 — created → resolved → regressed
✓ 压缩产物的栈被 sourcemap 还原 — app.min.js:1:20 → src/user-profile.ts:1
✓ URL 里的 token 被脱敏 — token=***
✓ 上报请求自身没被当成错误（无递归）— 0 条
✓ 性能事务入库且分位数可查 — LCP P95=2100ms
✓ 错误事件带上了性能快照 — 6 条事件带 vitals
✓ 告警规则能触发并落库 / 去重生效
✓ 页面卸载后事件仍能送达（beacon 通道）
```

---

## 关键设计决策

### 指纹：用 category 不用 kind

`ErrorKind`（js/promise/vue/manual）只说明"谁抓到的"；
`ErrorCategory`（javascript/resource/http）才是分组维度。
Vue 捕获和全局捕获到同一个错误，必须是**同一条**。

### 指纹不含行号列号，也不含构建 hash

改一行代码不该让错误的"历史"断掉；每次发版也不该让所有错误都变成新的。

### 指纹要校验，缺失时服务端兜底

指纹是聚合主键。照单全收客户端的值，一个**空串**就能让该应用的所有错误
塌成一行 —— 表面上有数据，实际全是同一条错误。

### 聚合靠数据库 UNIQUE 约束

`UNIQUE (app_id, fingerprint)` + UPSERT。应用层"先查再插"在并发下必然出重复行。

### 限流按项目，不按 IP

上报请求来自**用户的浏览器**，IP 是用户的不是项目的。
按 IP 限流会误伤同一出口 IP 后的所有用户。

### 告警去重

同一个（规则, 问题, 时间窗）只发一次。告警疲劳是监控系统最大的敌人 ——
同一个错误每分钟报 100 次，没有人��去看。

### 两条上报通道

| | 错误 | 性能 |
|---|---|---|
| 端点 | `/api/v1/collect` | `/api/v1/performance` |
| 采样 | 全量 | 10% |

性能数据量大且绝大多数正常，混在一起就没法"错误全量、性能采样"。

### 双密钥分离

| 密钥 | 用途 | 放在哪 |
|---|---|---|
| `vsk_` | 上报 | 前端代码里 |
| `vup_` | 上传 sourcemap | **只在 CI 里** |

数据库只存哈希，明文只在创建时返回一次。

### 脱敏在采集端

监控系统会原样收集用户页面上的东西。采集端不脱敏，
等于把用户隐私复制进了一份新的数据库。
敏感键按**词段**匹配：`userPassword` 命中，`monkey` / `statusCode` 不命中。

### 模块化单体，不是微服务

三个域紧耦合（告警要读问题状态，性能要关联错误上下文）。
拆成进程就要处理跨进程查询、事务边界、最终一致性 ——
复杂度换来的收益在这个量级用不上。域的边界已经是现成的切缝。

### 数据层可换库

本机 Docker 跑不起来（缺 WSL2），只能用 SQLite。
但 schema 用方言层生成，PG 也能跑，**领域代码一行不用改**。

---

## 目录结构

```
packages/
  protocol/    上报协议类型契约（纯类型）
  sdk/         浏览器采集 SDK
    src/
      collectors/   global / promise / network / performance / breadcrumbs
      fingerprint.ts  指纹计算
      mask.ts         脱敏
      parse-stack.ts  栈解析
      transport.ts    批量 + 双通道上报
      queue.ts        队列
  collector/   采集服务（模块化单体）
    src/
      app.ts        Fastify 路由
      domains/      tenancy / issues / performance / alerting / artifacts / ingestion
      infra/        db（client·schema·migrate·dialect）/ ratelimit
  dashboard/   管理面板
scripts/
  verify-pipeline.ts    端到端闭环验证
  verify-dashboard.ts   面板渲染验证
  seed-demo.ts          演示数据种子
  upload-sourcemaps.mjs CI 里上传 sourcemap
deploy/
  nginx/        面板的 nginx 配置
  k8s/          namespace / deployment / service / ingress / hpa / pdb
docs/
  integration.md   接入文档
```

---

## 部署

```bash
docker compose up --build
# → 面板  http://localhost:8080
```

- `Dockerfile` 多阶段，两个 target（collector / dashboard）
- `deploy/k8s/` 含 namespace / deployment / service / ingress / HPA / PDB
- ⚠️ **容器实跑未验证**（本机 Docker 因缺 WSL2 起不来）
- ⚠️ **多副本前必须换 PostgreSQL** —— SQLite 是单文件，多进程写会锁竞争

---

## 状态

已完成：

- [x] L1 错误监控全链路（SDK → Collector → 聚合 → 还原 → 查询）
- [x] Issue 完整生命周期（状态机 + 活动流 + 回归检测）
- [x] 多租户模型（组织/团队/项目/环境/版本）+ 双密钥
- [x] 告警引擎（6 类规则 × 5 种通道 + 去重静默）
- [x] 性能 RUM（Web Vitals / 长任务 / span / 路由事务 / 分位数）
- [x] 错误与性能关联
- [x] 采集端脱敏
- [x] 管理面板（总览/问题/详情/性能/告警/设置）
- [x] Docker / K8s 部署形态
- [x] 125 条单元测试 + 20 条端到端断言 + 面板渲染断言

待做：

- [ ] npm 发布（`@vigil/sdk` / `@vigil/protocol`）
- [ ] 会话回放（rrweb）
- [ ] PostgreSQL 落地 + 真正的多副本
- [ ] 告警通道：邮件需要 `nodemailer`（已装，配置 SMTP 后可用）
