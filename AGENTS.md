# AGENTS.md

> 面向 AI 编码代理与新同事的项目约定。改代码前先读这一份。

## 项目是什么

**Vigil** —— 多应用可接入的前端可观测性平台。

浏览器 SDK 采集 → 采集服务接收 → **Issue 聚合与生命周期** → 性能 RUM → 告警 →
会话回放 / 用户行为 → 管理面板。

| 域 | 覆盖 |
|---|---|
| 错误 | JS 运行时错误、Promise 拒绝、资源加载失败、接口错误、Vue 组件错误、白屏 |
| 性能 | Web Vitals（FCP/LCP/CLS/INP/TTFB）、长任务/TBT、接口 span、路由事务 |
| 关联 | 报错事件带上**当刻的性能快照**；性能页能反查「哪些错误拖慢了页面」 |
| 回放 | rrweb 录制 → 事件流存储 → 面板逐事件回放，可拖动定位 |
| 行为 | 访问 / 路径 / 点击分布，**不记录任何输入内容** |

**性能 RUM 和错误监控是一体的**，不是两个独立功能 —— 很多「页面卡」的根因是没捕获的异常或资源重试风暴。
**回放和行为挂在同一个会话上** —— 能回答「用户出错前在干什么」。

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
npm run test                # vitest，221 条
npm run verify              # 端到端闭环，33 条断言（会先构建 SDK）
npm run verify:dashboard    # 面板渲染验证，50 条断言（需要面板已启动）
npm run audit:ui            # 界面设计闸门，15 条（需要面板已启动）
npm run audit:plans         # 查询计划闸门，1 条（检查所有热查询走索引）
npm run audit:ingest        # 摄入往返预算闸门，1 条（每条事件最多 4 次 DB 往返）
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
| `packages/sdk`（replay 入口） | 会话回放 + 用户行为 | **独立入口** `dist/replay.js`。核心不感知它的存在 |
| `packages/collector` | 采集服务（**模块化单体**） | Fastify + SQLite。ESM/NodeNext，相对导入**必须带 `.js` 后缀** |
| `packages/dashboard` | 管理面板 | Vue 3 + Element Plus + vue-router。管理 token 由 Vite 代理层注入，**不进前端代码** |

### 面板结构

```
packages/dashboard/src/
  router/index.ts        8 条路由
  layouts/AppLayout.vue  固定侧栏（项目选择器 + 8 导航项 + 底部 slug）+ 顶栏
  api/client.ts          类型化 API 客户端（ApiError 统一错误）
  views/                 Overview / Issues / IssueDetail / Performance /
                         Sessions（回放）/ Behavior（行为）/ Alerts / Settings
  components/            StatCard / StatusTag / PanelSection / BarList / PercentileChart
  theme.css              设计 token（**不要改**，所有页面复用它）
```

图表是**手写 HTML/CSS**，没有引图表库 —— 趋势图和分位数区间条两个组件就够。

⚠️ **不要改回 SVG。** 上一版是 SVG + `preserveAspectRatio` + `width: 100%`，
字号是 **viewBox 单位**，实际渲染 = 字号 × (面板宽 / 900) ——
同屏两个宽度不同的面板，同一个「12px」渲染出来就是两个大小。
`verify-dashboard.mjs` 里有「同屏图表的标签字号一致」这条回归防护盯着。

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
    replay/           会话回放 + 用户行为（回放/行为两个域共用一张 service）
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

### 13. 通道地址要**推导**，不能拼字符串

`endpoint` 是错误通道的完整地址（`.../api/v1/collect`）。
性能（`.../performance`）、行为（`.../behavior`）是它的**兄弟通道**。

`packages/sdk/src/endpoint.ts` 负责推导（去掉最后一段路径）。
**不要用字符串拼接** —— 拼出来是 `.../api/v1/collect/api/v1/behavior`，
404 而且**不报错**：请求发出去了、服务端也收到了，只是路由不匹配。
面板上看到的是「行为数据一条都没有」，SDK 侧一切正常，日志里连警告都没有。

