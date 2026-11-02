# 上线指南

服务器买好之后照着这份文档做。**本地开发和 CI 都已经验证过的部分不再重复**，
这里只写「到了机器上要做的事」。

---

## 0. 一句话版本

```bash
git clone <repo> vigil && cd vigil
cp .env.example .env      # 填四个值（见第 2 节）
docker compose up -d --build
```

完事。**统一入口在 `:8080`** —— 面板、管理 API、SDK 上报、SDK 静态文件
全走这一个口。采集服务不占宿主机端口。

---

## 1. 服务器准备

### 1.1 装 Docker

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

### 1.2 域名与 HTTPS

面板**绝对不要裸奔在公网上** —— 它带着管理 token 的读权限，
一旦被拿到，攻击者可以读走全部错误数据（里面往往有用户标识、URL 路径
和完整的会话回放）。

面板自己有一套 Basic Auth（见第 2 节的 `VIGIL_PANEL_PASSWORD`），
但那是**共用口令**，不是账号体系 —— 外网暴露时仍然必须上 HTTPS：
token 和回放数据在传输中不能是明文。

用宿主机 Nginx 反代 + Let's Encrypt：

```bash
apt install -y nginx certbot python3-certbot-nginx
certbot --nginx -d vigil.example.com
```

宿主机这层的配置（容器内那份 `deploy/nginx/default.conf.template`
只管容器内部的事）：

```nginx
server {
  server_name vigil.example.com;

  # ⚠️ 不加这行，sourcemap 上传会在**宿主机这一层**被 413 拦掉。
  #    容器内的 nginx 已经放到 64m 了，这一层不能更小。
  client_max_body_size 64m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### 1.3 磁盘与内存

| 组件 | 建议 |
|---|---|
| CPU | 2 核起 |
| 内存 | 2GB 起（PG 自己要 512MB） |
| 磁盘 | 20GB 起 —— 错误数据的增长速度取决于你的流量 |

---

## 2. 环境变量与密钥

```bash
cp .env.example .env
```

要填四个：

| 变量 | 怎么生成 | 说明 |
|---|---|---|
| `VIGIL_ADMIN_TOKEN` | `openssl rand -hex 32` | **管理端凭据**。由面板的 nginx 注入，浏览器里看不到它 |
| `VIGIL_PANEL_PASSWORD` | 自己想一个强口令 | **面板登录**（Basic Auth）。不设 = 面板没有任何登录保护 |
| `POSTGRES_USER` | 自己起，如 `vigil` | 数据库用户 |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | 数据库密码，**只用十六进制**（特殊字符会破坏 `DATABASE_URL`） |

可选（有默认值，调优时才动）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIGIL_PANEL_USER` | `admin` | 面板登录用户名 |
| `VIGIL_RETENTION_INTERVAL` | `3600` | 保留策略执行间隔（秒）。**设 0 会关掉清理**，表就只增不减 |
| `VIGIL_PG_POOL_MAX` | `10` | 单副本连接池上限。**副本数 × 这个值必须小于 PG 的 `max_connections`** |
| `VIGIL_PG_STATEMENT_TIMEOUT_MS` | `15000` | 单条语句超时。没有它，一个写错的查询能占死连接池，整个服务假死 |
| `VIGIL_PG_CONNECT_TIMEOUT_MS` | `5000` | 建连超时 |
| `VIGIL_PG_SSL` | 不设 | `verify` 校验证书（云数据库）；`no-verify` 加密但不校验（自签）；不设则不开 TLS |

`retention_days` 是**每个项目**自己的配置（默认 90 天，建项目时定）。
保留策略会裁掉 `issue_events` / `replay_events` / `behavior_events` /
`transactions` / `replay_sessions` 里超期的行，**用量计数器不回退** ——
配额记的是「累计摄入量」，不能靠等过期洗回来。

手动触发一次（磁盘告急时不用等整点）：

```bash
curl -u admin:$VIGIL_PANEL_PASSWORD -X POST \
  https://vigil.example.com/api/v1/maintenance/retention
```

⚠️ **`VIGIL_ADMIN_TOKEN` 泄露 = 全部错误数据泄露。**

它由面板的 nginx 在服务端注入，**不出现在前端 bundle，也不出现在浏览器的
网络面板里** —— 所以泄露渠道只有镜像、`.env` 和宿主机。

⚠️ **`VIGIL_PANEL_PASSWORD` 不设，面板就是无密码后台。**
nginx 会为每个 `/api` 请求自动带上管理 token —— 也就是说
「知道域名」等于「拿到完整管理权限」。容器启动日志里会有一条醒目警告。

