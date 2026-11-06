# 贡献指南

欢迎。这个项目是一个人做出来的，但代码结构按「多人协作」的标准来 ——
每个改动都能被独立验证、独立回滚。

## 先读这个

**[AGENTS.md](./AGENTS.md) 是这个仓库的技术约定**，里面记了 35 条不能破坏的不变量
（指纹口径、累计与窗口口径不能混、两种数据库的 SQL 差异、时间戳列类型、
租户范围怎么带、SLO 的分步判定……）。

改动之前扫一眼相关的那几条，比事后被 review 退回来快。

## 环境

```bash
npm ci                 # 装依赖（Node 22）
npm run demo            # 一键起：播种演示数据 + 采集服务 + 管理面板
```

| 地址 | |
|---|---|
| 管理面板 | http://localhost:5174 |
| 采集服务 | http://localhost:4318 |

服务是**脱离式进程**（`Start-Process`），不会因为关掉终端就停。
要停就找 `src/index.ts` 和 `vite` 的 node 进程。

## 改完要跑什么

按改动范围选，**全跑一遍**也就一两分钟：

```bash
npm run typecheck      # 类型
npm run lint           # 规范
npm run test           # 单元测试
npm run verify         # 端到端闭环（真 Chromium → 真 SDK 产物 → 真 HTTP → 真 SQLite）
npm run verify:dashboard   # 面板渲染断言
npm run audit:ui      # 界面设计闸门
npm run audit:plans   # 查询计划闸门（热查询必须走索引）
npm run audit:ingest  # 摄入往返预算闸门
npm run audit:scope   # 租户隔离闸门
npm run audit:publish # 发布准备闸门
```

闸门不是形式 —— 它们各自盯着一类**曾经真的出过事**的问题
（查询退化成全表扫描、租户范围漏了、去重键吃掉半个主体）。
改到相关的地方，闸门必须还是绿的。

## 提交约定

- conventional commits：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `ci`
- **每个 commit 一个原子改动**，docs 单独提交
- subject ≤ 50 字
- ⚠️ commitlint 拒绝 subject 里的全大写缩写（`README` / `AGENTS` / `E2E` 都会被拒）
- 提交前 husky 会跑 lint-staged（eslint --fix + prettier --write）

## 提 Issue

带上这几样能省掉一轮来回：

- 复现步骤（最好是能直接跑的命令）
- 你看到的现象 vs 期望的现象
- 相关接口的响应（注意脱敏：里面可能有 token）

## 提 PR

- 一个 PR 只做一件事
- 描述里写清楚「为什么」，不只是「改了什么」
- 带上对应的验证命令和它的输出

## 不要做的事

- 不要改 `packages/protocol` 的字段名而不升版本 —— 它是**线上契约**，
  SDK 与 Collector 两端要一起升。
- 不要在领域代码里写只对 SQLite 成立的 SQL —— 两库要都能跑，
  用 `infra/db/dialect.ts` 里的类型与表达式。
- 不要在指纹里加行号、列号或构建 hash —— 那会让同一个问题在每次发布后变成新问题。
- 不要把采集端脱敏挪到服务端 —— 脱敏必须在**上报前**做。