插件的 `host.post(path)` 里 `path` 是**相对 API 根**的（如 `/behavior`）。

### 14. rrweb 事件编号不能猜

`@rrweb/types` 的 `EventType`：

| 编号 | 事件 | 说明 |
|---|---|---|
| 2 | FullSnapshot | **增量链的起点** |
| 3 | IncrementalSnapshot | 增量 |
| 4 | Meta | 原始视口尺寸 |

节点类型（`NodeType`）：0 = Document、2 = Element、3 = Text。

写错的后果**极其隐蔽**：播放器按编号分派，编号错了就**静默播不出来**，
不报任何错。种子数据、测试夹具、手写事件流都要按这个表来。

### 15. 增量链必须从全量快照开始

rrweb 的回放是「一个全量快照 + 一串增量」。中间丢掉任何一段，
后面的增量**全部对不上**，回放直接废掉。

客户端缓冲区满了**不能丢中间的**，只能重新取一次全量快照。
这条策略在 `packages/sdk/src/replay/buffer.ts`（**纯函数**）里，
`packages/sdk/tests/replay-buffer.test.ts` 盯着。

⚠️ 缓冲区重置时**要保留 Meta** —— 播放器靠它把内容按比例缩放，
丢了回放会被裁切。

### 16. 回放比行为汇总先到是常态

错误是立即上报的，行为汇总要等攒批或页面卸载。
所以**回放到达时会话行可能还不存在**。

只 UPDATE 的话这一行永远建不出来，结果是「回放事件躺在库里，
但会话列表里看不到它」。`domains/replay/service.ts` 的 `ensureSessionRow`
负责补建。

### 17. 回放是独立入口，不进核心

rrweb 压缩后 74KB gzip，打进 SDK 核心会让它膨胀 6 倍，
而绝大多数用户不需要回放（尤其涉及隐私合规的团队）。

- SDK 侧：独立入口 `@vigil/sdk/replay`（`dist/replay.js`）
- 面板侧：播放器**动态加载**（`import('rrweb-player')`），只有打开回放才拉

### 18. 行为不记录任何输入内容

只记「点了某个按钮」，不记「在搜索框里输入了 xxx」。
SDK 侧不采集输入值，rrweb 侧 `maskAllInputs` 全开，文本还会做 PII 脱敏。

**不要为了「功能更全」去采集输入内容。** 这条边界是设计出来的。

### 19. 累计口径和窗口口径不能混

面板顶栏有**全局时间范围**（1 小时 / 24 小时 / 7 天 / 30 天）。

给了时间范围，统计口径就从「问题表的累计快照」换成「窗口内实际发生过」：

| | 没有时间范围 | 有时间范围 |
|---|---|---|
| 去重错误 | issues 表的全部问题 | 窗口内有发生的问题 |
| 发生次数 | 累计次数（`count`） | 窗口内次数（`window_count`） |
| 待处理 | 全部未解决 | 窗口内有发生且仍未解决 |

- 排序也要跟着换口径（有窗口时按 `window_count` 排）
- 列表接口用 `window_count ?? count` 显示
- 状态分布用的是问题**当前**的状态 —— 「过去 1 小时还在冒且现在仍未解决」

### 20. 错误率的分母为 0 时是 null，不是 0

`错误率 = 错误发生次数 ÷ 页面访问次数`。分母为 0 说明「没访问过」，
和「真的没错」是两回事 —— 混成一个数就丢掉了信息。

### 21. 「按天」的桶边界要对齐本地午夜

`infra/db/dialect.ts` 的 `bucketExpr(column, bucketMs, tzOffsetMinutes)`。
偏移是「分钟，UTC 以东为正」（东八区 = 480）。

⚠️ **符号别搞反**：本地时间 = UTC + 偏移，所以本地第几天是 `(col + offset) / bucketMs`，
桶起点（换回 epoch）再减掉偏移。反了会把东八区算成西八区，桶边界整体错 8 小时。

