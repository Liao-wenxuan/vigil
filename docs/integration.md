# 接入文档

## 1. 注册应用

```bash
npm --prefix packages/collector run app:create -- create "我的应用"
```

输出：

```
appId       app_xxxxxxxxxxxx
name        我的应用
token       vsk_xxxxxxxx...
uploadToken vup_xxxxxxxx...
```

⚠️ **两个 token 只显示这一次**，数据库里只存哈希。

| token | 用途 | 放在哪 |
|---|---|---|
| `token` | 上报错误 | 前端代码里（可公开） |
| `uploadToken` | 上传 sourcemap | **只在 CI 里**，绝不能进浏览器 |

两者严格分离：运行时 token 在前端代码里，谁拿到它都能上报垃圾数据；
拿到上传 token 就能上传任意 sourcemap 污染别人应用的错误栈。

---

## 2. 接入 SDK

### 方式 A：IIFE（推荐，能收到首屏资源错误）

```html
<head>
  <script src="https://cdn.example.com/vigil.iife.js"></script>
  <script>
    Vigil.init({
      endpoint: 'https://collector.example.com/api/v1/collect',
      appId: 'app_xxxxxxxxxxxx',
      token: 'vsk_xxxxxxxx...',
      release: '1.0.0',
      environment: 'production'
    })
  </script>
</head>
```

**为什么必须放 `<head>` 同步加载**：

`<script type="module">` 默认是 **defer** 的 —— SDK 的初始化一定发生在
HTML 解析完成之后。而首屏静态资源的失败（`<img src="404.png">`）
是在**解析过程中**就触发的。

用 ESM 接入，解析器一碰到 `<img>` 就发请求，失败事件在 module 执行前就触发完了，
SDK 根本没装监听器 → **一条都收不到**。

这是实测过的：同一个页面，IIFE 接入能抓到首屏图片 404，ESM 接入抓不到。

### 方式 B：ESM（bundler 项目）

```ts
import { init } from '@vigil/sdk'

const vigil = init({
  endpoint: 'https://collector.example.com/api/v1/collect',
  appId: 'app_xxxxxxxxxxxx',
  token: 'vsk_xxxxxxxx...',
  release: '1.0.0',
  environment: 'production'
})
```

ESM 接入下，动态加载的资源（用户上传的图片、懒加载 chunk）仍然能正常上报。

---

## 3. 完整配置项

```ts
Vigil.init({
  // ---- 必填 ----
  endpoint: 'https://collector.example.com/api/v1/collect',
  appId: 'app_xxxxxxxxxxxx',
  token: 'vsk_xxxxxxxx...',

  // ---- 可选 ----
  release: '1.0.0',          // 发布版本，用于定位「这个错误是哪个版本引入的」
  environment: 'production', // production / staging / development
  userId: 'u_123',          // 当前用户 ID

  sampleRate: 1,            // 会话采样率 0~1，默认全量
  maxBreadcrumbs: 30,       // 保留多少条操作轨迹
  flushIntervalMs: 5000,    // 定时上报间隔
  maxBatchSize: 20,         // 一批最多几条
  maxPayloadBytes: 49152,   // 单请求体上限（浏览器限制约 64KB）
  httpErrorPolicy: '5xx',   // 5xx | 4xx | all | none
  captureConsoleBreadcrumbs: true,
  debug: false
})
```

### `sampleRate` 是**按会话**采样的

不是每条事件随机抽。随机抽事件会得到「同一个用户只上报了部分错误」的残缺上下文，
比不采样更误导。整个会话要么全采要么全不采。

### `httpErrorPolicy` 默认只报 5xx

前端接口的 4xx 大多是**业务语义**不是故障：

- `400` 余额不足
- `409` 订单状态已变化
- `401` 登录过期

这些报进监控系统只会淹没真正的错误。默认把 5xx 和网络失败当错误，其余降级成面包屑。

---

## 4. Vue 集成

