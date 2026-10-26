# AGENTS.md

> 面向 AI 编码代理与新同事的项目约定。改代码前先读这一份。

## 项目是什么

**Vigil** —— 多应用可接入的前端可观测性平台。

浏览器 SDK 采集 → 采集服务接收 → **Issue 聚合与生命周期** → 性能 RUM → 告警 → 管理面板。

| 域 | 覆盖 |
|---|---|
| 错误 | JS 运行时错误、Promise 拒绝、资源加载失败、接口错误、Vue 组件错误、白屏 |
| 性能 | Web Vitals（FCP/LCP/CLS/INP/TTFB）、长任务/TBT、接口 span、路由事务 |
| 关联 | 报错事件带上**当刻的性能快照**；性能页能反查「哪些错误拖慢了页面」 |

**性能 RUM 和错误监控是一体的**，不是两个独立功能 —— 很多「页面卡」的根因是没捕获的异常或资源重试风暴。

## 仓库位置

```
D:\my\vigil
```

## 常用命令

```bash
npm install
npm run demo                # 一键演示：种子数据 + 采集服务(:4318) + 面板(:5174)
npm run dev:collector       # 采集服务
npm run dev:dashboard       # 管理面板
npm run seed:demo -- --reset # 重置演示数据
npm run typecheck           # tsc --noEmit，所有包
npm run lint                # eslint（含 .vue）
npm run test                # vitest，125 条
npm run verify              # 端到端闭环，20 条断言（会先构建 SDK）
npm run verify:dashboard    # 面板渲染验证（需要面板已启动）
npm run build               # 构建 SDK / Collector / Dashboard

# 管理 CLI（组织 / 项目 / 环境 / 版本）
npm --prefix packages/collector run cli -- org create "我的组织"
npm --prefix packages/collector run cli -- project create 1 "我的应用"
npm --prefix packages/collector run cli -- env add 1 production "生产环境" --production
npm --prefix packages/collector run cli -- release add 1 1.4.2
```

**验证一律用数字，不看截图。**

## 包结构

| 包 | 说明 | 关键约束 |
|---|---|---|
| `packages/protocol` | 上报协议类型契约 | **纯类型，零运行时**。只有 `import type` 能从它导入 |
| `packages/sdk` | 浏览器采集 SDK | 无框架依赖。Vue 适配器单独入口 `src/vue.ts` |
| `packages/collector` | 采集服务（**模块化单体**） | Fastify + SQLite。ESM/NodeNext，相对导入**必须带 `.js` 后缀** |
| `packages/dashboard` | 管理面板 | Vue 3 + Element Plus + vue-router。管理 token 由 Vite 代理层注入，**不进前端代码** |

### 面板结构

```
packages/dashboard/src/
  router/index.ts        6 条路由
  layouts/AppLayout.vue  固定侧栏（项目选择器 + 6 导航项 + 底部 slug）+ 顶栏
  api/client.ts          类型化 API 客户端（ApiError 统一错误）
  views/                 Overview / Issues / IssueDetail / Performance / Alerts / Settings
  components/            StatCard / StatusTag / PanelSection / BarList(SVG) / PercentileChart(SVG)
  theme.css              设计 token（**不要改**，所有页面复用它）
```

图表是**手写 SVG**，没有引图表库 —— 趋势图和分位数区间条两个组件就够。

### Collector 的域分层

```
src/
  app.ts              Fastify 装配（全部路由）
  index.ts            启动入口 + 告警评估循环
  cli.ts              管理命令行
  infra/
    db/               client（Db 抽象）/ schema（DDL）/ migrate / dialect（方言层）
    ratelimit.ts      令牌桶
  domains/
    tenancy/          组织/团队/成员/项目/环境/版本/密钥
    issues/           state-machine（纯函数）+ service
    performance/      事务/span/分位数
    alerting/         service（规则/通道）+ evaluator（评估）+ channels（发送）
    artifacts/        版本/sourcemap/还原
    ingestion/        pipeline（摄入管道）
  shared/             errors / time / url
```

**为什么是模块化单体而不是微服务**：三个域紧耦合（告警要读问题状态，性能要关联错误上下文）。拆成进程就要处理跨进程查询、事务边界、最终一致性 —— 复杂度换来的收益在这个量级用不上。域的边界已经是现成的切缝，以后要拆随时能拆。

---