分桶表达式的**桶起点**和合并时的 `bucketStart` 必须完全一致，
否则合并时一个都对不上。

### 22. SQL 必须**两种库都能跑**

领域代码统一写 `?` 占位符，**PG 适配器负责翻译成 `$1`**（`infra/db/postgres.ts`）。
所以查询语句里**不要**出现 PG 专有的 `$1` 写法。

SQLite 独有的写法一律不许出现在运行时 SQL 里：

| SQLite 独有 | 通用写法 |
|---|---|
| `last_insert_rowid()` | `INSERT ... RETURNING id`（用 `db.insert()`） |
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT (...) DO UPDATE` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `sqlite_master` | `information_schema.tables` |
| `pragma_table_info` | `information_schema.columns` |

**这不是约定，是测出来的**：`packages/collector/tests/postgres.test.ts`
用 PGlite（WASM 编译的**真 PostgreSQL**）跑完整领域链路。
本地没有 PG 也没有 Docker，但它让 CI 和本地都能真验一遍。

### 23. 时间戳列用 `BIGINT`

PG 的 `INTEGER` 是 **int4**，上限 2147483647 ——
epoch 毫秒（1.7e12）**直接溢出**。

schema 里所有时间列都要用 `ts(dialect)`（SQLite→INTEGER，PG→BIGINT），
别写死 `INTEGER`。`schema_migrations.applied_at` 就踩过这个坑。

### 24. 生产用 PostgreSQL：设 `DATABASE_URL`

`createAppFromEnv()` 按 `DATABASE_URL` 选库：
设了就用 PG，没设就退回 SQLite（单实例开发用）。

⚠️ 生产上**必须设** —— 不设的话多副本各写各的本地文件，数据就分裂了。

### 25. SQLite 预编译语句缓存：DDL 只能走 `exec()`

`SqliteDb` 缓存预编译语句（`db.prepare()` 每次都重新编译 SQL，
摄入热路径上这是纯浪费；缓存后 0.14 ms/条 → 0.031 ms/条，**快 4.5 倍**）。

两条约束：

1. **DDL 必须走 `exec()`** —— DDL 会让已缓存语句的编译结果失效，
   所以 `exec()` 里先 `statements.clear()` 再执行，顺序不能反。
   ⚠️ 绕过 `exec()` 直接改表结构，缓存里会留着针对旧表结构的语句。
2. **语句不能重入** —— better-sqlite3 在语句执行中再执行同一条会报
   "This statement is busy executing a query"。命中缓存时先看 `busy`，
   忙就临时准备一条新的（不进缓存）。

### 26. 去重 ID 必须覆盖**全部**载荷，不能只挑几个字段

服务端给「没带 eventId 的客户端」兜底生成去重 ID
（`domains/issues/event-identity.ts`）。

**哈希必须覆盖所有能区分事件的内容**，而且序列化要**排序键**。

⚠️ 踩过：哈希只取了「指纹 + 时间 + 用户 + 会话 + URL」，漏了 `release`。
   后果不是「偶尔多去重一条」，而是**回归检测被绕过** ——
   同一毫秒内、同会话、同 URL 的同一条错误但来自不同版本，
   两条算出同一个 ID，第二条被当成网络重试丢掉，
   于是「1.4.3 修好的问题在 1.4.4 又出现」进不了状态机，
   Issue 永远停在 `resolved`，不会变成 `regressed`。

**这个 bug 极难发现**：只在「两次上报落在同一毫秒」时触发，
表现为**偶发**的测试失败，而失败信息指向状态机，跟去重毫无关系。
（当时 15 轮压力跑挂了 3 轮。）

排序键的原因：客户端的 JSON 序列化方式不统一。
不排序的话，同一条事件的两次重传可能因为键顺序不同算出两个 ID，
去重失效 → count 虚高。

**推广**：去重键 = 事件的完整身份。少一个字段就多一类误杀。
任何「挑几个字段当唯一键」的地方都要问一句：
**还有哪个字段能让两条不同的事件算出同一个键？**

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
npm run test              # 221 条
npm run verify            # 33 条端到端断言
npm run verify:dashboard  # 50 条面板渲染断言
npm run audit:ui          # 15 条界面设计闸门
npm run audit:plans       # 1 条查询计划闸门
npm run audit:ingest      # 1 条摄入往返预算闸门
```

