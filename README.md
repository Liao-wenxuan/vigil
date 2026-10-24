# Vigil · 前端错误监控平台

多应用可接入的前端错误监控系统：**浏览器 SDK + 采集服务 + 管理面板**。

- 采集：JS 运行时错误、Promise 拒绝、资源加载失败、接口错误、Vue 组件错误
- 聚合：按**指纹**（fingerprint）归并同类错误，看的是「有多少次」而不是「有多少条」
- 还原：生产环境的压缩栈通过 sourcemap **还原回源码位置**
- 隐私：URL / 消息 / 栈在**采集端**就脱敏，token、手机号不会进数据库

---

## 架构

```
┌──────────────┐   fetch / sendBeacon   ┌─────────────────┐
│   浏览器页面  │ ──────────────────────▶ │  Vigil Collector │
│  @vigil/sdk   │                         │   Fastify + SQLite│
└──────────────┘                         └────────┬────────┘
        │                                          │
        │  上报：appId + token                     │  聚合 / 指纹
        ▼                                          ▼
   独立 token  ──────────────▶  ┌──────────────────────────┐
   （运行时）                     │  errors      聚合结果      │
                                │  error_events 原始明细     │
                                │  sourcemaps  栈还原索引    │
                                └──────────────────────────┘

   独立 token  ──────────────▶  ↑ uploadToken 只在 CI 里
   （上传）                      map 存服务端，不进静态资源目录
```

**三个包**：

| 包 | 作用 | 依赖 |
|---|---|---|
| `@vigil/protocol` | 上报协议的类型契约（纯类型，零运行时） | 无 |
| `@vigil/sdk` | 浏览器端采集 SDK | 无框架依赖 |
| `@vigil/collector` | 采集服务 + 管理 API | Fastify、better-sqlite3 |

---

## 快速开始

```bash
npm install

# 1. 启动采集服务
npm run dev:collector
# → http://0.0.0.0:4318

# 2. 注册一个应用（拿到 appId / token / uploadToken）
npm --prefix packages/collector run app:create -- create "我的应用"

# 3. 接入 SDK（详见 docs/integration.md）
```

---

## 接入 SDK（30 秒版）

```html
<head>
  <!-- ⚠️ 放在 <head> 里同步加载：ESM 的 module script 是 defer 的，
       初始化会晚于首屏静态资源的加载失败 -->
  <script src="https://cdn.example.com/vigil.iife.js"></script>
  <script>
    Vigil.init({
      endpoint: 'https://collector.example.com/api/v1/collect',
      appId: 'app_xxx',
      token: 'vsk_xxx',
      release: '1.0.0',
      environment: 'production'
    })
  </script>
</head>
```

用 bundler 的话走 ESM：

```ts
import { init } from '@vigil/sdk'
init({ endpoint, appId, token, release })
```

Vue 项目额外接一下组件错误：

```ts
import { installVueErrorHandler } from '@vigil/sdk/vue'
installVueErrorHandler(app, (err) => vigil.captureException(err))
```

---

## 验证

**全部用数字验证，不看截图。**

```bash
npm run test      # 105 条单元测试
npm run verify    # 14 条端到端断言（真 Chromium → 真 HTTP → 真 SQLite）
npm run typecheck
npm run lint
```

`npm run verify` 跑的是**真实链路**：真 Chromium 打开页面 → 真的抛错 → 真 SDK 产物上报 → 真 Collector 接收 → 真 SQLite 落库 → 真管理 API 查出来。断言覆盖：

- 五类错误源全部采到
- 同一错误报两次聚合成一条（`count = 2`）
- 压缩产物的栈还原回源码（`app.min.js:1:20` → `src/user-profile.ts:1`）
- URL 里的 token 被脱敏（`token=***`）
- 上报请求自身不被当成错误（无递归）

---

## 关键设计决策

### 指纹：用 category 不用 kind

`ErrorKind`（js / promise / vue / manual）只说明「谁抓到的」，
`ErrorCategory`（javascript / resource / http）才是分组维度。
Vue 捕获和全局捕获到同一个错误，应该是**同一条**。