## 不能破坏的不变量

这几条一旦破坏，系统的核心价值就没了。

### 1. 指纹：用 category 不用 kind

`ErrorKind`（js/promise/vue/manual）只说明「谁抓到的」。
`ErrorCategory`（javascript/resource/http）才是分组维度。
Vue 捕获和全局捕获到同一个错误，必须是**同一条**。

### 2. 指纹不含行号列号，也不含构建 hash

改一行代码不该让错误的「历史」断掉；每次发版也不该让所有错误都变成新的。
`stripBuildHash` 把 `index-DnB3xK2l.js` 归一成 `index.js`。

### 3. Issue 状态机是唯一的状态来源

`domains/issues/state-machine.ts` 是**纯函数**（状态 + 事件 → 新状态 + 变更 + 活动流）。

- 不要在服务层另写 if 判断状态流转
- 每次流转产生什么活动流，是函数的一部分，不靠调用方记得写

### 4. Resolve with Release —— 本项目最核心的机制

在 `1.4.3` 上把问题标为已解决 → `1.4.3` 及更早版本再报都算**噪音**，
只有 `1.4.4+` 出现才算**回归**。

版本比较必须**按语义**（`isNewerVersion`）——
字符串比较下 `'1.4.10' < '1.4.3'`，那样回归就判不出来了。

### 5. 聚合靠数据库 UNIQUE 约束

`UNIQUE (app_id, fingerprint)` + UPSERT。应用层「先查再插」在并发下必然出重复行。

### 6. 指纹要校验，缺失时服务端兜底

指纹是聚合主键。照单全收客户端的值，一个**空串**就能让该应用的所有错误塌成一行。
`ingest.ts` 里 `isValidFingerprint` 校验 16 位十六进制，不合法走 `fallbackFingerprint`。

**测试夹具必须用合法格式**（`tests/helpers.ts` 的 `fp(label)`）——
用 `fp_1` 这种假格式会静默走兜底路径，测的就不是客户端指纹了。

### 7. 两把密钥严格分离

| 密钥 | 用途 | 放在哪 |
|---|---|---|
| runtime (`vsk_`) | 上报错误与性能 | 前端代码里 |
| upload (`vup_`) | 上传 sourcemap | **只在 CI 里** |

拿 runtime 密钥只能刷错误数据；拿 upload 密钥能污染别人项目的错误栈。
数据库里**只存哈希**，明文只在创建时返回一次。

### 8. sourcemap 不进静态资源目录

浏览器能下载到的文件，攻击者也能下载到 —— sourcemap 等于公开源码。
map 只上传到 Collector，服务端还原后只把「原始位置」写进数据库。

**列号 1-based vs 0-based**：JS 栈是 1-based，sourcemap 是 0-based。
`sourcemap.ts` 里显式 `- 1` / `+ 1`，差一位不报错只是位置偏。

### 9. 脱敏在采集端做

敏感键按**词段**匹配而非子串：`userPassword` 命中，`monkey` / `statusCode` 不命中。

`mask.ts` 里多条正则的**顺序有讲究**：
`JSON_ASSIGN → AUTH → CREDENTIAL → ASSIGN`。
调换顺序会静默错掩（`Authorization: *** ***` —— 凭证反而留在后面）。
改这个文件前先读 `packages/sdk/tests/mask.test.ts`，那里有锁住行为的用例。

### 10. SDK 必须出两个产物

`dist/index.js`（ESM）+ `dist/index.iife.js`（IIFE）。

`<script type="module">` 默认 defer，ESM 接入会**漏掉首屏静态资源的失败**。
IIFE 放 `<head>` 同步初始化才能收到。

⚠️ 两次 vite 构建时**只有第一个能 `emptyOutDir: true`**，
否则第二个会把第一个的产物删掉（症状：构建成功但 `dist/index.js` 不存在）。

### 11. 上报请求自身不能被当成错误

`collectors/network.ts` 的 `isCollectorUrl` 必须排除采集端点，
否则上报 → 触发拦截 → 再上报，无限循环。

### 12. 错误与性能走**两条独立通道**

| | 错误 | 性能 |
|---|---|---|
| 端点 | `/api/v1/collect` | `/api/v1/performance` |
| 采样 | 全量（`sampleRate` 默认 1） | 采样（`performanceSampleRate` 默认 0.1） |
| 聚合 | 按指纹聚成 Issue | 按时间桶算分位数 |

