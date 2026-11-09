# Vigil 面试问答手册

> 把项目写进简历之后，面试官会问什么、会点开哪个文件、会在第几层追问把你问穿。
>
> 核查日期：**2026-11-09**。所有数字、路径、函数名都对着当前仓库核过一遍；
> 与 README / AGENTS.md 说法不一致的地方，见 [第 16 节](#16-已知口径不一致清单先处理再面试)。
>
> 使用方式：**别背答案，背证据**。每道题按「我做的 / 为什么不用另一种 / 会追问 / 踩过的坑」
> 四段组织 —— 前两段证明你做得出，后两段证明你想过边界。答不上来时的说法见第 15 节。

---

## 0. 先看这一页

### 0.1 这个项目在简历上值多少钱

面试官三秒内扫的是三件事：**是不是真跑起来了**、**有没有工程纵深**、**能不能讲清一个决策**。

Vigil 的强项不在「功能多」（自研监控平台的 demo 一抓一把），而在三层证据链：

| 层 | 证据 | 面试官会怎么看 |
|---|---|---|
| 能跑 | `https://vigil.bscjs.top` 生产在线、Docker Compose 三容器 healthy、数据落真 PostgreSQL、免登录只读 Demo | 「不是本地截图」 |
| 有纵深 | 72 条路由、31 张表 / 39 个索引、12 个领域模块、SQLite 与 PG 双库、9 个版本化迁移 | 「不是 CRUD 拼盘」 |
| 讲得清决策 | 5 个自动闸门各自抓到过真 bug、`AGENTS.md` 35 条不变量、`CHANGELOG.md` 按里程碑记「为什么修」 | 「不是照着教程抄的」 |

**一句话定位（先背下来）**：
> 一个自研的前端可观测性平台，把错误、性能、用户行为、会话回放挂在**同一个会话**上，
> 并用「Issue 工单 + Resolve with Release」把错误日志变成有状态、能判回归的对象；
> 工程上用五个可自动跑的闸门守住索引、租户隔离、摄入预算、界面设计和发布准备。

### 0.2 简历上怎么写（可直接抄）

```
Vigil · 前端可观测性平台（个人项目，2026.10 – 2026.11，线上可访问）
- 浏览器 SDK + Fastify 采集服务 + Vue 3 管理面板，4 个 workspace 包；
  错误/性能/行为/回放四通道，72 条路由、31 张表 / 39 个索引，SQLite 与 PostgreSQL 一套领域代码双库运行
- 设计 Issue 状态机与 Resolve with Release 回归判定；指纹聚合靠数据库 UNIQUE 约束，
  摄入压到每条事件 3 次 DB 往返 / 每批 1 次提交，配额用计数表避免热路径 COUNT 全表
- 建立 5 个 CI 闸门共 24 条判据，抓到过全表扫描、跨租户写、逐条提交、窄屏溢出等真实回归；
  337 条单测 + 90 条端到端断言，CI 双 job 全绿
- 用 GHCR 镜像零编译部署到 1.6GB 服务器，nginx 三通道实现公开只读 Demo 与成员登录，
  线上部署冒烟 5/5、三通道冒烟 6/6
```

**不要写的 8 句话**（每一句都会被追问到穿）：

| 别写 | 为什么 |
|---|---|
| 「高并发 / 高性能 / 百万级 QPS」 | 没有压测数据，演示数据几十行，合成数据只放大到 2 万行看查询计划 |
| 「分布式 / 微服务 / 高可用」 | 是模块化单体；生产 PG 是单副本，k8s 清单未实跑 |
| 「精通 SQL / 数据库内核」 | 你是靠方言层 + 闸门把双库跑通的，不是数据库专家；见第 12 节 |
| 「对标 Sentry」 | 会被问「那 Sentry 的聚合算法你知道吗」，改说「参照行业做法自研一条最小闭环」 |
| 「完整 RUM / APM」 | 只覆盖 Web Vitals、长任务、span、路由事务，没有分布式链路追踪 |
| 「企业级权限系统」 | 是 RBAC 矩阵 + 审计日志，没有 SSO / OAuth / 细粒度策略引擎 |
| 「599 commit / 300 commit」 | 本地是 shallow clone（13 个 commit），远端约 300；commit 数不是能力证明，别写 |
| 「Tailwind / React / 微前端」 | 这个项目没用，写了等于给自己挖坑 |

### 0.3 电梯陈述（三个版本）

**30 秒**
> 我做了个前端监控平台：浏览器 SDK 采集错误、性能、行为和会话回放，Fastify 服务聚合成
> 带状态机的 Issue 工单，Vue 面板展示。最有意思的是「在 1.4.3 修好的问题，只有 1.4.4 再出现
> 才算回归」，以及五个能自动跑的闸门 —— 它们真的抓到过全表扫描和跨租户写。项目已部署上线，
> 有免登录的只读 Demo。

**2 分钟**（加这三句）
> 架构上是四个包：纯类型的协议包、零框架依赖的 SDK、模块化单体的采集服务、Vue 面板。
> 数据层用方言层同时支持 SQLite 和 PostgreSQL，领域代码一行不改；用 WASM 编译的 PGlite
> 在本地和 CI 里跑真 PG 语义测试。三条上报通道分开是因为错误要全量、性能要采样、回放体积大两个数量级。

**5 分钟**（再加这四句）
> 工程上我把「容易静默退化」的东西做成了有上限的数字：每条事件的 DB 往返 ≤3 次、每批提交 1 次；
> 热查询必须走索引（把库放大到 2 万行再看 EXPLAIN）；每条 SQL 必须自带租户范围；
> 界面设计拆成 15 条可测判据。这些闸门全部挂在 CI 双 job 上，不是「本地我跑过」。
> 部署是 CI 推 GHCR、服务器只 pull，因为生产机只有 1.6GB 内存，本地 build 会把 sshd 压到无响应。

### 0.4 硬事实速查表（背数字，更要背出处）

| 数字 | 值 | 出处 |
|---|---|---|
| 单元测试 | **337**（Collector 262 + SDK 75） | `README.md:74`；`packages/collector/tests/*.test.ts` 逐文件计数 = 262 |
| 端到端断言 | **90**（数据链路 33 + 面板渲染 57） | `scripts/verify-pipeline.ts`、`packages/dashboard/tests/verify-dashboard.mjs` |
| 自动闸门 | **5 个脚本 / 24 条判据**（界面 15 / 摄入 6 / 查询计划 1 / 租户隔离 1 / 发布准备 1） | `scripts/audit-*.ts\|mjs`；`.github/workflows/ci.yml` |
| 服务路由 | **72 条** method 路由 + 4 条 OPTIONS 预检 | `packages/collector/src/app.ts` |
| 数据库 | **31 张表 + 39 个索引**、9 个迁移版本 | `infra/db/schema.ts`（30 个唯一表 + `schema_migrations`）、`migrate.ts:357-499` |
| 领域模块 | **12 个**目录 | `packages/collector/src/domains/`（README 写 11，把 authz 单列了） |
| 面板 | **9 条路由 / 9 个导航项**（不是一一对应） | `src/router/index.ts:20-79`、`src/layouts/AppLayout.vue:50-65` |
| 代码规模 | 206 个跟踪文件；TS 28,314 行 / Vue 5,840 行 / 脚本 2,238 行 | `git ls-files` + `wc -l` |
| 仓库 | GitHub 创建于 **2026-10-27**，远端约 **300** 次提交；本地为 shallow clone（13 个 commit） | `gh api repos/Liao-wenxuan/vigil`；`git rev-parse --is-shallow-repository` |
| 里程碑 | v0.1.0 10-12 / v0.2.0 10-20 / v0.3.0 10-28 / v0.4.0 11-02 / 当前阶段 11-09 | `CHANGELOG.md` |
| 线上 | `https://vigil.bscjs.top`，三容器 healthy，部署冒烟 5/5、三通道 6/6、面板 e2e 57/57 | `README.md:834-835`、`docs/deploy.md` |

### 0.5 面试官最可能点开的 8 个文件（按概率）

1. `README.md` —— 数字是否自洽、有没有吹牛
2. `packages/collector/src/domains/issues/state-machine.ts` —— 状态机是不是纯函数、回归判定
3. `packages/sdk/src/fingerprint.ts` —— 指纹算法是不是真想过
4. `infra/db/schema.ts` / `migrate.ts` —— 表设计、索引、迁移
5. `scripts/audit-*.ts` —— 闸门是不是「永远通过的假断言」
6. `.github/workflows/ci.yml` —— 闸门是否真的挂上、顺序有没有坑
7. `deploy/nginx/default.conf.template` —— 三通道、token 注入
8. `packages/dashboard/src/layouts/AppLayout.vue` —— 身份判定、响应式

> 推论：**这些文件里不能有你自己都不信的注释**。第 16 节列出的 9 处口径差，
> 与其等面试官点出来，不如自己先说「这里文档写得比实现满，我后来发现并记下来了」。

---

## 1. 开场必问

### Q1.1 为什么做这个项目？

**我做的**：想搞清楚「一条前端错误从浏览器到面板」的完整链路。学校项目和课程设计大多止于 CRUD，
而监控 SDK 同时碰到浏览器事件模型、网络可靠性、数据建模、聚合算法、权限与隐私 —— 是一条能逼着自己
把前后端连起来的链路。

**为什么不用另一种**：没选「做一个博客 / 商城 / 聊天室」，因为那类项目的难点在业务规则，
不在系统；也没选「直接读 Sentry 源码写笔记」，因为读得懂和做得出是两回事，而简历需要可验证的产物。

**会追问**：「那你想验证什么假设？」→ 我想验证三件事：① 客户端算的指纹能不能稳定聚合；
② 一套领域代码能不能同时跑 SQLite 和 PG；③ 「容易静默退化」的性能与隔离问题能不能变成 CI 里会红的断言。

**踩过的坑**：一开始把「素材从哪来 / 有没有真实流量」当成设计前置条件，卡了很久。
后来把它降级成「演示数据 + 合成放大」，先跑通闭环 —— 规模是设计目标，不是启动条件。

### Q1.2 用一句话讲清它和「错误日志」的区别

错误日志是**一条记录**；Vigil 的 Issue 是**一个工单**：有状态（unresolved / resolved / archived）、
子状态（new / ongoing / escalating / regressed）、负责人、评论、活动流，还有版本锚点。
最关键的是 **Resolve with Release**：在 `1.4.3` 标为已解决后，`1.4.3` 及更早再报算噪音，
只有 `1.4.4+` 出现才算回归。这直接回答「这个 bug 是不是我上次的修复引入的」。

**会追问**：「状态存在哪？」→ `issues` 表的 `status` + `substatus` 两列，状态流转由纯函数
`transition(state, event)` 计算，服务层不许另写 if。

### Q1.3 为什么不直接用 Sentry？

**我做的**：自研的是**最小闭环**：SDK 采集 → 三条通道 → 聚合 → 状态机 → 面板 → 告警。
功能上远不如 Sentry，但每一层的取舍都是我自己定的，能讲出「为什么」。

**为什么不用另一种**：接入 Sentry 能学到配置，学不到指纹聚合、去重、租户隔离、摄入预算这些内部决策；
自研的目标是可解释性，不是替代它。真要上生产，我会建议直接用 Sentry / 商业 RUM。

**会追问**：「那你知道 Sentry 怎么聚合吗？」→ 大致是「按栈帧 + 异常类型 + 消息归一化生成 fingerprint，
服务端有 grouping 规则可配置」，我的实现是三路分类（javascript / resource / http）+ 前 3 帧 + 双哈希。
**不知道细节就直说**，别硬编（见 Q15.9）。

**踩过的坑**：第一版指纹把行号列号和构建 hash 算进去了，结果改一行代码、发一次版，
所有错误都变成「新的」，已解决状态全失效 —— 这才有了「指纹不含行列号 / 剥构建 hash」这条不变量。

### Q1.4 一个人做了多久？时间线怎么排？

按 `CHANGELOG.md` 的五个里程碑讲，不要说「一个月随手做的」：

| 阶段 | 时间 | 主攻 |
|---|---|---|
| v0.1.0 | 10-12 | 最小闭环：SDK + Fastify + SQLite + Issue 聚合 + 面板 |
| v0.2.0 | 10-20 | 状态机 / 回归 / 告警 / 性能 RUM / 多页面板 |
| v0.3.0 | 10-28 | 会话回放 / 行为 / 时间维度 / PostgreSQL / 保留策略 / 配额 |
| v0.4.0 | 11-02 | SLO 与错误预算 / 死信 / 五个闸门 / 摄入预算 |
| 当前阶段 | 11-09 | RBAC 与审计 / 团队路由 / 公开 Demo / 零编译部署 / 闸门进 CI / 中文 slug |

GitHub 仓库是 10-27 建的（之前在本地迭代），远端约 300 次提交，本地这份是 shallow clone。
**别把 commit 数写进简历** —— 它既不证明能力，也容易被「为什么只有 13 个 commit」误伤。

### Q1.5 用了 AI 吗？哪些部分是你自己写的？

这是现在的高频题，**别绕**。

推荐答法（三段）：
1. **用了**，而且有固定工作流：需求先写成 spec / 约束，再拆成小任务逐个实现，
   每个改动都要过 typecheck / lint / 单测 / 闸门，最后自己审一遍 diff。
2. **决策是我的**：三通道拆分、指纹不含行列号、状态机纯函数、SQL 自带租户范围、
   闸门判据与预算值、生产零编译部署 —— 这些是权衡，不是生成结果。
3. **我能证明我懂**：随便挑一个模块，我能从源码讲清为什么这么写、换一种会坏在哪、
   以及哪个闸门会先红。仓库里 `AGENTS.md` 的 35 条不变量就是我给「后续改动」立的规矩，
   包括给 AI 看的 —— 它的作用是防止后一轮把前一轮的决策改回去。

**会追问**：「AI 写错过什么？」→ 举真例子：`tenant` 的 UPDATE/DELETE 只按 `id`，
是闸门补齐团队路由后才暴露的；`audit:ui` 发现顶栏加身份标签后 320px 溢出 144px。
**这两个都不是 AI 主动报的，是闸门报的** —— 这正好说明验证链比生成更关键。

### Q1.6 有没有真实用户 / 真实流量？

**诚实答**：没有生产业务流量。线上跑的是演示数据（`npm run seed:demo`，含 400 条性能事务、
40 个会话、9 类错误模板）和合成放大数据（闸门把增长表灌到 2 万行）。
线上可访问、面板是真读真 PostgreSQL、SDK 能真上报，但**它不是被真实业务验证过的系统**。

**不要说**：「日均百万」「已在多家公司使用」。
**要补一句**：所以把我最没把握的地方做成了验证而非宣称 —— 查询计划闸门用 2 万行看 EXPLAIN，
摄入预算用差值法量每条事件的往返数，这些都承认「没有真实流量」这个前提。

### Q1.7 最难的一部分是什么？

推荐答 **「让静默退化变得可见」**，而不是「回放」或「状态机」：

- 「多了一条 SQL」「少了一个租户条件」「一批变成 20 次提交」「顶栏多 144px」
  —— 这四类问题**不会让任何测试挂、不报错、日志里什么都没有**，只有线上变慢 / 串数据 / 页面溢出才看得出来。
- 我的做法是把它们变成有上限的数字，并且**先验证闸门会挂，再信它**：
  `VIGIL_INGEST_BUDGET=3` 故意调预算看它变红；`migrate.test.ts` 用 `EXPLAIN QUERY PLAN`
  正反断言加索引前后的计划差异。

**会追问**：「闸门会不会自己写错，永远通过？」→ 会，所以有 `tests/` 里的反例测试，
以及「豁免必须逐条打印理由、写操作一律不豁免」的硬规则。

### Q1.8 现在最缺什么？

按 README「待做」诚实说，别现编：
SLO 接进真实发布流水线（现在 CI 只有空库冒烟，挡不住发布）、团队管理页面（后端 8 条路由就绪、
面板无 UI）、PG 高可用（单副本 StatefulSet 是单点）、邮件 SMTP 通道、npm 正式发布、
k8s 清单两处已知问题与实跑验证。

**加一句判断**：其中我最想先做的是 SLO 接真实流水线 —— 因为它现在是「看得见、挡不住」，
而闸门的价值就在于能不能真的拦住一次发布。

### Q1.9 如果重做一遍，会改什么？

三个，都要具体到代价：
1. **先定协议与租户边界再写 SDK**。现在 `packages/protocol` 是纯类型包，方向对，
   但 `ProjectRole` 里的 `writer` 与 collector 实际用的 `editor` 漂移了没同步（见第 16 节）。
2. **闸门和 CI 从第一天就一起上**。三个闸门曾经「本地能跑、CI 没挂」，根因是它们依赖演示库，
   干净 runner 上跑不起来，于是被搁置了整整一个阶段 —— 补上时立刻抓出 3 处越权写法。
3. **面板的身份判定一开始就用后端 `/me`**。早期靠 localStorage 猜，管理员浏览器里同时存着演示令牌，
   会显示成「只读演示」。

---

## 2. 架构与选型

### Q2.1 为什么是模块化单体，不是微服务？

**我做的**：一个 Fastify 进程，`src/domains/` 下 12 个模块（tenancy / authz / issues / performance /
alerting / artifacts / replay / ingestion / trend / slo / usage / retention），共用同一个 `Db` 接口。

**为什么不用另一种**：三个域紧耦合 —— 告警要读 Issue 状态，性能要关联错误上下文，SLO 要读事务与事件。
拆成进程就要处理跨进程查询、事务边界、最终一致性；在这个规模上，复杂度换不来收益。
域的边界本身就是现成切缝，真要拆时按域切即可。

**会追问**：「那它怎么水平扩？」→ 采集服务用 PG 时是无状态的（只共享一个数据库），
`replicas: 2` + HPA 成立；用 SQLite 时只能单副本，因为一个文件多进程写会锁竞争。
「告警定时器和 HTTP 服务在同一进程，会不会互相拖？」→ 会，所以评估器只入队、发送交给独立 worker，
且评估是 pull 模型（`VIGIL_ALERT_INTERVAL` 默认 60s），不是每次摄入都反查规则。

### Q2.2 四个包怎么切？为什么 protocol 单独成包？

| 包 | 交付物 | 关键约束 |
|---|---|---|
| `@vigil/protocol` | 8 个域文件的纯类型 | `exports` 只有 `types` 条件，无 `import`；编译后零代码、零体积 |
| `@vigil/sdk` | ESM + IIFE 两个产物 | 只依赖 protocol；Vue 适配器用 `VueLikeApp` 结构，不 import Vue |
| `@vigil/collector` | Fastify 服务 | 模块化单体，ESM/NodeNext 相对导入带 `.js` |
| `@vigil/dashboard` | Vue 3 静态站点 | 不共享 protocol，自己维护 `types.ts` |

**为什么**：协议是**线上契约**，单独成包 + 单独版本号，改动会体现在依赖树里；
两端都用 `import type`，运行期零依赖，也就没有构建顺序问题。
面板不共享是因为后端返回的命名本来就不统一（列表类接口直接返回 DB 行用 `snake_case`，
详情类返回 DTO 用 `camelCase`），按接口分别建模比造一个「统一」的假抽象更省事。

**会追问**：「加一个字段要改几处？」→ protocol → SDK 构造 → collector 解析 → 面板类型，四处；
所以 `CONTRIBUTING.md` 明令不许改字段名而不升版本。

### Q2.3 为什么 Fastify？schema 校验放在哪？

**我做的**：`Fastify({ ajv: { customOptions: { coerceTypes: false } } })`，
校验是**路由级 `schema.body`**，鉴权是路由级 `preHandler: adminGuard(authz)`，
审计是全局 `onSend` hook。`app.ts` 里没有注册任何 Fastify 插件，全是手写 hook + 路由选项。

**为什么 `coerceTypes: false`**：上报数据里大量字符串字段，AJV 默认会把 `"1.0"` 悄悄改成数字 `1`，
改的是用户数据 —— 版本号不能这么被动过手脚。

**会追问**：「Fastify 的校验错误为什么不是 400？」→ 校验错误不是 `AppError`，
会落进兜底错误处理器变成 500 并刷内部错误日志；`app.ts:116-140` 单独接住 `validation` 分支转 400。
这是 v0.4 修过的真 bug。

**踩过的坑**：`onSend` 而不是 `onResponse` —— 后者 fire-and-forget，会出现「请求已返回、审计还没落库」，
测试假 flaky、进程退出丢记录。而且 hook 只对**注册之后**的路由生效，所以 `onSend` 必须放在
所有管理路由之前（上报端 4 条 POST 与 2 条健康检查在它之前注册，天然不带审计）。

### Q2.4 为什么 SQLite + PostgreSQL 双库？不用 ORM 吗？

**我做的**：`createAppFromEnv()` 按 `DATABASE_URL` 选库；`infra/db/dialect.ts` 生成 DDL，
`postgres.ts` 把领域代码里的 `?` 翻译成 `$1`，`types.ts` 定义统一 `Db` 接口（all / get / run / insert /
transaction / savepoint）。

**为什么**：本机缺 WSL2 跑不了 Docker、也没装 PG，但生产必须 PG（单文件 SQLite 撑不住多副本）。
不用 ORM 是因为领域里有大量手写 SQL：`LN/EXP` 优先级排序、CTE 窗口计数、
`ON CONFLICT` 兼查重、多行 VALUES 批量、时区分桶表达式 —— ORM 反而要绕。

**三条硬规矩**（背下来）：
| SQLite 独有 | 通用写法 |
|---|---|
| `last_insert_rowid()` | `INSERT ... RETURNING id` |
| `INSERT OR REPLACE` / `OR IGNORE` | `ON CONFLICT ... DO UPDATE / DO NOTHING` |
| `sqlite_master` / `pragma_table_info` | `information_schema.tables / columns` |

**会追问**：「怎么证明 PG 上真能跑？」→ `tests/postgres.test.ts` 用 **PGlite（WASM 编译的真 PostgreSQL
引擎，不是模拟器）** 跑完整领域链路；另有 `postgres-transaction.test.ts` 用假连接池验证事务连接归属。
「布尔为什么用 INTEGER？」→ PG 的 BOOLEAN 不接受整数 `1`，写 0/1 两边都通，代价是少一层类型安全、
用 CHECK 补回来。「时间戳为什么 BIGINT？」→ PG 的 `INTEGER` 是 int4，epoch 毫秒 1.7e12 直接溢出。

### Q2.5 为什么不用消息队列 / Redis / ClickHouse？

统一答法：**按当前规模选最少的组件，并说清什么时候该换**。
- 消息队列：告警已经用「库表当队列」（`alert_deliveries` 的 `pending/sent/dead` + `next_attempt_at`），
  单机够用且重试持久化在库里；量上来再换真 MQ，接口边界（评估只入队、worker 只消费）已经切好。
- Redis：限流现在是**进程内令牌桶**（`capacity 240 / refill 40/s`），源码注释明写「重启清零、多实例各算各的」；
  多副本前必须换集中式计数，这是已知限制。
- ClickHouse / 时序库：31 张表都在关系库里，靠索引 + 聚合表 + 保留策略撑演示规模；
  真到百万行/秒要换列存，但那需要先有压测数据，我没有，所以不宣称。

### Q2.6 前端为什么 Vue 3 + Element Plus，不引图表库？

Vue 3 我会、组合式 API 适合把「项目上下文 / 时间范围 / 刷新令牌」做成 `provide/inject` 的共享状态；
Element Plus 按需引入（`unplugin-vue-components` + `ElementPlusResolver`），
不用 `app.use(ElementPlus)` —— 那会把 1.1MB 的库和 400KB 样式全打进产物。

图表是**手写 HTML/CSS**（`BarList` / `PercentileChart`），因为上一版用 SVG +
`preserveAspectRatio` 时字号是 viewBox 单位，同一个「12px」在不同宽度面板里渲染成两个大小；
`verify-dashboard.mjs` 里专门有一条「同屏图表标签字号一致」的回归防护盯着它。

**会追问**：「响应式原理？」→ 见 [第 13 节](#13-前端原理别主动引战但必须兜得住)，别在这题上主动展开。

---

## 3. 浏览器 SDK（最容易被深挖的一层）

### Q3.1 全局错误怎么抓？为什么要捕获阶段？

`window.addEventListener('error', handler, true)` —— **必须 `true`**。
资源加载失败（`<img src="404.png">`）不冒泡，用冒泡阶段监听一条都收不到。
handler 里用 `isElementTarget(event.target)` 区分资源错误与 JS 异常；
没有 error 对象时用 `filename / lineno / colno` 补一帧。
`unhandledrejection` 单独监听（被 `promise.catch()` 处理掉的不触发）。

**会追问**：「Vue 组件错误呢？」→ `@vigil/sdk/vue` 走 `app.config.errorHandler`，能拿到组件名；
适配器**保留**原有 errorHandler 并在其后调用，直接覆盖会静默吃掉业务自己的上报逻辑。
「白屏怎么判？」→ `BlankScreenDetector` 双信号：FCP 超时（默认 3s）+ DOM 五点 `elementFromPoint` 采样。

### Q3.2 fetch/XHR 劫持怎么避免无限递归？

两处：
1. `isCollectorUrl(url, endpoint)` 排除采集端点自身 —— 否则「上报 → 触发拦截 → 再上报」把页面打死；
2. `rawFetch` / `nativeFetch` 必须在**模块求值时**抓住并 `bind`，
   一旦 `installNetworkCapture` 给 `globalThis.fetch` 打了补丁，之后再取到的就是补丁版，调用即递归。

XHR 元数据用 `WeakMap` 存，`open` 时显式补 `async ?? true`。
`shouldReportStatus` 默认只报 **5xx**：4xx 多是业务语义（余额不足、登录过期），报进来只会淹没真错误。

### Q3.3 指纹怎么算？（**核心题，建议能写伪代码**）

`computeFingerprint(input)` 三路，全部经 `hashString`（FNV-1a + djb2 拼成 16 位十六进制）：

```
resource   → hash('resource|' + tag + '|' + 去掉 query/hash 的 src)
http       → hash('http|' + method + '|' + pathOf(url) + '|' + status)   // 不带 query
javascript → errorName + '|' + 前三帧的 `functionName@filename` 用 '>' 连接
              （先滤掉 SDK 帧与 node_modules / @vite / @fs / @id 第三方帧）
              一帧都没有 → 退化成 normalizeMessage(message)
```

**三条设计准则**（面试官最想听的三句）：
1. **用 `category` 不用 `kind`**：`ErrorKind`（js/promise/vue/manual）只说明「谁抓到的」，
   `ErrorCategory`（javascript/resource/http）才是分组维度 —— Vue 捕获和全局捕获到同一个错误必须同一条。
2. **不含行号列号**：改一行代码不该让错误的历史断掉。
3. **剥构建 hash**：`stripBuildHash` 把 `index-DnB3xK2l.js` 归一成 `index.js`，
   否则每次发版所有错误都变成新的。

`normalizeMessage` 把 UUID → `<uuid>`、数字 → `#`、空白合并、截 120 字符。

**会追问**：
- 「为什么不用 `crypto.subtle.digest`？」→ 它**异步**，而指纹必须在 `window.onerror` 同步回调里当场算出；
  异步意味着这条错误带着空指纹进队列，聚合直接废掉。
- 「双哈希为什么？」→ 16 位十六进制来自两个 32 位哈希拼接，降低碰撞；不是密码学哈希，
  因为这里要的是**稳定分组**不是防篡改。
- 「客户端算的指纹能信吗？」→ **不能全信**。协议约定服务端直接用它做聚合键，
  合理性是「客户端有更完整的栈信息」；风险是恶意或旧版 SDK 传空串会让该项目所有错误塌成一行。
  **诚实补充**：`AGENTS.md` 第 6 条与测试夹具注释声称 collector 有 `isValidFingerprint` 校验与兜底，
  但当前 `collector/src` 里没有对应实现，见第 16 节 —— 这是我要补的洞，不是能吹的点。

### Q3.4 脱敏怎么做？为什么按「词段」而不是子串？

`mask.ts` 里两套集合：16 个 `EXACT_KEYS`（整键敏感，如 `code`、`token`）、
28 个 `SENSITIVE_PARTS`（词段，如 `password`、`apikey`、`idcard`）。
`splitKeyParts` 先把 `accessToken` 拆成 `['access','token']` 再逐段匹配。

**为什么**：子串匹配会把 `monkey`（含 `key`）、`zipcode`（含 `code`）一起抹掉；
`code` 是整键敏感（OAuth `?code=`），但 `statusCode` / `errorCode` 只是词段，不该抹。
`maskUrl` 用字符串切 `?/#/&` 而不用 `new URL()` —— 相对路径会被拼上假 origin。

`scrubText` 四条正则**顺序固定**：`JSON_ASSIGN → AUTH → CREDENTIAL → ASSIGN`。
AUTH 必须排在 CREDENTIAL 前，否则得到 `Authorization: *** ***`，凭证反而留在后面。
`maskRecord` 递归深度上限 4、数组截前 20、超长文本加 `…[truncated N chars]`。

**会追问**：「为什么脱敏必须在采集端？」→ 采集端不脱敏，等于把用户隐私复制进一份新数据库；
而且上报之后就晚了。`CONTRIBUTING.md` 明令「不要把采集端脱敏挪到服务端」。
「服务端有兜底吗？」→ 注释里写了「老 SDK 版本兜一层」，但源码里没有实现（第 16 节），
**面试时主动说清，别等被翻出来**。

### Q3.5 栈解析正则怎么处理 `http://` 里的冒号？

`parseLocation` 用 `/^(.*?)(?::(\d+))?(?::(\d+))?$/` —— **懒惰匹配从右往左**抠可选的 `:line:col`，
剩下的整体当文件名，所以 `http://localhost:3000/app.js:1:20` 不会把协议里的冒号拆错。
Chrome 帧走 `at ... (...)` 的括号拆分，Firefox 走 `@` 拆分；解析不出来返回 `[]`
（采集代码自己抛异常是最糟的故障模式）。`safeStringify` 用 `WeakSet` 处理循环引用。

### Q3.6 三条上报通道为什么要分开？

| | 错误 | 性能 | 行为 / 回放 |
|---|---|---|---|
| 端点 | `/api/v1/collect` | `/api/v1/performance` | `/api/v1/behavior` |
| 采样 | 全量 | 10%（`performanceSampleRate: 0.1`） | 全量（可配） |
| 体积 | KB 级 | 每条几十 KB | 回放可达几百 KB |

混在一起就没法「错误全量、性能采样」；回放随错误上报但体积差两个数量级，
混进错误通道会把采样、保留、批量策略一起拖垮。
`sourcemaps` 是第四条通道，用**独立的 upload 密钥**，只在 CI 里调。

**会追问**：「采样为什么按会话不按事件？」→ 随机抽事件会得到「同一个用户只上报了部分错误」的残缺上下文，
比不采样更误导；整个会话要么全采要么全不采。

### Q3.7 通道地址为什么要「推导」而不是拼接？

`endpoint` 是错误通道完整地址（`.../api/v1/collect`）；性能与行为是它的**兄弟通道**。
`resolveApiRoot()` 去掉最后一段路径，再 `resolveChannelEndpoint(root, channel)` 拼出兄弟地址。

**踩过的坑**：直接拼接得到 `.../api/v1/collect/api/v1/behavior` —— **404 且不报错**：
请求发出去了、服务端也收到了，只是路由不匹配。面板上看到的是「行为数据一条都没有」，
SDK 侧一切正常，日志里连一条警告都没有。这个坑在 v0.3 才修，并被 `endpoint.test.ts` 钉死。

### Q3.8 批量 / 重试 / beacon 怎么设计？

- `EventQueue` 四个 flush 时机：攒够 `maxBatchSize=20`、定时 `flushIntervalMs=5000`、
  页面切后台/卸载、手动 `flush()`。`flush()` **先把队列清空再发**（`items = []`），
  发送失败或耗时很久时新事件仍能入队；**队列本身没有容量上限**，`maxSize` 只是触发阈值。
- `splitIntoBatches` 按 `maxPayloadBytes = 48KB` 切批：超过 64KB 会被浏览器**静默丢弃**、
  不报错不重试。单条超大事件自成一批，不丢。
- `sendBatch`：`pagehide` 时优先 `sendBeacon`，token 放进 **body**（beacon 不能自定义 header），
  返回 false 或异常**落回 fetch**；fetch 走 `keepalive: true`、`credentials: 'omit'`、
  token 放 `X-Vigil-Token` 头。
- **没有自动重试循环** —— 失败只在 debug 下 `console.warn`。重复上报安全靠 `eventId` +
  服务端唯一索引去重，不靠 SDK 重试。

**会追问**：「为什么用 `pagehide` 不用 `unload`？」→ `unload` 会让页面进不了 bfcache，
用户「后退」时要重新加载，体感明显变慢。
「sessionId 存哪？」→ **sessionStorage**，localStorage 会跨标签页共享，两个标签页被算成一次会话。

### Q3.9 回放为什么是独立入口？插件系统怎么做到「核心不感知」？

rrweb 体积大（README 口径：核心 43KB、回放入口 279KB；源码注释另写「rrweb 260KB / gzip 约 80KB，
核心 13KB → 90KB+」—— 数字口径不一，见第 16 节），而且绝大多数用户不需要回放，
尤其涉及隐私合规的团队。所以 `@vigil/sdk/replay` 是独立构建产物，核心的 import 列表里没有 rrweb。

`VigilClient` 只给插件一个**能力受限的 host**（`options`、sessionId/userId getter、`post`、`addContext`），
不给整个客户端；`setupPlugins()` 同步 for 循环调用 `plugin.setup(host)`，单个插件抛错只 warn 不阻断。
事件发出前走 `runPluginEnrich`，回放插件在这里把 `recorder.peek()` 挂到 `event.replay` 上 ——
**回放不是持续上传整段会话，是出错时随错误带上去**。

**会追问**：「为什么 IIFE 要在 `<head>` 同步加载？」→ `<script type="module">` 默认 defer，
初始化晚于 HTML 解析；首屏 `<img>` 的 404 在解析过程中就触发完了，ESM 接入一条都收不到。
实测过：同一页面 IIFE 抓得到首屏图片 404，ESM 抓不到（动态加载的资源仍可上报）。

### Q3.10 回放缓冲区的「命门」是什么？（**高频深挖题**）

rrweb 的流是「**一个全量快照 + 一串增量**」，中间丢任何一段，后面的增量全部对不上，
而播放器**不报错、只是画面全乱**。所以策略抽成纯函数 `applyReplayEvent(state, event, maxBytes)`：

1. `type === 2`（FullSnapshot）→ 只保留最多一个 Meta(4) + 新快照；**全量快照不受预算限制**；
2. `state.bytes + size > 64KB` → **整体清空**、标记 `overflow: true`、要求调用方重新取全量快照；
   **绝不能丢中间段**；
3. 正常追加。

事件编号不能猜（2=全量快照 / 3=增量 / 4=Meta；NodeType 0=Document / 2=Element / 3=Text），
写成 0 会导致缓冲区永远不重置。Meta 带原始视口尺寸，重置时**必须保留**，否则回放被裁切。
`replay-buffer.test.ts` 有一条直接断言「没有快照时不该攒出一串增量」。

**会追问**：「为什么不能用 `seq 已存在就跳过`？」→ 那会静默拼出「新快照 + 旧增量」的混合流，
播放器不报错，只是画面全乱。这是服务端 `replay/service.ts` 里的注释，与客户端缓冲是同一条不变量的两端。

### Q3.11 隐私边界在哪？

行为采集**不记录任何输入内容**：`behavior.ts` 跳过 `input/textarea/select`，点击文字经 PII 脱敏后截 40 字符；
面包屑记录「点了某个按钮」不记「在搜索框里输入了 xxx」。
rrweb 侧 `maskAllInputs: true` + 9 类 `maskInputOptions` 全开，
`maskSensitiveText` 用正则遮邮箱 / 大陆手机号 / 身份证 / 银行卡，`recordCanvas: false`、
`collectFonts: false`，`checkoutEveryNms: 30_000` 定期重取快照缩短增量链。

**这条边界是设计出来的，不是没实现** —— `AGENTS.md` 第 18 条写着「不要为了功能更全去采集输入内容」。
**会追问**：「够安全吗？」→ 不够，源码注释自己写了「这不是完整的 PII 防护，更严格场景用 `maskAllText: true`」。
`sourcemap` 同理：只上传服务端、不进静态资源目录，浏览器能下载到的文件攻击者也能下载到。

---

## 4. 摄入与存储

### Q4.1 一条错误从进来到落库，走哪几步？（**必背调用链**）

```
POST /api/v1/collect
  → Fastify schema.body 校验（events 1..200，items 只验 type:object）
  → authenticateProject：x-vigil-token / body.token → findProjectByKey(hash) → keyKind 必须 runtime
  → enforceRateLimit(project.id)：进程内令牌桶，240 容量 / 40 每秒补充
  → IngestionPipeline.ingestErrors
      → usage.assertWithinQuota(project, events.length)        // 配额计数表主键点查
      → db.transaction(...)                                    // 整批一个事务
          → for each event:
              db.savepoint(`ev_${i}`, ...)                     // 每条一个保存点
              issues.ingestEvent(project.id, event)            // 见下 3 次往返
              event.replay && event.sessionId → replay.saveReplay
      → usage.addEvents(project.id, accepted)                  // 事务外一条 UPSERT
  → { ok, accepted, dropped, ids }
```

**为什么每条事件套 SAVEPOINT**：PG 里一条语句失败会**中止整个事务**，
一条坏事件会把另外 19 条好的一起带走；保存点让失败只回滚自己。
SQLite 的 `ROLLBACK TO` **不释放**保存点，回滚后还要 `RELEASE` 一次。
整批 0 成功视为系统性故障，**必须抛出去** —— 返回 200 会让客户端以为一切正常、数据静默丢失。

**会追问**：「告警在摄入时触发吗？」→ **不**，是 pull 模型：定时器每 60s 扫启用规则。
事件驱动要在每次摄入时反查所有规则，反而更慢更贵。

### Q4.2 「每条事件 3 次 DB 往返」具体是哪三次？

| # | SQL | 作用 |
|---|---|---|
| 1 | `SELECT ... FROM issues WHERE project_id = ? AND fingerprint = ?` | 找 Issue，找不到则建空壳 |
| 2 | `INSERT INTO issue_events ... ON CONFLICT (project_id, event_id) DO NOTHING` | **写入本身兼作查重** |
| 3 | `UPDATE issues SET count = ..., last_seen = ...` | 更新聚合计数与状态 |

第 2 步以前是两条（先 `SELECT` 查重再 `INSERT`），改成 `ON CONFLICT DO NOTHING` 后
`changes === 0` 就说明是网络重试的同一条事件。每少一次往返，在 PG 部署下就是少一次网络往返。

**诚实边界**：README / 闸门脚本的「3 次」是**稳态理想预算**（缓存全热、无 userId、sourcemap 命中）；
`sourcemap.ts` 注释里另写「摄入热路径 5 次往返里有 1 次是它」，`issues/service.ts` 注释写
「少一次往返就是少 25%」（对应 4→3）。实际 `ingestEvent` 还有 `userIsNew` 查询、活动流写入、
sourcemap 未命中查库。**被问到别说「永远 3 次」，说「预算是 3 次，闸门量的是随条数增长的稳态增量」**。

**会追问**：「怎么量的？」→ `audit-ingest-calls.ts` 用 spy Db 计数 + 包装 better-sqlite3 底层句柄数
`COMMIT`（BEGIN/COMMIT 不走 `Db.exec`）；先跑 1 条建稳态，再分别跑 1 条和 20 条，
`perEvent = (calls20 - calls1) / 19` 的**差值法**，只把随条数增长的部分算进预算。

### Q4.3 eventId 去重为什么要覆盖全部载荷？

服务端给「没带 eventId 的旧客户端」兜底生成 ID（`event-identity.ts`），
哈希覆盖完整事件并**排序键序列化**（`canonicalJson`）—— 客户端 JSON 键顺序不统一，
不排序的话同一条事件的两次重传会算出两个 ID，去重失效、count 虚高。

**踩过的坑（这条最值得讲）**：早期只哈希「指纹 + 时间 + 用户 + 会话 + URL」，**漏了 release**。
后果不是「偶尔多去重一条」，而是**回归检测被绕过**：同一毫秒、同会话、同 URL 但来自不同版本的
两条事件算出同一个 ID，第二条被当成网络重试丢掉，于是「1.4.3 修好的问题在 1.4.4 又出现」
进不了状态机，Issue 永远停在 `resolved`。
而且它只在「两次上报落在同一毫秒」时触发，表现为**偶发**测试失败，失败信息指向状态机，
跟去重毫无关系（当时 15 轮压力跑挂了 3 轮）。

**推广说法**：去重键 = 事件的完整身份，少一个字段就多一类误杀。
任何「挑几个字段当唯一键」的地方都要问：还有哪个字段能让两条不同的事件算出同一个键？

### Q4.4 空壳 Issue 是什么？怎么处理？

罕见分支：同一个 `eventId` 换了指纹 → 明细 `ON CONFLICT DO NOTHING` 写不进去，
但刚才为它建出来的 Issue 行会留成 `count = 0`，面板上看起来像「有个问题但一次都没发生过」。
`issues/service.ts:183-191` 在冲突时把这个空壳删掉。

**会追问**：「聚合为什么靠 UNIQUE 约束？」→ 应用层「先查再插」在并发下必然出重复行；
`UNIQUE (project_id, fingerprint)` + UPSERT 把并发正确性交给数据库。

### Q4.5 配额为什么不 `COUNT(*)`？

配额检查在**每个上报请求**的路径上，而 `issue_events` 会长到百万行 ——
`COUNT(*)` 成本随事件数线性增长，等于「最频繁的接口配最贵的查询」。
所以有 `project_usage` 表：一次主键点查 + 一次 UPSERT，成本是常数；计数行与项目**同时创建**，
否则第一次上报仍要 `COUNT(*)` 才知道起点。

**关键设计**：计数器**单调递增**。保留策略会删掉过期事件，如果配额看「现存多少行」，
项目只要等清理跑完配额就自己回来了。配额记的是「累计摄入量」。
`quota.test.ts` 有一条专门断言「retention 删除后配额不回退」。

### Q4.6 限流为什么按项目不按 IP？

上报请求来自**用户的浏览器**，IP 是用户的不是项目的；按 IP 限流会误伤同一出口 IP 后的所有用户。
实现用令牌桶（不是固定窗口，避免窗口边界的突发翻倍），`capacity 240 / refill 40/s`。
**已知限制**：进程内实现，重启清零、多实例各算各的 —— 多副本前必须换集中式计数，源码注释里写明了。

### Q4.7 31 张表 / 39 个索引怎么来的？索引设计有什么讲究？

`buildSchema(dialect)` 按域分组生成 DDL：租户 / 问题 / 性能 / 告警 / 回放 / 制品 / 审计 / SLO。
索引多为 `(project_id, 时间)` 或 `(project_id, 去重键)` 的复合索引 —— 因为几乎所有热查询
都以 `project_id` 打头（租户范围 + 时间窗口）。唯一索引 `idx_issue_events_uid (project_id, event_id)`
是去重正确性的地基。

**踩过的坑（查询计划闸门抓到的真问题）**：`alert_incidents` 的两个旧索引首列是
`dedupe_key` / `rule_id`，不是 `project_id`，告警历史列表退化成「**全表扫描 + 临时排序**」。
修法是迁移 v4 补 `idx_alert_incidents_project`。
`migrate.test.ts` 用 `EXPLAIN QUERY PLAN` 正反断言：计划里要含索引名、不含 `SCAN`、不含 `TEMP B-TREE`。

**会追问**：「为什么演示库看不出缺索引？」→ 几十行时「扫表更便宜」，优化器本来就会选 SCAN；
线上到 10 万行才退化。所以闸门要先把库**复制一份**灌到 2 万行，再看 `EXPLAIN`。

### Q4.8 9 个迁移版本各做了什么？为什么不改已发布的迁移？

v1 core-schema / v2 迁移 v1 老数据 / v3 配额计数表 + 回填 / v4 告警索引 / v5 SLO 表 /
v6 投递死信表 / v7 投递队列加列 / v8 回填非错误事件用量 / v9 成员密钥表。
`runMigrations` 建 `schema_migrations`，读已应用版本，**每版本一个事务**。
规则是「已发布的迁移不能改」—— 线上已经应用了，要改就加新版本。

**最阴的一个坑**：v1 和 v2 都有 `sourcemaps` 表但列结构不同，
而建表语句是 `CREATE TABLE IF NOT EXISTS` —— 表名已存在时什么都不做，v2 的列根本不存在，
任何上报查 sourcemaps 时抛错、整条摄入链路 500。**只在带历史数据的库上出现**：
全新库一切正常，本地全绿、升级的生产直接挂。修法是 `renameLegacyTables()` 先把老表改名腾位置，
`migrate.test.ts` 有 7 条回归测试盯着。

**会追问**：「`WHERE 1 = 1` 能省吗？」→ 不能。SQLite 解析 `INSERT ... SELECT ... ON CONFLICT` 时
要求 SELECT 带 WHERE，否则 `ON` 会被当成 JOIN 的 ON。

### Q4.9 PG 事务为什么必须用 AsyncLocalStorage？

**踩过的坑**：`transaction()` 从池里借出 client 发 `BEGIN`，但语句走 `pool.query` —— 它会挑一个
空闲连接，那是**另一个连接**。结果 PG 上事务形同虚设，`BEGIN/COMMIT` 落在一个连接、语句全在事务外跑，
摄入失去原子性。修法是用 `AsyncLocalStorage` 按异步调用链绑定「当前事务的连接」。

**为什么不能用普通字段**：适配器是所有请求共享的，并发两个事务会互相覆盖，
事务 A 的语句跑到事务 B 的连接上，隔离级别直接失效。

**这个 bug 为什么没被 PGlite 测出来**：PGlite 是**单连接**的，天然不会出现「语句跑到别的连接上」。
所以另写了 `postgres-transaction.test.ts` 用**假连接池**（池和借出的连接是不同身份）验证语句归属。
一句话结论：**单连接的实现证明不了多连接的行为**。

**会追问**：「连接池为什么显式设超时？」→ `pg` 默认不超时，一条写错的查询会永久占住连接，
池默认 10 个占满后整个采集服务假死，而且日志里一条报错都没有。
现在 `max 10 / idle 30s / connect 5s / statement_timeout 15s / query_timeout 20s`。

### Q4.10 保留策略为什么必须「分批 + 上限 + 不重入」？

`retention_days` 之前只是个字段，建项目时写进去没人读；回放单会话几百 KB，
一天一千会话就是 GB 级增长，三个月后不是「查询变慢」而是磁盘满。
实现三个约束：分批删（一条 `DELETE` 删十万行会长时间持锁，期间上报全排队）、
每轮上限（`batchSize 5000 × maxBatches 20`，积压半年数据不能把 CPU 吃干）、
`running` 标志防重入（上一轮没跑完，下次定时器直接跳过）。清理 5 张增长表，
`retention_days <= 0` 表示永久保留。

**SQL 细节**：用 `id IN (SELECT id ... LIMIT ?)` 而不是 `DELETE ... LIMIT ?` ——
后者是 SQLite 编译期可选特性，PG 根本不支持。

### Q4.11 时区桶为什么容易错？

「按天」的桶边界要对齐**本地午夜**，按 UTC 切的话中国用户看到的「今天」要到早上 8 点才开始。
`bucketExpr(column, bucketMs, tzOffsetMinutes)` 里本地时间 = UTC + 偏移，
所以本地第几天是 `(col + offset) / bucketMs`，桶起点换回 epoch 再减偏移。
**符号搞反会把东八区算成西八区，桶边界整体错 8 小时，数据落到隔壁那天的桶里**。
而且 SQL 的桶起点与 JS 合并时的 `bucketStart` 必须完全一致，否则一个都对不上。

---

## 5. Issue 生命周期与查询

### Q5.1 状态模型到底是几层？

**不是 6 个并列状态**，是两层：`status`（`unresolved | resolved | archived`）×
`substatus`（`new | ongoing | escalating | regressed`）。
`transition(state, event)` 是**纯函数**，输入状态 + 8 种事件之一，输出新状态 + 变更 + 活动流草稿；
`default` 分支用 `const _exhaustive: never` 做编译期穷尽检查 —— 以后加事件类型，漏一个分支编译不过。

**为什么纯函数**：服务层另写 if 判断流转，迟早会和状态机分叉；
「每次流转产生什么活动流」也必须是函数的一部分，不靠调用方记得写。

### Q5.2 Resolve with Release 怎么判版本？

`isNewerVersion(candidate, baseline)`：去掉 `v` 前缀、`+build`、`-prerelease`，
逐段纯数字比较、按位补 0；非数字段保守返回 false。
**为什么不能字符串比较**：`'1.4.10' < '1.4.3'` 在字典序下成立，回归就判不出来了。

`onResolve` 记 `resolvedInRelease`；`onEventReceived` 在 `status === 'resolved'` 时
比较新事件的 release，只有真的更新才转 `unresolved / regressed` 并写活动流。
在解决它的那个版本或更早出现 → 算**噪音**，不重新打开。

**会追问**：「存版本 id 还是字符串？」→ 存**版本字符串副本**。
schema 注释解释过：版本记录可能被删，而回归判定是历史事件，不能依赖关联行还在。

### Q5.3 `last_seen` 为什么用 MAX 而不是「最近一次写入」？

事件不保证按时间顺序到达：SDK 离线补报、网络重试、客户端时钟偏差，
都会让一条**更早**的事件后到。直接覆盖会把 `last_seen` 拖回过去，症状是
「刚刚还在报错的问题」按最近排序时沉到列表底部，而且窗口查询 `last_seen >= since`
会把它当成「这段时间没发生」直接漏掉。实现是 `Math.max(state.lastSeen, event.now)`。

### Q5.4 列表查询为什么全部下推 SQL？

旧实现「全量 `SELECT *` → JS 排序 → `slice` 分页」有三个问题：
没有 LIMIT（5000 个 issue 会把每行 `raw_stack` 一起搬出来）、排序用不上索引、
`total` 和列表是两次不一致的扫描。现在 `limit` 夹在 `[1,200]`、默认 50，
排序、分页、计数都在 SQL 里。

**优先级分数用 SQL 的 `LN` / `EXP` 算**：
`log1p(count) + 1.5*log1p(user_count) + 4*exp(-age/24h) + 3*exp(-issueAge/72h) + 状态加权`。
`computePriority` 是 JS 的**参考实现**（不是运行路径），单测里有一条专门比对 SQL 排序与 JS 排序结果一致。
PG 用 `GREATEST`、SQLite 用 `MAX` 做 clamp；不支持数学函数的库会降级成按 `last_seen` 排并只 warn 一次。
**次级排序固定 `i.id DESC`** —— 优先级分数有大量并列，不兜底翻页会重复或漏行。

**窗口查询两个加速点**：
1. 必要条件预过滤：窗口内发生过 ⇒ `last_seen >= since` 且 `first_seen < until`，走索引砍掉大部分候选；
2. CTE 先算出符合过滤条件的问题集合，再在**这些问题的事件**里聚合窗口次数。

PG 的 `COUNT(*)` 返回 bigint（字符串），要 `Number()` 收敛，否则前端拿到 `"42"`。

### Q5.5 累计口径和窗口口径为什么不能混？

顶栏有全局时间范围（1h / 24h / 7d / 30d），所有页面跟随。给了范围，
统计口径从「问题表的累计快照」换成「窗口内实际发生过」：

| | 无时间范围 | 有时间范围 |
|---|---|---|
| 去重错误 | issues 表全部 | 窗口内有发生的问题 |
| 发生次数 | `count`（累计） | `window_count` |
| 待处理 | 全部未解决 | 窗口内有发生且仍未解决 |

排序也要跟着换（有窗口时按 `window_count` 排）。状态分布用的是问题**当前**状态。
`verify-dashboard.mjs` 里明确写了「E2E 的接口查询必须用同一个窗口，
拿全量去比窗口，断言必然对不上」。

**错误率**：`错误发生次数 ÷ 页面访问次数`，分母为 0 时是 **null 而不是 0** ——
「没访问过」和「真的没错」是两回事。

---

## 6. 性能 / 告警 / SLO

### Q6.1 分位数怎么算？为什么不交给 SQL？

`percentiles(values)` 用**最近秩法** `ceil(q*n)-1`，保证返回值一定是实际观测到的值，
返回 p50/p75/p95/p99/min/max/avg。SQLite 没有 `percentile_disc`（PG 有），
为了双库一致就在应用层算。
span 批量写用多行 VALUES，`SPAN_CHUNK = 90`（10 参数/行 × 90 = 900，留在 SQLite 999 参数上限内）。

**错误与性能关联**：报错事件带上**当刻的** LCP/FCP/长任务数（`ErrorVitals`），
性能页用 `AVG(CAST(json_extract(e.vitals_json,'$.lcp') AS INTEGER))` 反查「哪些错误拖慢了页面」。

### Q6.2 告警引擎的 7 类规则 / 5 种通道 / 为什么是 pull？

7 类：`issue.new / issue.count / issue.spike / metric.error_count / metric.error_rate /
metric.lcp_p95 / slo.burn_rate`。
5 通道：`webhook / feishu / dingtalk / email / slack`（email 动态 import nodemailer）。

**pull 模型**：定时器每 60s 扫启用规则，不是每次摄入反查所有规则 —— 后者在热路径上更慢更贵。
评估器内部有**单轮 Promise 缓存**（键带 `now`，每轮 clear），同类规则只查一次库。

**去重**：`dedupeKey = ruleId : 主体 : 窗口编号`，窗口编号 `Math.floor(now / windowSeconds*1000)`。
同一个（规则, 问题, 时间窗）只发一次 —— 告警疲劳是监控系统最大的敌人。
SLO 规则没有 issue 主体，两个 SLO 会共用一个键，所以加了 `dedupeScope = slo_<id>`。

### Q6.3 为什么「评估只入队、发送交给 worker」？

评估是同步的：扫规则、算窗口、判触发。如果还要**等通道把 HTTP 发完**，
一个卡住的 webhook 会把整轮评估拖住 → 下一轮也排不上 → 告警彻底停摆。
`AlertEvaluator` 只判触发、记 incident、**入队**；`DeliveryWorker` 按 `next_attempt_at` 取待投递的发出去。
`alert_deliveries` 表**兼作队列与死信**（`pending → sent / dead`），重试持久化在库里，进程重启不丢。

**两层重试各管各的**：
- 发送内部（`channels.ts`）：单次 5s 超时、总预算 10s、退避 300/1000ms，
  只重试网络错误 / 5xx / 429，**4xx 不重试**；
- worker 跨轮（`delivery.ts`）：1min → 5min → 30min → 2h → 12h，1 次首发 + 5 次重试，用完转死信。

**踩过的坑**：`markDelivery` 的状态必须**显式传**。用布尔判断的话「终态失败」和「还要重试」分不开，
终态写成 pending + 无下次时间 = 立即再取 = 永远进不了死信。
「通道被删」要如实报错，不能悄悄当成功。

### Q6.4 SLO 的 SLI 为什么「分步判定」？

窗口切成小步，每步单独判达标，`SLI = 达标步数 / 参与判定的步数`。
不看整体平均：否则「99.99% 的时间正常、最后 1 分钟全崩」会被平均成 99.99%，
而用户那一分钟全在挨骂。

**步长是定义的一部分，不是实现细节**：30 天窗口配 1 小时步（720 步）时偶发一次错只掉 0.14%，
配 1 天步（30 步）同样的错掉 3.3%。所以 `normalizeStep` 要求步长整除窗口，定义时就拦住。
**无流量的步直接跳过**（既不算达标也不算不达标）—— 和 `errorRate: null` 同一个原则。

**会追问**：「预算和 SLI 为什么可能对不上？」→ 预算用**事件口径**（坏数 / 允许率×总数），
SLI 用**时间口径**；小流量步里的错误突发可以让 SLI 掉下来但预算还很充裕，
这不是矛盾，是同一份数据的两个视角。

**多窗口多燃烧率**（SRE 手册）：4 对长短窗口（3d/6h/1、1d/2h/3、6h/30m/6、1h/5m/14.4），
**两个窗口同时超阈值才告警** —— 短窗口负责快速感知、长窗口确认持续消耗；
只看一个要么抖、要么太慢。

### Q6.5 `slo:gate` 为什么把策略放在领域层？

「什么情况阻断发布」是**业务规则**，不是命令行细节。放在脚本里就没法测，
每次改都要手工跑命令看退出码。所以拆成：
`domains/slo/gate.ts` 的纯函数 `decideSloGate(items, options)`（9 条单测盯着）+
`scripts/slo-gate.ts` 只负责读库、调策略、翻译成退出码。

| 退出码 | 含义 |
|---|---|
| 0 | 放行（含「没数据库 → 跳过」） |
| 1 | 被 SLO 阻断（预算耗尽） |
| 2 | 闸门自己跑不起来（连不上库 / 参数错） |

**「没有数据库」和「数据库连不上」是两回事**：前者什么都没得判 → 跳过；
后者跑不了就不能放行 → 2。流水线只看「非零」，但日志含义完全不同。

**诚实边界**：CI 里挂的只是 `slo:gate -- --all` **空库冒烟**，只保证脚本不烂，
**挡不住发布**。README 自己写了「别把冒烟通过当成发布被守住」。

---

## 7. 会话回放（服务端）

### Q7.1 回放流怎么存？为什么「按会话只存最新一份」？

客户端缓冲是滚动窗口，第 2 个错误带的上传窗口比第 1 个更长；
每个错误存一份 = 大量重复数据。所以**每个会话只保留最新一份流**。
代价是回放展示的是「最近一次快照」，不精确对应每个错误的时间点 ——
这个限制写在 README 里，不藏着；好处是存储有界，不随错误数线性膨胀。

### Q7.2 为什么改成「增量写」？链的身份是什么？

旧实现每次上报「先 DELETE 整会话，再逐条 INSERT」。3000 事件的会话第 5 次上报要
删 3000 条 + 插 3000 条单条 SQL，是 **O(n²)**。
rrweb 流的身份是**第 0 条（全量快照）的时间戳**：
- 相同 → 同一条链的更长窗口，从 `MAX(seq)+1` 只追加尾部；
- 不同 → 客户端重取了快照，旧链整体作废。

**不能靠「seq 已存在就跳过」**：那会静默拼出「新快照 + 旧增量」的混合流，
播放器不报错，只是画面全乱。批量写 `CHUNK = 200`（200 × 7 列 = 1400 占位符）。

### Q7.3 「回放比行为汇总先到」为什么是常态？

错误立即上报，行为汇总要等攒批或页面卸载。所以**回放到达时会话行可能还不存在** ——
只 `UPDATE` 的话这一行永远建不出来，结果是「回放事件躺在库里，但会话列表里看不到它」。
`ensureSessionRow` 在写回放时保证会话行存在，起始时间取流第一个事件。

### Q7.4 播放器为什么要自己画控制条、动态加载？

`rrweb-player` 自带浅色控制条、类名带 Svelte hash（`.rr-controller.svelte-1difoxs`），
暗色主题下不搭，所以 `showController: false` 自己画。
播放器是 `import('rrweb-player')` 动态 chunk，只有真的打开回放页才拉。
挂载前先**验证流里有全量快照** —— 否则静默播不出来，用户只看到空白。

---

## 8. 多租户 / 权限 / 安全

### Q8.1 租户模型怎么分层？

组织（顶级租户 / 配额账单）→ 团队（人的分组 / 告警通知）→ 项目（被监控对象 / 密钥挂这层），
环境和版本是项目的下级概念。成员归属**组织**，项目成员表给项目级角色。

**会追问**：「为什么团队不挂项目？」→ 团队是组织内「人」的分组，用于通知与授权，
不是被监控对象的划分；挂项目会让跨项目通知变得别扭。

### Q8.2 双密钥为什么要分离？

| 密钥 | 用途 | 放哪 | 泄露后果 |
|---|---|---|---|
| `vsk_` runtime | 上报错误/性能/行为 | 前端代码（可公开） | 只能刷垃圾数据 |
| `vup_` upload | 上传 sourcemap | **只在 CI** | 能污染别人项目的错误栈 |

数据库只存 `sha256` 哈希，明文只在创建 / 轮换时返回一次；
`findProjectByKey` 返回 `keyKind`，上报端点要求 runtime、上传端点要求 upload。
`rotateKey` 先 DELETE 再 INSERT，旧密钥立即失效。

### Q8.3 RBAC 矩阵怎么定？为什么权限规则集中在一处？

`requiredAction(method, path)` 一处决定每条请求需要什么权限：
- `POST /api/v1/organizations` → `superadmin`（创建组织只有超管）
- `MANAGE_PATH`（成员 / 团队 / 凭据 / 项目成员 / 维护）→ GET 是 `read`，其余是 `manage`
- DELETE 一律 `manage`；GET/HEAD/OPTIONS 是 `read`；其余是 `write`

角色矩阵：组织 `owner > admin > member`，项目 `owner > editor > reader`。
读 = 同组织成员；写 = 组织 admin 或该项目 editor+；管成员/凭据/授权/维护 = 组织 owner。
跨组织一律 403，组织列表对普通成员只显示自己那个。

**为什么集中**：60 多条管理路由共用这一个 guard（全服务 72 条 method 路由），
逐路由声明漏配一个就是一次越权，而且**没有任何测试会报警**。

**会追问**：「`editor` 和 `writer` 哪个对？」→ collector 实际用 `editor`；
`protocol/src/tenancy.ts` 里写的是 `writer`，是协议与实现的命名漂移（第 16 节）。

### Q8.4 身份判定为什么必须有优先级？

`AuthzService.resolve()` 读三个来源：`x-vigil-admin-token`、`Authorization: Bearer`、
`x-vigil-member-token`。**先判 admin token（和 Bearer），命中即返回 SUPERADMIN；再判成员令牌**。

**踩过的坑**：线上走 Basic Auth + nginx 注入 admin token，而公开 Demo 又会在前端带上只读成员令牌。
如果先认成员令牌，**管理员会被降级成只读账号**：页面能开、数据能看，就是什么都改不了。
`isAdminToken` 用 sha256 + `crypto.timingSafeEqual` 比较，避免逐字节比较的时间差泄漏 token 前缀。
`authz.test.ts` 有一条专门锁死「admin token + member token 同时在场 → superadmin」。

**成员凭据**：`vmk_${randomBytes(24).hex}`，`member_keys` 只存哈希，列表接口不返回哈希；
撤销 = 删一行立即失效，不用轮换全站 token。

### Q8.5 审计日志记什么、不记什么？

只记**成功的写操作**（GET/HEAD/OPTIONS 不记，`status >= 400` 不记），
记 `actor_type / actor_id / action = "METHOD path" / target / organization_id / status`。
**不记请求体也不记响应体** —— 创建项目、签发凭据的响应里有明文密钥，
审计表不能变成第二个密钥库。`authz.test.ts` 断言审计 JSON 里不含 `vsk_` 和明文 key。

### Q8.6 「纵深防御」在这项目里具体指什么？

**隔离不能依赖调用方记得检查过**。鉴权层会解析目标组织并挡跨组织请求，
但每条 SQL **仍然自带** `organization_id = ?` / `project_id = ?`。

**真 bug 现场（本轮闸门抓到的）**：新增团队路由时，
`UPDATE teams ... WHERE id = ?`、`DELETE FROM teams WHERE id = ?`、
`DELETE FROM members WHERE id = ?` 三处只按 id —— 和 v0.2 修过的告警规则是同一个毛病，
新功能又把旧教训犯了一遍。修法是补 `AND organization_id = ?`。
`audit-tenant-scope.ts` 把管理端 41 条接口全打一遍，从库结构自动读租户列（不硬编码表清单），
**写操作一律不豁免**，只按结构豁免三类 SELECT 并逐条打印理由。

**会追问**：「纯子表没租户列怎么办？」→ `issue_activity / issue_comments / issue_tags / issue_users`
靠 FK 挂父行，归属继承自父行；闸门不检查但会列出来提醒。

### Q8.7 中文 slug 怎么转写？

`slugify` 用 `pinyin-pro` **逐字符只转汉字**（`HAN_CHAR = /[\u3400-\u9fff]/u`）：
整段丢给 `pinyin(..., {type:'array'})` 会把 `Vue3` 拆成 `V/u/e/3`，英文单词全散。
转完再 `toLowerCase` + 非 ASCII 归一成 `-`。`线上应用 → xian-shang-ying-yong`、
`Vue3 项目 → vue3-xiang-mu`。**只影响新建，已有 slug 不回填**（不跑迁移改历史数据）。

### Q8.8 公开只读 Demo 的三条通道怎么实现？

nginx `default.conf.template` 里：

```nginx
map "$http_authorization|$http_x_vigil_member_token" $vigil_public_channel {
    default     0;
    "~^\|vmk_"  1;          # 无 Authorization + 带 vmk_ 令牌
}
location /api/ {
    error_page 418 = @vigil_public_api;
    if ($vigil_public_channel) { return 418; }
    include /etc/nginx/vigil-auth.conf;              # Basic Auth
    proxy_set_header x-vigil-admin-token "${VIGIL_ADMIN_TOKEN}";
}
location @vigil_public_api {
    auth_basic off;                                  # 字面量，不能是变量
    proxy_set_header x-vigil-admin-token "";          # 关键：清空，不注入管理员令牌
    proxy_set_header x-vigil-member-token $http_x_vigil_member_token;
}
```

| 通道 | 行为 |
|---|---|
| A 匿名 + `vmk_` 演示令牌 | 200 只读（后端 RBAC 收紧到 reader），写入 403 |
| B 匿名无凭据 | 401 |
| C Basic Auth 管理员 | 200 + 注入 admin token → superadmin |

演示令牌由 `50-vigil-demo-config.sh` 在容器启动时写进 `/config.js`，
前端 `index.html` 在主 bundle **之前**加载它；`api/client.ts` 优先读 localStorage 的用户令牌、
否则读 `window.VIGIL_DEMO_MEMBER_TOKEN`，注入 `x-vigil-member-token` 头。
身份标签**以后端 `/me` 返回为准**，不靠 localStorage 猜。

**踩过的坑（三个都值得讲）**：
1. `auth_basic $var` 里变量求值成 `"off"` **nginx 照样弹登录框**，只认字面量 `off`；
   所以用 `error_page 418` + named location，且 named location 里 `proxy_pass` 会保留原始 URI 与 POST body；
2. map 正则一开始写成 `"~^\|~^vmk_"`（两个 `^` 永不匹配），导致 A 通道 401；
3. 管理员浏览器里往往**同时**存着演示令牌，前端靠猜会显示「只读演示」—— 改走 `/me`。

### Q8.9 管理 token 为什么不进前端代码？

开发时 Vite 的 `server.proxy` / `preview.proxy` 在 `configure(proxy)` 里给每个 `/api` 请求
加 `x-vigil-admin-token`；生产由 nginx 在通过 Basic Auth 之后注入。
所以 token **不出现在前端 bundle，也不出现在浏览器网络面板**。
`vite.config.ts` 显式把 `preview.proxy` 又写了一遍 —— preview 继承 server.proxy 的行为
在不同 vite 版本/平台上并不一致，少了它 e2e 的接口全 403，而页面因为拿不到数据又不报错，
断言失败得非常费解。

---

## 9. 前端面板

### Q9.1 面板有哪些页面？状态怎么共享？

9 条路由：总览 / 问题 / 问题详情 / 性能 / 告警 / SLO / 会话回放 / 用户行为 / 设置。
`AppLayout.vue` 用 `provide(PANEL_CONTEXT, context)` 把「当前项目、时间范围、刷新令牌、
身份」注入所有页面；页面 `watch(refreshToken)` 重载数据。时间范围存 localStorage，
自动刷新每 10 秒递增一次令牌。

**注意**：路由是 9 条（含 `issues/:id`），侧边导航也是 9 项，但**不是一一对应** ——
导航里「环境与版本」和「设置」指向同一个页面，而问题详情不在导航里。别被问住。

### Q9.2 类型化 API 客户端怎么设计？

`request<T>(path, init)` 统一封装：非 JSON 响应抛 `ApiError`（带 HTTP status），
`!response.ok || body.ok === false` 也抛；`get/post/patch/del` 是薄封装，
`URLSearchParams` 跳过 `undefined` / 空串。
`getErrorTrend` 会额外传 `tzOffset`，让按天分桶对齐本地午夜。

**为什么面板不复用 protocol**：后端返回的命名本来就不统一（列表类直接是 DB 行 `snake_case`、
详情类是 DTO `camelCase`），`types.ts` 按接口分别建模，不做「统一成一种」的假抽象 ——
统一了反而要在运行时多一次转换，多一层出错机会。

### Q9.3 身份标签为什么以后端 `/me` 为准？

`fetchCurrentPrincipal()` 调 `/api/v1/me`，失败（401/403）**返回 null 而不是抛异常** ——
没登录也是合法状态。三种展示：管理员（warning）/ 成员（success，令牌遮成 `vmk_****abcd`）/ 只读演示（info）。
顶栏「登录成员」popover 校验 `vmk_` 前缀后写 localStorage 并 reload。

**踩过的坑**：靠 localStorage 猜会出两种错 —— 管理员用 Basic Auth 登录但 localStorage 没令牌，
界面显示「只读演示」；反过来管理员浏览器里往往同时存着演示令牌，光看令牌也判断不出真实权限。

### Q9.4 Element Plus 为什么按需引入？CSS 导入顺序有什么讲究？

`unplugin-auto-import` + `unplugin-vue-components` + `ElementPlusResolver`，
**不要 `app.use(ElementPlus)`** —— 那会把整个库（1.1MB minified）+ 全部样式（400KB）打进产物。
`main.ts` 手动补 `base.css` 与 `dark/css-vars.css`，且**面板自己的 `theme.css` 必须最后导入**：
`html.dark { --el-* }` 与 Element Plus 暗色变量表**特异度完全相同**（都是 0,1,1），
谁写在后面谁赢；排错了会多出七八种 EP 默认色。

### Q9.5 窄屏横向溢出那次回归是怎么回事？（**很能体现工程意识**）

`audit:ui` 本地跑出 **12/15**：320/375/414px 下八个页面一起横向溢出，
溢出量固定是 `464 - 视口宽`（320→+144、375→+89、414→+50、768→0）。
根因是上一轮给顶栏加了「身份标签 + 登录成员」后，右侧 `.topbar-actions` 固定宽约 464px，
而它是 `flex: 0 0 auto` 死不收缩；顶栏是共用外壳，所以八个页面一起挂。

修法是 `@media (max-width: 768px)` 让 `.topbar` 改为 `flex-direction: column`、
`.topbar-actions` 允许 `flex-wrap: wrap`，而不是继续藏控件 → 15/15。
**顺手把注释里「早期 320px 只多 48px，是标签造成的」更正了** —— 结论会过期，注释也要跟着改。

### Q9.6 界面设计闸门怎么把「好看」变成数字？

15 条判据：字阶对比（最大/最小 ≥ 2.5×）、字号档位 6–14 档、单页颜色 ≤ 24 种、
动效 ≥ 2 档时长、焦点环覆盖 ≥ 90%、桌面主控件 ≥ 32px / 行内 ≥ 24px / 触摸 ≥ 40px、
1440 + 320/375/414/768px 五个宽度无横向溢出、reduced-motion 下内容不消失且动效 ≤ 0.05s。
测的是 `getComputedStyle` 的真实值，不是截图比对；同时输出静帧截图到 `docs/screenshots/`。

**会追问**：「禁用控件为什么不算进焦点环覆盖率？」→ 它按设计就聚焦不了，
算进来闸门会因为「40 个禁用的回放按钮」误报 —— **是判据错了，不是界面错了**。

### Q9.7 CSS 特异度踩过什么坑？

`theme.css` 里两处：
1. 窄屏控件尺寸的桌面规则是 `:not(.is-link):not(.is-text)`（特异度 0,3,0），
   媒体查询里只写 `:not(.is-link)`（0,2,0）会输给桌面规则，窄屏尺寸永远不生效，**而且不报错**；
2. 分页上下页按钮不在 `.el-pager` 里（是兄弟节点），EP 自己的规则是 `.el-pagination .btn-prev`，
   必须用**同样**的选择器才压得住。

---

## 10. 测试 / 闸门 / CI

### Q10.1 测试分层怎么讲？

| 层 | 数量 | 跑什么 |
|---|---|---|
| 单测 | 337（Collector 262 + SDK 75） | 状态机、指纹、脱敏、双库、权限矩阵、SLO 纯函数… |
| 数据链路 e2e | 33 | 真 Chromium → 真 SDK 产物 → 真 HTTP → 真 SQLite → 真查询 API |
| 面板 e2e | 57 | 真浏览器 DOM 文本 / 元素计数 / 计算样式 / URL，对照接口 JSON |
| 闸门 | 24 判据 | 界面 15 / 摄入 6 / 查询计划 1 / 租户隔离 1 / 发布准备 1 |

Collector 的 `vitest.config.ts` 用 `pool: 'forks' + singleFork: true` 串行跑
（better-sqlite3 是原生模块）；SDK 用 `jsdom` 环境；`tests/helpers.ts` 给每个用例新建
`:memory:` 库。

### Q10.2 33 条数据链路断言怎么保证「真」？

`verify-pipeline.ts` 在 `os.tmpdir()` 建独立的 `e2e.db`，起一个真的 `http.createServer`
托管 SDK 产物、真的 `collector.listen({port:0})`、真的 Playwright Chromium 页面注入 SDK，
然后 `fetch` 打管理 API 校验。覆盖：五类错误落库、去重后 5 条/累计 6 次、
resolve → 回归 → 同版本噪音、活动流、sourcemap 还原回 `src/user-profile.ts:1`、
URL token 脱敏、无递归、LCP P95、错误带 vitals、告警去重、beacon 卸载送达、
回放流含全量快照且排在增量之前、行为汇总一致。

**为什么用独立临时库**：不能让 CI 里 seed 出来的演示数据污染断言。
这也是「`seed:demo` 可以排在 `slo:gate` 之后但必须在闸门之前」而不影响 `verify` 的原因。

### Q10.3 57 条面板断言怎么保证可重复？

`verify-dashboard.mjs` **自带播种**：自己建「验证演示项目」、轮换密钥、造 2 环境 2 版本、
6+3+1+4+1 条 issue、9 条性能事务、2 条告警规则 + 投递探针、2 条 SLO、行为与回放流。
用 `page.addInitScript` 往 localStorage 注入 `vigil.projectId`，让面板一上来就选中被断言的项目，
不依赖库里项目的顺序。

**两个容易翻车的点**：
- E2E 的接口查询**必须用同一个时间窗口**（默认 7 天，右端放宽 1 小时），
  拿全量去比窗口，断言必然对不上；
- 「投递探针」**每次都跑**，不能放在「建规则」的 if 里 —— 第二次跑 e2e 时规则已存在，
  探针不跑，死信断言就空了。

### Q10.4 五个闸门分别防什么？（**建议整段背下来**）

| 闸门 | 防的静默退化 | 手段 |
|---|---|---|
| `audit:ui` 15 条 | 界面回归（字号、溢出、可访问性） | 真 Chromium + `getComputedStyle` |
| `audit:plans` 1 条 | 热查询退化成全表扫描 | `app.inject()` 插桩取真实 SQL → 库副本放大到 2 万行 → `EXPLAIN QUERY PLAN` |
| `audit:ingest` 6 条 | 批量写退化成逐条提交 / 每事件多一次往返 | spy Db + 底层句柄数 COMMIT + 差值法 |
| `audit:scope` 1 条 | 漏租户范围导致串数据 | 从库结构读租户列 → 打 41 条接口 → 扫描每条 SQL |
| `audit:publish` 1 条 | 包发出去才发现的错（.d.ts 引用私有包、依赖位置、tarball 含 .map、缺 publishConfig） | `npm pack --dry-run --json` 的真实清单 |

**共同点**：它们盯的都是「**不会让任何单测挂、不会报错、只有线上才看得出来**」的问题。

### Q10.5 为什么闸门之前没进 CI？补的时候踩了什么？

**真因不是忘了挂，是挂上去会立刻红**：`audit:plans` / `audit:scope` 依赖 `data/vigil.db` 里的真实数据
（前者要把增长表放大到 2 万行，后者要打真实写接口），干净 runner 上 `data/` 都不存在。
现在 `ci` job 先 `npm run seed:demo -- --reset` 再跑这两个闸门。

**顺序坑**：`seed:demo` 里有**一条预算烧完的 SLO**（为了让面板能演示两种状态），
如果排在 `slo:gate -- --all` 之前，发布闸门会按「预算耗尽」退出 1，把 CI 无端染红。
所以顺序必须是 `slo:gate` → `seed:demo` → `audit:plans` → `audit:scope`。

**补完清单立刻抓到 11 处 offender**：3 处是真越权写法（`UPDATE/DELETE teams|members WHERE id = ?`），
8 处是结构上不可能串数据的 SELECT（按主键解析租户归属 / 主键点查单行 / JOIN 关联范围），
按精确规则豁免并**逐条打印理由**，写操作一律不豁免。

### Q10.6 CI 两个 job 为什么这么切？

`ci` job：typecheck → lint → test → `audit:ingest` → 构建 SDK → `audit:publish` →
`slo:gate` 冒烟 → seed → `audit:plans` → `audit:scope` → 装 Chromium → `verify`（33 条）。
`dashboard` job：构建面板与采集服务 → 装 Chromium → **同一个 step** 里起 collector + `vite preview` +
`wait-for.mjs` + 57 条断言 + `audit:ui` 15 条。

**为什么必须同一个 step**：GitHub Actions 每个 `run` 块是独立 shell，
块结束时里面用 `&` 起的后台进程会被杀掉。
**为什么跑 preview 不跑 dev server**：e2e 要验的是生产构建产物，两者不是一回事。

### Q10.7 发布准备闸门为什么用 `npm pack --dry-run`？

因为它查的是「**本地 workspace 永远看不出来**」的错：
`.d.ts` 里 `from '@vigil/protocol'` 引用了一个标 `private: true` 的包 ——
本地是 workspace 软链，TS 能找到；消费者装不到就直接报「找不到模块」。
另外查 `dependencies` 里挂了已被打进产物的库（白白让消费者多装几百 KB）、
tarball 混进 `.map`、作用域包没写 `publishConfig.access: public`、缺 package.json/README、体积 > 800KB。

**会追问**：「子路径导出怎么处理？」→ `@vigil/sdk/replay` 是包自己的入口，
判断「引用不可发布包」时要排除 `包名` 与 `包名/` 前缀。

### Q10.8 「断言要有鉴别力」是什么意思？

一条永远通过的断言等于没有。项目的做法是：
- 加索引前先确认「去掉索引这条断言会挂」（`migrate.test.ts` 用 EXPLAIN 正反断言）；
- `VIGIL_INGEST_BUDGET=3` 故意把预算调低，看摄入闸门真的变红；
- 租户隔离的豁免必须打印条数与理由，不许静默放过；
- 告警「投递探针」每次都跑，避免第二次 e2e 断言空转。

---

## 11. 部署与线上

### Q11.1 生产拓扑是什么？

宿主机 **Caddy**（TLS / Let's Encrypt / 反代到 `127.0.0.1:8080`）
→ 容器 **nginx**（dashboard 镜像，静态资源 + SPA 回退 + `/api` 反代 + Basic Auth + token 注入 + 三通道）
→ 容器 **collector**（不暴露宿主机端口，只在 compose 网络内 `expose: 4318`）
→ 容器 **PostgreSQL 16**。

只有一个对外入口，采集服务不占宿主机端口 —— 两套入口等于两份攻击面，
而且管理接口会只剩一个 token 挡着。

### Q11.2 为什么服务器「只拉不编译」？

生产机 **1.6GB 内存**，`vite + tsc + node-gyp` 同时编译会把它压到 sshd 都无响应
（真实发生过一次，最后从控制台强制重启）。所以 `.github/workflows/images.yml` 用 matrix
构建两个 target 推 GHCR（`main` + short sha 两个 tag），服务器只
`git pull && docker compose pull && docker compose up -d`。
本地要自编才叠加 `-f docker-compose.build.yml up --build`，这个文件**不带到服务器**。

### Q11.3 `/api/health` 和 `/api/ready` 为什么分开？

`health` 只返回 `{ok:true}`，**不碰数据库** —— 数据库挂了不该让编排重启进程
（重启也修不好 PG）。`ready` 真的 `SELECT 1`，compose 的 healthcheck 用它判定依赖顺序：
PG healthy → collector healthy → dashboard 起。

### Q11.4 nginx 启动脚本 30 / 40 / 50 各干什么？

| 脚本 | 职责 | 坑 |
|---|---|---|
| `30-vigil-subst.sh` | 自己渲染 `vigil-proxy.conf` | `envsubst` 的替换列表**只写 `${VIGIL_ADMIN_TOKEN}`**，否则 `$host` / `$uri` / `$vigil_collector` 会被抽成空串 |
| `40-vigil-auth.sh` | 有面板密码就生成 `.htpasswd`，没有就写一个**空文件**表达「不启用」 | `chown root:nginx` + `chmod 640`；600/root 会「不带凭据 401、带凭据 500」 |
| `50-vigil-demo-config.sh` | 把演示令牌写进 `/config.js` | 没设令牌写空串，前端按「无演示模式」处理 |

模板里**不能写 `${VAR:+word}`** —— 那是 shell 语法，envsubst 不认，nginx 会启动失败。
`vigil-proxy.conf` 用 `resolver 127.0.0.11` + 变量形式的 `proxy_pass`：
nginx 对字面量 host 只在加载时解析一次 DNS，容器重建换 IP 后会一直 502。
Dockerfile 还要 `sed -i 's/\r$//'` 清 CRLF —— Windows checkout 的 `#!/bin/sh\r` 跑不起来。

### Q11.5 线上验收怎么做的？

三容器 healthy；`smoke-deploy.mjs` 5/5（面板 200、未登录管理接口 401、注入 token 后管理接口 200、
SDK 产物可下载且含 `Vigil`、上报通道要求项目密钥）；
`smoke-public-demo.sh` 6/6（面板外壳 200、`/config.js` 200、A 通道 200 且 `/me` 是 member、
B 通道 401、演示令牌建项目 403）；面板 e2e 57/57；管理员 `/me` 返回 `superadmin`。
还直接在生产镜像里调过 `slugify('线上应用') → xian-shang-ying-yong`，确认新代码真的上线了。

### Q11.6 k8s 清单能讲吗？

**要主动说「未实跑」**。`deploy/k8s/` 有 namespace / postgres StatefulSet / collector Deployment /
dashboard + Ingress / 2 HPA + 2 PDB，但 `docs/deploy.md` 明写两处已知问题：
1. 面板 nginx 以 root 启动并监听 80，而 `30-dashboard.yaml` 写了 `runAsUser: 10001` +
   `drop: ['ALL']`，容器根本起不来；
2. 面板清单没给 `VIGIL_ADMIN_TOKEN`，每个请求都会 401。

另外 PG 是**单副本 StatefulSet**，是单点；HPA 的上限刻意压得比采集服务低
（collector 2–6 / dashboard 2–4），避免面板扩容把采集服务压垮。
历史坑：早期 Deployment 写 `replicas: 2` 却挂 RWO 卷 + 用 SQLite，
滚动更新时新 Pod 拿不到卷会卡住 —— 换 PG 之后采集服务无状态，HPA 才成立。

---

## 12. SQL 与数据库：最可能被问穿的一节

> 这一节单独列，因为项目里有大量手写 SQL，而**手写 ≠ 讲得清**。
> 面试官只要沿着任意一条 SQL 问三层，就能区分「我写的」和「我生成的」。
> 不要求你成为 DBA，但下面这些必须能不用纸笔讲明白。

### 12.1 必须能手写出来的 8 条 SQL

1. **聚合 UPSERT**：
   `INSERT INTO issues (...) VALUES (...) ON CONFLICT (project_id, fingerprint) DO UPDATE SET count = count + 1`
2. **写入兼查重**：`INSERT INTO issue_events (...) VALUES (...) ON CONFLICT (project_id, event_id) DO NOTHING`
3. **配额计数**：`INSERT INTO project_usage (project_id, events_total) VALUES (?, ?)
   ON CONFLICT (project_id) DO UPDATE SET events_total = project_usage.events_total + excluded.events_total`
4. **窗口内的问题列表**（带优先级排序 + 稳定分页）：
   `SELECT ... WHERE project_id = ? AND last_seen >= ? AND first_seen < ?
    ORDER BY <LN/EXP 表达式> DESC, id DESC LIMIT ? OFFSET ?`
5. **CTE 先限定 issue 集合再聚合窗口次数**：`WITH scope AS (...), wc AS (...) SELECT ... INNER JOIN wc`
6. **分批删除**：`DELETE FROM replay_events WHERE id IN (SELECT id FROM replay_events WHERE ... LIMIT ?)`
7. **错误率趋势**：按 `bucketExpr(occurred_at, bucketMs, tzOffset)` 分组，分子事件数 / 分母事务数，
   分母 0 → `NULL`
8. **跨表关联查成员凭据**：`SELECT ... FROM member_keys k JOIN members m ON ... WHERE k.key_hash = ?`

### 12.2 必须能讲清的 12 个概念

| 概念 | 你要能说的一句话 |
|---|---|
| 复合索引最左前缀 | `(project_id, occurred_at)` 能服务「按项目 + 时间范围」，但只给 `occurred_at` 用不上首列 |
| 覆盖索引 | 索引里就有所需列时不必回表（`USING COVERING INDEX`），闸门判 `SCAN` 时把它当豁免条件 |
| `EXPLAIN QUERY PLAN` | 看的是优化器选的访问路径，不是执行耗时；必须在**足够大的表**上看 |
| `SCAN` vs `SEARCH` | SCAN 是全表扫，SEARCH 走索引；`TEMP B-TREE` 说明排序没走索引 |
| UPSERT / `excluded` | PG 里 `excluded` 指本次要插入但因冲突改走 UPDATE 的那一行 |
| CTE | 这里用来先缩小 issue 集合，避免在全量事件上聚合；不是「为了炫技」 |
| 事务 ACID 与隔离级别 | 重点是原子性：一批事件要么整体提交，坏事件靠 SAVEPOINT 局部回滚 |
| SAVEPOINT | 嵌套回滚点；PG 里一条语句报错会中止整个事务，必须 `ROLLBACK TO` 才能继续 |
| WAL | SQLite 的 `journal_mode = WAL` 让读写并发；逐条提交就是反复追加 WAL（实测 20 条 4.3ms → 整批 1.1ms） |
| 外键级联 | SQLite 默认不开启外键，必须显式 `PRAGMA foreign_keys = ON`，否则 `ON DELETE CASCADE` 一条都不触发 |
| 深分页 | `OFFSET` 越大越慢；这里靠 `LIMIT ≤ 200` + 次级排序 `id` 兜底，没有做游标分页（**可以承认是限制**） |
| `COUNT(*)` 成本 | 随行数线性增长，所以配额用计数表；PG 的 `COUNT(*)` 返回 bigint 字符串要 `Number()` |

### 12.3 一条 SQL 被连问五层（演练）

> **Q**：这条查询为什么这样写？
> → 因为要按项目 + 时间窗口取问题，条件首列是 `project_id`。
> **Q**：索引怎么建？
> → `(project_id, last_seen)`，兼顾租户范围与最近排序；优先级排序另有 `LN/EXP` 表达式。
> **Q**：数据涨到百万行还行吗？
> → 列表有 LIMIT 与窗口预过滤，但优先级是表达式排序、用不上索引，会退化为「范围内排序」；
>    真到百万行要物化优先级分或改排序模型。**现在没做，也没压测数据。**
> **Q**：怎么证明它现在没退化？
> → `audit:plans` 把库放大到 2 万行后跑 `EXPLAIN`，扫增长表上的 `SCAN` 就红。
> **Q**：2 万行够吗？
> → 不够代表生产规模，它只能挡住「明显缺索引」；量级验证要做压测，这是项目的已知缺口。

### 12.4 不会的时候怎么答（**别硬编**）

模板：**「这个我没有实测 / 没实现，但边界我能说清，而且我知道该用什么方法验证」**。
例：「PG 的锁粒度我没有在生产上验证过；这个项目里我通过 `SAVEPOINT` 和 `ON CONFLICT`
避免显式加锁，事务边界靠 `AsyncLocalStorage` 保证连接归属。要真验证得用并发压测 + `pg_locks` 观察。」
诚实 + 边界 + 验证路径，比编一个答案安全得多。

---

## 13. 前端原理：别主动引战，但必须兜得住

> 这一节的策略是**不主动展开、被问到不露怯**。别在自我介绍里说「精通 Vue 原理」。

| 可能被问 | 最小可答 | 别多做 |
|---|---|---|
| Vue 3 响应式怎么实现 | `reactive` 用 **Proxy** 拦截 get/set 收集依赖与触发更新；`ref` 是带 `.value` 的包装；不是 `Object.defineProperty`（那是 Vue 2） | 别去讲 `effect` 调度细节，除非真读过源码 |
| `computed` / `watch` 区别 | computed 有缓存、惰性求值、是派生值；watch 是副作用，响应变化去干活 | — |
| `nextTick` | 等本轮 DOM 更新队列刷新后再执行，批量更新避免重复渲染 | — |
| `provide/inject` | 跨层级共享，面板用它传项目上下文 / 时间范围 / 刷新令牌；不是全局状态管理 | 别顺口说「就是 Pinia」 |
| Vite 代理 | dev/preview 用 `server.proxy` 把 `/api` 转到 4318，并在 `configure` 里注入 token | — |
| CSS 层叠与特异度 | 项目里有真实案例：窄屏规则必须和桌面规则**特异度相同**才生效（0,3,0 vs 0,2,0） | 别主动谈 BFC / 层叠上下文 |
| 为什么不用 Tailwind | 用了 `theme.css` 的 CSS 变量 token（字阶 / 间距 / 动效 / 焦点环）统一控制，便于闸门用 `getComputedStyle` 量 | 别评价框架优劣 |
| React 熟吗 | 不熟，主用 Vue 3；这个项目的架构层是框架无关的（状态机、协议、闸门、双库都在 collector/SDK），换框架不影响 | 别说「React 差不多」 |

---

## 14. 高频追问链（每条五层，自己演练一遍）

### 链 A：指纹（最常走到底）
1. 错误怎么聚合成一条 Issue？→ 客户端 `computeFingerprint`，三路分类 + 前 3 帧 + 双哈希。
2. 为什么不把行号算进去？→ 改一行代码不该让历史断掉。
3. 客户端算的能信吗？空串会怎样？→ 不能全信，空串会让所有错误塌成一行；协议要求服务端校验兜底，**但当前实现没补上**（第 16 节）。
4. 哈希碰撞怎么办？→ 64 位（两个 32 位拼接）用于分组不是防篡改；真碰撞会把两类错误并成一条，代价可接受，但要有可观测手段（目前没有，是缺口）。
5. 如果让你重做，指纹放客户端还是服务端？→ 仍放客户端（它有完整栈），但服务端必须校验格式并对缺失/非法值兜底生成，同时保留「同类错误跨版本稳定」的归一规则。

### 链 B：摄入性能
1. 一条错误要跑几条 SQL？→ 稳态预算 3 次。
2. 为什么第 2 条能兼查重？→ `ON CONFLICT DO NOTHING`，`changes = 0` 就是重复上报。
3. 一批 20 条为什么不能逐条提交？→ PG 上 20 次网络往返；实测 4.3ms → 1.1ms。
4. 那为什么还要 SAVEPOINT？→ PG 一条语句失败会中止整个事务，一条坏事件会带走另外 19 条。
5. 怎么防止以后有人把预算悄悄加回去？→ `audit:ingest` 6 条判据挂 CI，且故意调低预算验证闸门会红。

### 链 C：多租户
1. 怎么防止看到别的项目数据？→ 鉴权层解析目标组织 + 跨组织 403。
2. 只靠鉴权够吗？→ 不够，调用链会漏；每条 SQL 自带 `project_id` / `organization_id`。
3. 怎么保证新接口不漏？→ 闸门从库结构自动读租户列、打 41 条接口、扫每条 SQL。
4. 有些 SELECT 天生没有范围怎么办？→ 三类结构豁免（解析归属 / 主键点查 / JOIN 关联范围），逐条打印理由；**写操作一律不豁免**。
5. 补清单时抓到什么？→ 3 处 `UPDATE/DELETE teams|members WHERE id = ?`，和 v0.2 修过的告警规则是同一个毛病。

### 链 D：回放
1. 回放怎么存的？→ 挂在错误事件上随错误上报，服务端按会话只存最新一份流。
2. 为什么不每次全量覆盖？→ 3000 事件第 5 次上报要删 3000 + 插 3000，O(n²)。
3. 怎么判断是同一条链？→ 第 0 条全量快照的时间戳；相同只追加尾部，不同整链作废。
4. 为什么不能用 seq 去重？→ 会拼出「新快照 + 旧增量」的混合流，播放器不报错只是画面全乱。
5. 缓冲区满了怎么办？→ 整体作废、重新取全量快照；**不能丢中间段**，且保留 Meta（视口尺寸）。

### 链 E：CI / 部署
1. 闸门挂 CI 了吗？→ 五个全挂，ci job 四个 + dashboard job 一个。
2. 之前为什么没挂？→ 依赖演示库，干净 runner 跑不起来会立刻红，于是被搁置。
3. 补的时候顺序有什么讲究？→ seed 必须在 `slo:gate` 之后，否则种子里预算烧完的 SLO 会把 CI 染红。
4. 面板 e2e 为什么服务要同 step？→ 每个 `run` 块结束会杀掉 `&` 起的后台进程。
5. 服务器为什么不 build？→ 1.6GB 内存，编译把 sshd 压到无响应；CI 推 GHCR，服务器只 pull。

---

## 15. 送命题与诚实边界

> 原则：**主动承认边界比被翻出来好十倍**。这些题的答案都写在仓库里，
> 面试官点两下就能验证。下面给的是「怎么说」而不是「怎么圆」。

| # | 送命题 | 推荐答法 |
|---|---|---|
| 15.1 | 有真实用户 / 真实流量吗？ | 没有。线上是演示数据 + 合成放大数据，见 Q1.6。**不要说「有」** |
| 15.2 | 压测过吗？QPS 多少？ | 没做过 QPS 压测。验证的是查询计划（2 万行看 EXPLAIN）和摄入预算（差值法量往返/提交），两者都不等于压测 |
| 15.3 | 300 个 commit 是你一个人写的？ | GitHub 仓库 10-27 创建、远端约 300 次提交，单人；本地这份是 shallow clone 只有 13 个。**commit 数不是能力证明，别拿它当亮点** |
| 15.4 | 43KB / 279KB 怎么测的？ | 是文档陈述值，仓库里没有 `dist/` 可实测；源码注释里另有一套「260KB / gzip 约 80KB」的口径，**三套数字没对齐，这是文档债**（第 16 节） |
| 15.5 | 服务端有脱敏兜底吗？ | 注释写了「老 SDK 兜一层」，但 collector/src 里没有实现，实际脱敏全在 SDK 侧。**这是我要补的洞** |
| 15.6 | 指纹格式服务端校验了吗？ | `AGENTS.md` 第 6 条和测试夹具注释声称有 `isValidFingerprint`，但当前源码里没有。空串指纹会让该项目所有错误塌成一行，是真实风险 |
| 15.7 | SLO 真的挡住过发布吗？ | 没有。CI 只有空库冒烟，保证脚本不烂；README 明写「别把冒烟通过当成发布被守住」 |
| 15.8 | 多副本 / k8s 跑过吗？ | compose 三容器在生产实跑；k8s 清单**未实跑**，且有两处已知问题；PG 单副本是单点 |
| 15.9 | Sentry 的 grouping 算法具体怎么做？ | 不知道细节，只了解大致思路（栈帧 + 类型 + 消息归一化 + 可配置规则）。**别硬编** |
| 15.10 | npm 包发布了吗？ | 没有。发布准备闸门全绿，缺的是 npm 账号与 token |
| 15.11 | 这些代码都是你写的吗？ | 用了 AI 辅助编码，但决策与验证链是我的，见 Q1.5。**别否认，也别把「AI 写的」说成「我手写」** |
| 15.12 | 你才大二，能实习多久？为什么现在投？ | 如实说可实习的时间窗口，并说明现在投是为了拿到真实面试反馈、校准方向；**被拒更可能是时间窗口而不是项目质量**，别把它归因到项目上 |
| 15.13 | 简历数字和仓库对得上吗？ | 对得上（337 / 90 / 24 / 31+39 / 72 路由），但 `AGENTS.md` 里还留着旧数字 273 / 50 / 2，README 是最新口径。被问到就直说「那份是给开发看的约定文件，没同步」 |

**通用兜底句式**：
> 「这个我没做 / 没验证，边界是 ___。如果要做，我会用 ___ 验证，代价是 ___。」

---

## 16. 已知口径不一致清单（先处理再面试）

> 这些是**文档比实现写得满**或**多份文档互相打架**的地方。
> 面试官点开源码就能发现，与其等他问，不如自己先说。
> 按「风险」排序，前三条建议动手修掉或至少在面试前想清楚说法。

| # | 不一致 | 证据 | 建议动作 / 面试说法 |
|---|---|---|---|
| 1 | **服务端脱敏兜底不存在** | `pipeline.ts:26` 注释写「SDK 已脱敏，这里再兜一层底」；`collector/src` 全目录 grep 无 `mask/scrub/sanitize/redact` | 要么补实现，要么删注释。面试说法：「脱敏在采集端，服务端兜底只有注释没有实现，我记下来了」 |
| 2 | **指纹校验 / 兜底不存在** | `AGENTS.md:147-153` 写 `ingest.ts` 有 `isValidFingerprint`；`tests/helpers.ts:96-99` 注释说 collector 会校验；`collector/src` 无匹配 | 补 `isValidFingerprint` + 非法时服务端兜底生成，或修正文档。这是**真安全/正确性风险**，优先级最高 |
| 3 | **DB 往返数三套口径** | README/闸门 = 3；`sourcemap.ts:72-75` 与 `sourcemap-cache.test.ts:9` = 5；`issues/service.ts:154` 的「25%」对应 4→3 | 统一表述为「稳态预算 3 次，闸门量随条数增长的增量」；把其余注释改成「早期 5 次」的历史口径 |
| 4 | **SDK 体积三套数字** | README `43KB / 279KB / 74KB gzip`；`sdk/README.md` `43 / 279 / 75KB`；源码注释 `rrweb 260KB / gzip≈80KB / 核心 13KB→90KB+`；仓库无 `dist/` 可实测 | 构建一次量真实产物，统一到一处；面试别把体积当硬指标吹 |
| 5 | **`AGENTS.md` 数字过时** | `AGENTS.md:39,41,478,480,483` = 273 单测 / 50 或 55 面板断言 / 2 条摄入判据；README = 337 / 57 / 6 | 同步数字；顺手清掉 `AGENTS.md:769-770` 重复的「调预算」段落 |
| 6 | **角色名漂移** | `protocol/src/tenancy.ts:13` `ProjectRole = 'owner' \| 'writer' \| 'reader'`；collector 全程用 `editor`（`app.ts:476`、`authz/service.ts:195`） | 以 collector 的 `editor` 为准修协议；面试被问就说「协议与实现命名漂移，还没同步」 |
| 7 | **SDK README 示例不可用** | `packages/sdk/README.md:40-42` 用 `initReplay`，实际导出是 `replayPlugin / behaviorPlugin`；`src/vue.ts:27` 示例 `client.report` 也不存在（内部是 `handleReport`） | 改示例，最好加一条闸门断言「README 代码块里的导出名真实存在」 |
| 8 | **状态模型表述** | README 生命周期图把 `new / ongoing / resolved / archived / regressed / escalating` 画成并列状态；源码是 `status`（3）× `substatus`（4）两层 | 改图为两层；面试按两层讲，见 Q5.1 |
| 9 | **规模数字过时** | `app.ts:1482-1484` 注释写「40 多个路由」，实际 72 条 method 路由；README 写「11 个领域」，`domains/` 有 12 个目录（含 authz） | 统一成「72 条路由 / 12 个模块」；简历别用「40+」这种旧数 |

**为什么把这些写进公开文档**：一个会自己找出「文档与实现不一致」并列出修复优先级的人，
比一个把 README 背得滚瓜烂熟的人更像工程师。这 9 条本身就是可讲的内容。

---

## 17. 反问面试官（按岗位挑 2–3 条）

**通用（最稳）**
1. 团队现在最痛的是「线上问题发现得太晚」还是「发现之后定位太慢」？监控平台在你们的分工里归谁维护？
2. 如果我进来，前三个月您希望我先把哪一块做扎实？（把话题从「我会什么」转到「岗位要什么」）
3. 你们怎么衡量一个前端改动「没把页面搞慢」？有没有类似 SLO / 预算的机制？

**偏前端 / 前端工程**
- 前端产物体积、首屏性能有没有门禁？超预算是阻断发布还是只告警？
- 组件库是按需引入还是全量？设计 token 怎么和视觉规范同步？

**偏后端 / 平台**
- 多租户隔离是靠调用链约定还是靠 SQL / 网关强制？有没有自动审计？
- 数据库 schema 变更怎么走？有没有「闸门」类的自动检查？

**实习 / 校招**
- 实习生有没有机会跟一次完整的线上发布？回滚流程是怎样的？
- 团队对「用 AI 辅助写代码」的态度和规范是什么？

---

## 18. 自检清单（考前逐条打勾）

**能讲清架构**
- [ ] 四个包各自交付什么、为什么 protocol 零运行时
- [ ] 为什么模块化单体、什么条件下该拆
- [ ] 三条上报通道为什么分开、第四条 sourcemaps 为什么独立密钥
- [ ] 双库切换点在哪、四条 SQLite 独有写法分别换成什么
- [ ] 一个对外入口的拓扑、collector 为什么不暴露端口

**能手写 / 能讲算法**
- [ ] 指纹三路分类 + 三条设计准则 + 为什么哈希必须同步
- [ ] 脱敏词段匹配与四条正则的顺序
- [ ] 栈解析的懒惰匹配为什么不会拆错 `http://`
- [ ] 状态机两层模型 + `isNewerVersion` 为什么不能字符串比较
- [ ] `applyReplayEvent` 三条规则 + rrweb 事件编号
- [ ] 8 条 SQL（第 12.1 节）能不看文档写出来

**能讲清工程决策**
- [ ] 3 次往返分别是哪三条、为什么第 2 条兼查重
- [ ] 批事务 + SAVEPOINT 为什么两个都要
- [ ] 配额计数表为什么单调递增
- [ ] 限流为什么按项目、令牌桶的已知限制
- [ ] `last_seen` 为什么用 MAX
- [ ] 累计口径与窗口口径差在哪、错误率分母 0 为什么是 null
- [ ] 时区桶的符号为什么不能反
- [ ] 五类闸门各自防什么、共同点是什么

**能讲清安全与权限**
- [ ] `requiredAction` 集中规则的四条分支
- [ ] admin token 优先级的真实故障场景
- [ ] 审计为什么不记 body
- [ ] 纵深防御与 3 处 `WHERE id = ?` 真 bug
- [ ] nginx 三通道的 map / 418 / named location 三个点
- [ ] 行为不记录输入内容、rrweb 的 mask 配置

**能讲清验证与上线**
- [ ] 337 / 90 / 24 怎么拆、各自跑什么
- [ ] 闸门为什么之前没进 CI、seed 顺序坑
- [ ] 同 step 起服务的原因、preview 不是 dev server
- [ ] 1.6GB 不 build、GHCR 两个 target
- [ ] 30/40/50 三个启动脚本与 envsubst 过滤
- [ ] 线上验收 5/5、6/6、57/57 分别测什么

**诚实边界（不许含糊）**
- [ ] 没有真实流量、没有 QPS 压测
- [ ] k8s 未实跑、PG 单副本单点
- [ ] SLO 没接进真实发布流水线
- [ ] 服务端脱敏兜底 / 指纹校验没实现
- [ ] SDK 体积数字三套口径、仓库无 dist 实测
- [ ] 用了 AI 辅助，决策与验证链是自己的
- [ ] 大二，能实习多久如实说

**临场**
- [ ] 30 秒 / 2 分钟 / 5 分钟三个版本各背一遍
- [ ] 五条追问链（第 14 节）各走一遍
- [ ] 三条「我不知道，但边界是…」的兜底句式
- [ ] 准备 2 个反问
- [ ] 把仓库链接和在线 Demo 链接放进简历，且**确认 Demo 当天能打开**

---

## 19. 一页速背（考前 10 分钟）

**10 句话**
1. 四个包：纯类型协议 / 零框架 SDK / 模块化单体 collector / Vue 3 面板。
2. 三条上报通道分开：错误全量、性能 10% 采样、回放体积大两个数量级。
3. Issue 不是日志是工单：状态 + 子状态两层，状态流转由纯函数算。
4. Resolve with Release：在 1.4.3 修好，只有 1.4.4+ 再出现才叫回归。
5. 指纹用 category 不用 kind，不含行列号、剥构建 hash，客户端同步算。
6. 聚合靠 `UNIQUE(project_id, fingerprint)`，`ON CONFLICT DO NOTHING` 让写入兼查重。
7. 一批 20 条 = 一个事务 + 每条一个 SAVEPOINT，稳态每条 3 次 DB 往返。
8. 一套领域代码跑 SQLite 与 PG：方言层生成 DDL，适配器把 `?` 翻成 `$1`，PGlite 做真 PG 测试。
9. 五个闸门防的都是「不会让单测挂、不报错」的静默退化，全部挂在 CI 双 job。
10. CI 推 GHCR、服务器只 pull；nginx 三通道让访客免登录看只读 Demo。

**5 个数字**：337 单测 · 90 端到端断言 · 24 条闸门判据 · 31 表 / 39 索引 · 72 条路由。

**3 个真坑**（讲出来比讲功能加分）
- 去重 ID 漏了 release → 回归检测被绕过，只在同毫秒触发、假失败指向状态机。
- v1/v2 同名的 `sourcemaps` 表 + `CREATE TABLE IF NOT EXISTS` → 只有升级的生产库挂，本地全绿。
- PG 事务借了 client 发 BEGIN、语句却走 `pool.query` → 事务形同虚设，PGlite 单连接测不出来。

**3 句诚实边界**
- 没有真实业务流量，演示数据 + 2 万行合成放大，不是压测。
- k8s 未实跑、PG 单副本是单点；SLO 只做空库冒烟，挡不住发布。
- 用了 AI 辅助编码；脱敏兜底与指纹校验还停留在注释里，我知道这是洞。

**最后一句**
> 面试官问的不是「你做了多少功能」，是「哪一处是你自己权衡过的」。
> 挑一个坑，讲清「当时怎么错的 → 怎么发现的 → 现在靠什么守住」，比列十个功能有用。

---