```ts
import { createApp } from 'vue'
import { init } from '@vigil/sdk'
import { installVueErrorHandler } from '@vigil/sdk/vue'

const vigil = init({ endpoint, appId, token, release })

const app = createApp(App)
installVueErrorHandler(app, (error) => vigil.captureException(error))
```

走 Vue 的 `errorHandler` 能额外拿到**组件名和错误来源**，
比全局 `error` 事件丰富。

插件会**保留**你原有的 `errorHandler` 并在其后调用 —— 直接覆盖会静默吃掉
你自己的错误上报逻辑。

---

## 5. 上传 sourcemap（CI）

```yaml
# .github/workflows/deploy.yml
- name: 上传 sourcemap
  env:
    VIGIL_APP_ID: ${{ secrets.VIGIL_APP_ID }}
    VIGIL_UPLOAD_TOKEN: ${{ secrets.VIGIL_UPLOAD_TOKEN }}
    VIGIL_COLLECTOR_URL: https://collector.example.com
    VIGIL_RELEASE: ${{ github.sha }}
  run: node scripts/upload-sourcemaps.mjs --dir dist/assets
```

脚本会自动找 `xxx.js` 对应的 `xxx.js.map`，用**产物相对路径**作为 key
（浏览器上报的栈里就是这个路径）。

> **sourcemap 不进静态资源目录。**
> 浏览器能下载到的文件，攻击者也能下载到 —— sourcemap 等于公开源码。
> map 只上传到 Collector，服务端还原后只把「原始位置」写进数据库。

---

## 6. 手动上报

```ts
// 上报一个 Error
vigil.captureException(new Error('自定义错误'), {
  context: { orderId: 'o_123' },   // 会被脱敏
  fingerprint: 'order-create'      // 自定义指纹，同一指纹的错误会聚合
})

// 记录面包屑
vigil.addBreadcrumb({ type: 'custom', category: 'checkout', message: '进入结算页' })

// 更新当前用户（登录后调用）
vigil.setUser('u_123')

// 全局上下文，会并到每一条事件上
vigil.setContext({ tenant: 'acme' })
```

### 自定义指纹什么时候用

SDK 自动算不出稳定指纹时（比如错误发生在 Web Worker 里，没有栈）。
这时候业务侧最清楚「什么参数组合算同一个 bug」。

---

## 7. 隐私说明

采集端就会脱敏，**不是**在服务端：

- URL 的 query 参数：`token` / `password` / `authorization` / `phone` / `email` …
  敏感键的值被替换成 `***`
- 错误消息和栈里的 `key=value` / `"key":"value"` 赋值
- `Authorization: Bearer xxx` 整段凭证

敏感键按**词段**匹配而不是子串：`userPassword` 会被脱敏，
但 `monkey` / `statusCode` / `zipcode` 不会被误伤。

但要注意：**URL 路径本身不脱敏**。
如果路径里带了用户标识（`/users/13800138000/orders`），那还是会进数据库。
这种情况要么在业务侧避免，要么用 `setContext` 传脱敏后的值。

---

## 8. 排查

### 报上去了但后台看不到

1. 检查 token 是不是过期或被停用（`PATCH /api/v1/apps/:appId` 可以停用）
2. 检查 `sampleRate` 是不是被设成了 0
3. 看浏览器控制台有没有 `[vigil] 上报失败`（需要 `debug: true`）
4. 检查 Collector 的限流日志 —— 429 表示超出配额

### 栈看不懂（显示 `index-DnB3xK2l.js:1:48213`）

sourcemap 没上传，或者 `release` 对不上。
还原是**按 release 匹配**的 —— 上传的 release 必须和 SDK 初始化时传的 `release` 一致。

### 首屏图片 404 收不到

用的是 ESM 接入。改成 IIFE 放在 `<head>` 里同步初始化。
原因见 [方式 A](#方式-aiife推荐能收到首屏资源错误)。