性能数据量大且绝大多数正常，混在一起就没法「错误全量、性能采样」。

---

## 数据层

### 方言层

本机 Docker 跑不起来（缺 WSL2），也没装 PostgreSQL —— 只能用 SQLite。
但 schema 用 `infra/db/dialect.ts` 生成，两边都跑得起来，**领域代码一行不用改**。

| 逻辑类型 | SQLite | PostgreSQL | 备注 |
|---|---|---|---|
| 自增主键 | INTEGER PRIMARY KEY | SERIAL PRIMARY KEY | |
| 时间戳 | INTEGER | BIGINT | 统一 epoch 毫秒 |
| 布尔 | INTEGER | INTEGER | ⚠️ PG 的 BOOLEAN 不接受整数，用 CHECK 补约束 |
| JSON | TEXT | JSONB | 读写一律走 `readJson` / `writeJson` |

### 迁移

`infra/db/migrate.ts` 是版本化迁移，**已发布的迁移不能改**（线上已经应用了）。
要改就加一个新版本。v1→v2 的迁移会把老的 `apps` 表搬进新的
组织/项目模型，**老 token 的哈希直接搬过去**，用户已有的上报密钥不会失效。

#### ⚠️ 同名表必须先腾出表名

v1 和 v2 **都有** `sourcemaps` 表，但列结构不同
（v1 是 `app_id` + `release` 字符串，v2 是 `project_id` + `release_id` 外键）。

而建表语句是 `CREATE TABLE IF NOT EXISTS sourcemaps (...)` ——
表名已存在时它**什么都不做**，于是 v2 的列根本不存在。

症状特别阴：全新库没有老表，一切正常；**只有带历史数据的库会挂**，
表现是任何上报在查 sourcemaps 时抛错，整个摄入链路 500。
本地全绿、升级的生产环境直接挂。

修法：`renameLegacyTables()` 在建 v2 表**之前**把老表改名，
把表名腾出来。`tests/migrate.test.ts` 里有 7 条回归测试盯着这件事。

**教训：迁移里 DROP 或 CREATE 同名表之前，先确认 v2 那一侧的列结构。**

---

## 验证

```bash
npm run test              # 132 条
npm run verify            # 20 条端到端断言
npm run verify:dashboard  # 33 条面板渲染断言
```

`npm run verify` 跑的是**真实链路**：真 Chromium → 真 SDK 产物 → 真 HTTP →
真 Collector → 真 SQLite → 真查询 API。

`npm run verify:dashboard` 自带播种逻辑（自建专属演示项目 + 注入 localStorage），
所以断言**可重复**，不依赖库里已有什么数据。

### 写断言的三个坑（都踩过）

1. **Element Plus 把所有下拉的 popper 都挂在 body 上** —— 数选项必须限定
   `.el-select__popper:visible`，否则会把别的下拉的选项一起数进去。
2. **资源错误本来就没有栈** —— 对它断言「有原始栈」是在断言不存在的事。
   断言要落在**有栈的那一行**上。
3. **E2E 跳页前要等特定事件落库**，不能只等「凑够 N 条」——
   页面里的错误常由 `setTimeout` 触发，跳太快会误判成产品问题。

---

## 部署

```bash
docker compose up --build    # 面板 :8080，接口 :4318
```

- `Dockerfile` 多阶段，两个 target（collector / dashboard）
- `deploy/k8s/` 有 namespace / deployment / service / ingress / HPA / PDB
- ⚠️ **本机 Docker 跑不起来，镜像没有实跑验证过**（缺 WSL2）
- ⚠️ **多副本前必须换 PostgreSQL** —— SQLite 是单文件，两个进程写同一个文件会锁竞争

---

## 端口

| 端口 | 用途 |
|---|---|
| 4318 | Vigil 采集服务 |
| 5174 | Vigil 管理面板 |
| 5173 | **content-sharing-platform 的前端**（别动） |

面板 `vite.config.ts` 用了 `strictPort: true` —— 端口被占用时直接报错，
而不是像 Vite 默认那样静默递增到 5175。

## 提交约定

- conventional commits，`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `ci`
- **每个 commit 一个原子改动**，docs 单独提交
- subject ≤ 50 字
- pre-commit 会跑 lint-staged（eslint --fix + prettier --write）