⚠️ `.env` **不要提交进 git**。仓库的 `.gitignore` 已经排除了它。

---

## 3. 启动

```bash
docker compose up -d --build
docker compose ps
```

三个容器：`postgres` / `collector` / `dashboard`。

启动顺序是 compose 自己管的：PG 健康检查通过 → 采集服务起来 → 面板起来。

### 验证

```bash
# 采集服务：不占宿主机端口，进容器查
docker compose exec collector wget -qO- http://127.0.0.1:4318/api/ready

# 面板与 API 走同一个入口
curl -I http://127.0.0.1:8080/
curl -u admin:$VIGIL_PANEL_PASSWORD http://127.0.0.1:8080/api/v1/organizations

# SDK 是否在托管
curl -I http://127.0.0.1:8080/sdk/index.iife.js
```

`/api/ready` 和 `/api/health` 的区别：前者**真的查数据库**。
PG 还没就绪时就返回失败 —— 这是「就绪探针」该干的事。

⚠️ `curl http://127.0.0.1:8080/` 返回 **401 是正常的** —— 那是面板登录在拦。
带 `-u` 之后才是 200。

### 部署冒烟（强烈建议）

`docker compose ps` 全 Up **不代表能用**。这套拓扑有三个「看起来正常、
实际全废」的坑，都不报错：面板 token 没注入（全站 401）、SDK 没托管
（业务页面 404）、面板没登录（数据裸奔）。

在**你自己的电脑上**跑（指到服务器，顺带验证了宿主机反代和 TLS）：

```bash
VIGIL_URL=https://vigil.example.com \
VIGIL_PANEL_USER=admin \
VIGIL_PANEL_PASSWORD='你的面板密码' \
npm run smoke:deploy
```

5 条断言，10 秒出结果：

```
✓ 面板可访问 — HTTP 200
✓ 未登录时管理接口被拒绝 — HTTP 401
✓ 管理接口可用（token 注入 + 数据库） — HTTP 200，0 个组织
✓ SDK 产物可下载 — HTTP 200，27KB，text/javascript
✓ 上报通道可用且要求项目密钥 — HTTP 401
```

第 3 条是最关键的那条：它同时验证了「nginx 注入了 token」和「数据库连得上」。

---

## 4. SDK 接入

### 4.1 建项目、拿上报密钥

```bash
docker compose exec collector node packages/collector/dist/cli.js \
  org create "我的组织"
# 用返回的组织 ID 建项目
docker compose exec collector node packages/collector/dist/cli.js \
  project create 1 "我的应用"
```

建项目时会输出 `runtimeKey`（`vsk_` 开头）—— **只显示这一次**，
数据库里只存哈希。丢了就轮换。

### 4.2 业务页面引 SDK

SDK 由面板**同源托管**在 `/sdk/` 下，不需要自己往 CDN 传：

```html
<script src="https://vigil.example.com/sdk/index.iife.js"></script>
<script>
  Vigil.init({
    endpoint: 'https://vigil.example.com/api/v1/collect',
    appId: 'my-app',
    token: 'vsk_xxx',
    release: '1.0.0',
    environment: 'production'
  })
</script>
```

要**会话回放**和**用户行为**时，额外引一个独立产物（含 rrweb，74KB gzip）：

```html
<script src="https://vigil.example.com/sdk/replay.iife.js"></script>
<script>
  Vigil.init({
    endpoint: 'https://vigil.example.com/api/v1/collect',
    appId: 'my-app',
    token: 'vsk_xxx',
    release: '1.0.0',
    plugins: [VigilReplay.replayPlugin(), VigilReplay.behaviorPlugin()]
  })
</script>
```

⚠️ **要完整的首屏快照，就把 `init` 放到 `DOMContentLoaded` 之后** ——
rrweb 的第一帧是全量快照，太早启动只能拍到空壳。

⚠️ **回放入口是可选的**。不需要回放就别引，核心 SDK 的体积是它的 1/6。

### 4.3 CI 上传 sourcemap

```bash
curl -X POST https://vigil.example.com/api/v1/sourcemaps \
  -H 'x-vigil-upload-token: vup_xxx' \
  -H 'content-type: application/json' \
  -d @payload.json
```

⚠️ 用 `uploadKey`（`vup_` 开头）而不是 `runtimeKey` —— 上传密钥只在 CI 里，
运行时密钥在前端代码里，谁拿到都能污染别人的错误栈。

---

## 5. 备份

**数据库是唯一有状态的东西**（采集服务本身无状态）。