`npm run verify` 跑的是**真实链路**：真 Chromium → 真 SDK 产物 → 真 HTTP →
真 Collector → 真 SQLite → 真查询 API。

`npm run verify:dashboard` 自带播种逻辑（自建专属演示项目 + 注入 localStorage），
所以断言**可重复**，不依赖库里已有什么数据。

`npm run audit:ui` 把「界面好不好看」拆成 15 条**可自动测的数字**闸门：
字阶对比、字号档位、颜色收敛、动效档位、焦点环、点击目标、横向溢出、
响应式、reduced-motion 降级。改界面后跑一遍。

### 写断言的五个坑（都踩过）

1. **Element Plus 把所有下拉的 popper 都挂在 body 上** —— 数选项必须限定
   `.el-select__popper:visible`，否则会把别的下拉的选项一起数进去。
2. **资源错误本来就没有栈** —— 对它断言「有原始栈」是在断言不存在的事。
   断言要落在**有栈的那一行**上。
3. **E2E 跳页前要等特定事件落库**，不能只等「凑够 N 条」——
   页面里的错误常由 `setTimeout` 触发，跳太快会误判成产品问题。
4. **断言要落在具体那一个元素上**，别用位置选择器。`.first()` 选中的是
   **最早那条**，撤回了个不相干的，断言还照样通过。
5. **别把「某个状态出现了」当断言** —— 断言要带**能区分身份的信息**
   （内容 / id / 会话 ID），否则测的是「恰好也成立」的巧合。

### 缺索引在演示数据上**看不出来**

演示库只有几十行，任何查询都是亚毫秒 —— **缺索引的查询在演示数据上完全正常**。
但线上 `issue_events` / `transactions` / `alert_incidents` 这些表会随流量线性增长，
缺索引的查询到 10 万行时是全表扫描。

`npm run audit:plans` 就是为此存在的闸门：

1. `app.inject()` 打一遍管理端所有 GET 接口，**插桩记录实际执行的 SQL**
   （不靠猜，直接从运行时拿）
2. 把库复制一份，灌合成数据把增长表放大到 2 万行
3. 对每条 SQL 跑 `EXPLAIN QUERY PLAN`，扫描增长表上的 `SCAN`

⚠️ 计划必须在**放大后的库**上看 —— SQLite 的计划选择依赖表规模，
小表上「扫表更便宜」的判断到了线上会翻车。
⚠️ `EXPLAIN` 要求绑定参数，但绑 `NULL` 会让优化器以为条件恒假、把约束整个优化掉 ——
所以脚本把 `?` 换成字面量 `0`。

已用它抓到一次真问题：`alert_incidents` 的两个旧索引首列是
`dedupe_key` / `rule_id`，不是 `project_id`，
于是告警历史列表退化成「全表扫描 + 临时排序」。
修法是迁移 v4 补 `idx_alert_incidents_project`。

**断言要有鉴别力**：加索引前先确认「去掉索引时这条断言会挂」，
否则它可能是一条永远通过的假断言。

### 摄入路径的 DB 往返是有预算的

`npm run audit:ingest` 量「稳态下每条错误事件跑几次 DB」，预算 **4 次**：

```
1. 找 Issue            SELECT issues WHERE fingerprint
2. 查重                SELECT issue_events WHERE event_id
3. 写明细              INSERT issue_events
4. 更新聚合计数与状态   UPDATE issues
```