### 指纹不含行号列号

改一行代码不该让这条错误的「历史」断掉。指纹里放行号的话，
每次发版都会产生一批「新错误」，后台的已解决/未解决状态全部失效。

同理**剥掉构建 hash**（`index-DnB3xK2l.js` → `index.js`），
否则指纹跟构建产物绑定，等于每发一次版所有错误都变成新的。

### 上报：两条通道，token 位置不同

| 通道 | 何时用 | token 放哪 | 限制 |
|---|---|---|---|
| `fetch` | 正常 | **header**（不进 body，不进访问日志） | keepalive body ≤ 64KB |
| `sendBeacon` | 页面卸载 | **body**（beacon 不能自定义 header） | payload ≤ 64KB |

单批上限取 48KB，留信封开销余量。超限会被浏览器**静默丢弃** ——
不报错、不重试，所以宁可多发几个小请求。

### 聚合：靠数据库唯一约束

```sql
UNIQUE (app_id, fingerprint)
```

UPSERT 一行 SQL 搞定。应用层「先查再插」在并发下必然出重复行。

### 限流：按 appId 而不是 IP

上报请求来自**用户的浏览器**，IP 是用户的不是应用的。
按 IP 限流会误伤同一出口 IP 后的所有用户；
按 appId 才能精确隔离「谁把服务打满了」。

### 栈还原：map 存服务端

浏览器能下载到的文件，攻击者也能下载到 —— sourcemap 等于公开源码。
map 只上传到 Collector，服务端还原后只把「原始位置」写进数据库。

### 脱敏：在采集端做

监控系统会原样收集用户页面上的东西。采集端不脱敏，
就等于把用户隐私复制进了一份新的数据库。

敏感键按**词段**匹配而不是子串 —— 否则 `monkey` 会被 `key` 命中、
`statusCode` 会被 `code` 命中。

---

## 目录结构

```
packages/
  protocol/    上报协议类型契约（纯类型）
  sdk/         浏览器采集 SDK
    src/
      collectors/   global / promise / network / breadcrumbs
      fingerprint.ts  指纹计算
      mask.ts         脱敏
      parse-stack.ts  栈解析
      transport.ts    批量 + 双通道上报
      queue.ts        队列
  collector/   采集服务
    src/
      app.ts        Fastify 路由
      ingest.ts     聚合落库
      sourcemap.ts  栈还原
      auth.ts       鉴权
      rate-limit.ts 令牌桶限流
scripts/
  verify-pipeline.ts    端到端闭环验证
  upload-sourcemaps.mjs CI 里上传 sourcemap
docs/
  integration.md   接入文档
  architecture.md  架构与取舍
```

---

## 管理 API

全部需要 `x-vigil-admin-token`（启动时打印，或用 `VIGIL_ADMIN_TOKEN` 指定）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/apps` | 创建应用，返回两个 token（只此一次可见） |
| `GET` | `/api/v1/apps` | 应用列表 |
| `PATCH` | `/api/v1/apps/:appId` | 启用/停用 |
| `GET` | `/api/v1/apps/:appId/errors` | 错误列表 |
| `GET` | `/api/v1/apps/:appId/errors/:fingerprint` | 错误详情 + 最近事件 |
| `GET` | `/api/v1/apps/:appId/stats` | 统计：分类分布、Top 错误、Top 接口 |

---

## 状态

已完成：

- [x] L1 错误监控全链路（SDK → Collector → 聚合 → 还原 → 查询）
- [x] 多应用隔离 + 双 token 分离（运行时 / 上传）
- [x] 采集端脱敏
- [x] 令牌桶限流
- [x] 105 条单元测试 + 14 条端到端断言

待做：

- [ ] 管理面板（Vue 3 + Element Plus）
- [ ] npm 发布（`@vigil/sdk`）
- [ ] L2 性能 RUM（Web Vitals）
- [ ] 告警规则与 webhook