```bash
docker compose exec -T postgres \
  pg_dump -U vigil -d vigil --clean --if-exists \
  | gzip > vigil-$(date +%F).sql.gz
```

放进 cron（每天 3 点，保留 30 天）：

```bash
0 3 * * * cd /opt/vigil && docker compose exec -T postgres pg_dump -U vigil -d vigil | gzip > backups/vigil-$(date +\%F).sql.gz && find backups -name 'vigil-*.sql.gz' -mtime +30 -delete
```

**恢复**：

```bash
gunzip < vigil-2026-10-29.sql.gz | docker compose exec -T postgres psql -U vigil -d vigil
```

⚠️ **备份要定期验证能恢复**。没验证过的备份等于没有备份。

---

## 6. 升级

```bash
git pull
docker compose up -d --build
```

采集服务是**无状态**的，滚动更新时旧 Pod 直接停掉即可，没有数据迁移要做
（数据库 schema 由服务启动时的迁移自动处理）。

---

## 7. 多副本

单机的 compose 部署**不要**给采集服务开多副本 —— 一个 PG 实例扛不住，
而且单机上也换不来什么。

真要水平扩，得是 k8s：

```bash
kubectl apply -f deploy/k8s/
```

清单里已经配好：

| 文件 | 内容 |
|---|---|
| `00-namespace.yaml` | 命名空间 |
| `10-postgres.yaml` | PostgreSQL StatefulSet + Service |
| `20-collector.yaml` | 采集服务 Deployment（**无状态**，不挂卷）+ Service |
| `30-dashboard.yaml` | 面板 Deployment + Service + Ingress |
| `40-autoscaling.yaml` | 两个 HPA + 两个 PDB |

⚠️ **k8s 这条路径没有实跑验证过**，而且有两个已知问题：

1. 面板镜像里的 nginx 以 root 启动并监听 80；
   `30-dashboard.yaml` 里写的 `runAsUser: 10001` + `drop: ['ALL']`
   会让它**根本起不来**（80 端口需要 root 或 `NET_BIND_SERVICE`）。
2. 面板需要 `VIGIL_ADMIN_TOKEN` 环境变量来注入管理 token
   （compose 版本已经配好，k8s 清单里还没加），
   否则面板每个请求都是 401。

单机上就用 compose —— 它是验证过的路径。

⚠️ **清单里的 PostgreSQL 是单副本 StatefulSet** —— 它是单点。
抗单点要上流复制（replica）或用托管实例（RDS / Cloud SQL）。

⚠️ **Secret 要自己建**，清单不会替你生成：

```bash
kubectl -n vigil create secret generic vigil-secret \
  --from-literal=VIGIL_ADMIN_TOKEN="$(openssl rand -hex 32)"

kubectl -n vigil create secret generic vigil-postgres \
  --from-literal=POSTGRES_USER=vigil \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=DATABASE_URL="postgres://vigil:$(openssl rand -hex 24)@vigil-postgres:5432/vigil"
```

（上面 `DATABASE_URL` 里的密码要和 `POSTGRES_PASSWORD` 一致 ——
实际部署时用同一个变量拼，别写两遍。）

---

## 8. 排查

| 现象 | 多半是 |
|---|---|
| 面板能开，但列表全空 / 每个请求 401 | 面板的 nginx 没注入管理 token。检查 `docker compose logs dashboard` 里有没有渲染失败，以及 `VIGIL_ADMIN_TOKEN` 在 collector 和 dashboard 两处是否同一个值 |
| 打开面板一直弹登录框 | 设了 `VIGIL_PANEL_PASSWORD`。用户名默认 `admin`，可用 `VIGIL_PANEL_USER` 改 |
| 上传 sourcemap 返回 413 | `client_max_body_size`。**宿主机那层 nginx 也要放开到 64m**，只改容器内不够 |
| 采集服务重启后，面板一直 502 | nginx 缓存了旧 IP。本仓库的配置用 `resolver` 规避了；自己改过配置就检查是不是写成了字面量 upstream |
| 面板打不开，但 `curl /api/health` 正常 | 宿主机反代没配好，或者没转发 `/api` |
| 上报返回 401 | SDK 的 `token` 填错，或用了 `uploadKey` |
| 上报 500，日志里是 `relation does not exist` | 数据库迁移没跑 —— 看 collector 启动日志 |
| `/api/ready` 一直不通过 | PG 没起来或连接串不对 |
| 容器反复重启 | 内存不够 —— PG 至少给 512MB |
| 磁盘只涨不降 | `VIGIL_RETENTION_INTERVAL` 被设成 0，或项目的 `retention_days` 是 0（永久保留） |