⚠️ **每条 SQL 在 PostgreSQL 部署下都是一次网络往返** ——
5 次往返就是 5 倍延迟。
⚠️ 而「多了一条查询」是**静默**的：没有任何测试会挂，也没有报错，
只有线上摄入变慢了才看得出来。所以必须给它一个**有上限的数字**。

曾多出来的一次是**查 sourcemap** ——
`SourcemapResolver` 只缓存命中、不缓存未命中，
没上传 map 的项目（很常见）**每条事件都要白跑一次库**。
现在命中和未命中分开缓存，且各自封顶（TraceMap 是重对象，封 32 条；
未命中条目很轻，封 4096 条）。

⚠️ 缓存失效必须作用在**同一个实例**上：
`ArtifactService.uploadSourcemap()` 调的 `invalidate` 打在它自己的 resolver 上，
所以 `IssueService` 必须和它共用同一个 resolver 实例。
写测试时也要注意——**另建一个 resolver 测失效，测的是另一个缓存**。

调预算用 `VIGIL_INGEST_BUDGET=3 npx tsx scripts/audit-ingest-calls.ts`，
看闸门真的会挂（改完记得调回来）。

### 禁用的控件不计入焦点环覆盖率

`disabled` 的 button **按设计就聚焦不了**，所以它不可能有焦点环。
界面闸门里已排除 `:disabled` —— 判据错了，不是界面错了。
同理 Element Plus 视觉隐藏的原生 input（`el-select__input` 等）也要排除，
它们是可点区域是 wrapper 的替代品。

---

## 部署

```bash
docker compose up --build    # 面板 :8080，接口 :4318
```

- `Dockerfile` 多阶段，两个 target（collector / dashboard）
- `deploy/k8s/` 有 namespace / postgres / deployment / service / ingress / HPA / PDB
- `docker compose up --build` 一把起全套（面板 + 接口 + PostgreSQL）
- ⚠️ **本机 Docker 跑不起来，镜像没有实跑验证过**（缺 WSL2）
- ✅ **多副本已可行**：采集服务用 PG 时是无状态的，`replicas: 2` + HPA 成立
- ⚠️ **PG 本身是单副本 StatefulSet** —— 它是单点。抗单点要上流复制或用托管实例

---

## 端口

| 端口 | 用途 |
|---|---|
| 4318 | Vigil 采集服务 |
| 5174 | Vigil 管理面板 |
| 5173 | **content-sharing-platform 的前端**（别动） |

面板 `vite.config.ts` 用了 `strictPort: true` —— 端口被占用时直接报错，
而不是像 Vite 默认那样静默递增到 5175。

⚠️ 面板代理的 target **硬编码 4318**。采集服务换到别的端口时，
代理会打到另一个服务上 —— 表现是 **403 令牌不匹配**，而不是连不上。

### ⚠️ 采集服务重启必须带管理 token

采集服务不设 `VIGIL_ADMIN_TOKEN` 时会**随机生成**一个，
而面板的 Vite 代理用的是 `process.env.VIGIL_ADMIN_TOKEN ?? 'vigil_admin_demo'`。

两边不一致时，面板所有管理接口 **403**（`管理 token 不匹配`），
数据明明在库里却一条都看不到。

```powershell
# Windows
cmd /c "set VIGIL_ADMIN_TOKEN=vigil_admin_demo&& set PORT=4318&& npm run dev:collector"
```

采集服务还在跑的时候 `npm run seed:demo -- --reset` 会**删不掉数据库文件**
（Windows 上文件被占用）—— 先停服务，播种，再起服务。

## 提交约定

- conventional commits，`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `ci`
- **每个 commit 一个原子改动**，docs 单独提交
- subject ≤ 50 字
- pre-commit 会跑 lint-staged（eslint --fix + prettier --write）
- ⚠️ **commitlint 拒绝 subject 里的全大写缩写**：`README` / `AGENTS` / `E2E` 都会被拒。
  写成「补回放域不变量」而不是「AGENTS 补回放域不变量」。
