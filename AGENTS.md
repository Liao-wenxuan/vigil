# AGENTS.md

> 面向 AI 编码代理与新同事的项目约定。改代码前先读这一份。

## 项目是什么

**Vigil** —— 多应用可接入的前端错误监控平台。

浏览器 SDK 采集 → 采集服务接收 → 按指纹聚合 → sourcemap 还原压缩栈 → 管理 API 查询。

当前范围：**L1 错误监控**（JS 错误 / Promise 拒绝 / 资源加载失败 / 接口错误 / Vue 组件错误）。
性能 RUM、会话回放、告警都还没做，不要以为它们已经存在。

## 仓库位置

```
D:\my\vigil
```

## 常用命令

```bash
npm install
npm run typecheck    # tsc --noEmit，两个包
npm run lint         # eslint
npm run test         # vitest，105 条
npm run verify       # 端到端闭环验证，14 条断言（会先构建 SDK）
npm run build        # 构建 SDK 产物
npm run dev:collector # 启动采集服务，:4318

# 注册应用（拿 appId / token / uploadToken）
npm --prefix packages/collector run app:create -- create "应用名"
```

**验证一律用数字，不看截图。** `npm run verify` 的输出全是计数和尺寸。

## 包结构

| 包 | 说明 | 关键约束 |
|---|---|---|
| `packages/protocol` | 上报协议类型契约 | **纯类型，零运行时**。只有 `import type` 能从它导入 |
| `packages/sdk` | 浏览器采集 SDK | 无框架依赖。Vue 适配器单独一个入口 `src/vue.ts` |
| `packages/collector` | 采集服务 | Fastify + better-sqlite3。ESM，NodeNext，相对导入**必须带 `.js` 后缀** |

## 不能破坏的不变量

这几条一旦破坏，系统的核心价值就没了。改代码前先确认没碰它们。

### 1. 指纹不含行号列号，也不含构建 hash

改一行代码不该让错误的「历史」断掉；每次发版也不该让所有错误都变成新的。

`computeFingerprint` 里 `stripBuildHash` 把 `index-DnB3xK2l.js` 归一成 `index.js`，
指纹只由 `错误名 + 前三帧的函数名与文件名` 决定。

**加了行号或 hash 进指纹 = 每发一次版监控历史全部清零。**

### 2. 分组用 category，不是 kind

`ErrorKind`（js/promise/vue/manual）只说明「谁抓到的」。
Vue 捕获和全局捕获到同一个错误必须是**同一条**。

### 3. 聚合靠数据库 UNIQUE 约束，不靠应用层先查再插

`errors` 表有 `UNIQUE (app_id, fingerprint)`，写入走 UPSERT。
改成「先 SELECT 再 INSERT」在并发下必然出重复行。

### 4. 两个 token 严格分离

- `token`（运行时）：进前端代码，用于上报
- `uploadToken`（上传）：只在 CI 里，用于传 sourcemap

**绝不能互换。** 运行时 token 在前端代码里，谁拿到它都能上报垃圾数据；
拿到上传 token 就能污染别人应用的错误栈。

数据库里**只存哈希**，明文只在创建时返回一次。

### 5. sourcemap 不进静态资源目录

浏览器能下载到的文件，攻击者也能下载到 —— sourcemap 等于公开源码。
map 只上传到 Collector，服务端还原后只把「原始位置」写进数据库。

### 6. 脱敏在采集端做，不在服务端

敏感键按**词段**匹配而非子串：`userPassword` 命中，`monkey` / `statusCode` 不命中。

`mask.ts` 里多条正则的**顺序有讲究**：`JSON_ASSIGN → AUTH → CREDENTIAL → ASSIGN`。
调换顺序会静默错掩（`Authorization: *** ***` —— 凭证反而留在后面）。
改这个文件前先读 `packages/sdk/tests/mask.test.ts`，那里有锁住行为的用例。

### 7. SDK 必须出两个产物

`dist/index.js`（ESM）+ `dist/index.iife.js`（IIFE）。

`<script type="module">` 默认 defer，ESM 接入会**漏掉首屏静态资源的失败**。
IIFE 放 `<head>` 同步初始化才能收到。改动 vite 配置时别把 IIFE 删了。

另外：**两次 vite 构建时只有第一个能 `emptyOutDir: true`**，否则第二个会把第一个的产物删掉。

### 8. 上报请求自身不能被当成错误

`collectors/network.ts` 的 `isCollectorUrl` 必须排除采集端点，
否则上报 → 触发拦截 → 再上报，无限循环，页面被自己的 SDK 打死。

## 验证

```bash
npm run test      # 105 条
npm run verify    # 14 条端到端断言
```

`npm run verify` 跑的是**真实链路**：真 Chromium → 真 SDK 产物 → 真 HTTP → 真 Collector → 真 SQLite → 真查询 API。

它依赖本机 Playwright 浏览器缓存；缓存里没有时会打印实际使用的可执行文件路径。

## 提交约定

- conventional commits，`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `ci`
- **每个 commit 一个原子改动**，docs 单独提交
- subject ≤ 50 字
- pre-commit 会跑 lint-staged（eslint --fix + prettier --write）

## 已知的坑

- **Playwright 期望的浏览器修订号可能和本机缓存对不上** —— 脚本会扫 `ms-playwright` 缓存回退，别改成直接下载
- **E2E 跳页前要等特定错误落库**，不能只等「凑够 N 条」—— 页面里的错误常由 `setTimeout` 触发，跳太快会误判成产品问题
- **sourcemap 的列号是 0-based，JS 栈的列号是 1-based** —— `sourcemap.ts` 里显式做了 `-1` / `+1` 转换，差一位不报错只是位置偏
- SQLite 默认**不开启**外键约束，`db.ts` 里显式 `pragma('foreign_keys = ON')`
