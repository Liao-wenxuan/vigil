# 上线指南

服务器买好之后照着这份文档做。**本地开发和 CI 都已经验证过的部分不再重复**，
这里只写「到了机器上要做的事」。

---

## 0. 一句话版本

```bash
git clone <repo> vigil && cd vigil
cp .env.example .env      # 填三个密钥
docker compose up -d --build
```

完事。面板在 `:8080`，接口在 `:4318`。

---

## 1. 服务器准备

### 1.1 装 Docker

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

### 1.2 域名与 HTTPS

监控面板**绝对不要裸奔在公网上** —— 它带着管理 token 的读权限，
一旦被拿到，攻击者可以读走全部错误数据（里面往往有用户标识和 URL 路径）。

用 Nginx 反代 + Let's Encrypt：

```bash
apt install -y nginx certbot python3-certbot-nginx
certbot --nginx -d vigil.example.com
```

`deploy/nginx/default.conf` 是给容器用的那份；宿主机这一层要自己写：

```nginx
server {
  server_name vigil.example.com;

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

要填三个：

| 变量 | 怎么生成 | 说明 |
|---|---|---|
| `VIGIL_ADMIN_TOKEN` | `openssl rand -hex 32` | **管理端凭据**。查询与操作接口都要它 |
| `POSTGRES_USER` | 自己起，如 `vigil` | 数据库用户 |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | 数据库密码 |

可选（有默认值，调优时才动）：

| 变量 | 默认 | 说明 |
|---|---|---|
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
curl -X POST -H "x-vigil-admin-token: $VIGIL_ADMIN_TOKEN" \
  http://127.0.0.1:4318/api/v1/maintenance/retention
```

⚠️ **`VIGIL_ADMIN_TOKEN` 泄露 = 全部错误数据泄露。**
它会出现在面板的网络请求里（面板的 dev proxy 自动注入），
所以生产必须走 HTTPS。

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
curl http://127.0.0.1:4318/api/health   # 存活
curl http://127.0.0.1:4318/api/ready    # 就绪（会真的连一下数据库）
curl http://127.0.0.1:8080/              # 面板
```

`/api/ready` 和 `/api/health` 的区别：前者**真的查数据库**。
PG 还没就绪时就返回失败 —— 这是「就绪探针」该干的事。

---

## 4. SDK 接入

采集服务起来后，在项目里建一个应用拿到上报密钥：

```bash
docker compose exec collector node packages/collector/dist/cli.js \
  org create "我的组织"
# 用返回的组织 ID 建项目
docker compose exec collector node packages/collector/dist/cli.js \
  project create 1 "我的应用"
```

建项目时会输出 `runtimeKey`（`vsk_` 开头）—— **只显示这一次**，
数据库里只存哈希。丢了就轮换。

然后在业务页面里接 SDK：

```html
<script src="https://vigil.example.com/vigil.iife.js"></script>
<script>
  Vigil.init({
    endpoint: 'https://vigil.example.com/api/v1/collect',
    appId: 'my-app',
    token: 'vsk_xxx',
    release: '1.0.0',
    environment: 'production'
  })
</script>

<!-- 要回放和行为分析才加这个独立入口（74KB gzip） -->
<script src="https://vigil.example.com/vigil.replay.iife.js"></script>
<script>
  Vigil.init({ /* ... */, plugins: [VigilReplay.replayPlugin(), VigilReplay.behaviorPlugin()] })
</script>
```

⚠️ **要完整的首屏快照，就把 `init` 放到 `DOMContentLoaded` 之后** ——
rrweb 的第一帧是全量快照，太早启动只能拍到空壳。

⚠️ **回放入口是可选的**。它含 rrweb，74KB gzip。
不需要回放就别引。

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
| 面板打不开，但接口正常 | 反代没配好，或者 Nginx 没转发 `/api` |
| 面板能开，列表空 | `VIGIL_ADMIN_TOKEN` 不一致（面板代理注入的和采集服务期望的不是同一个） |
| 上报返回 401 | SDK 的 `token` 填错，或用了 `uploadKey` |
| 上报 500，日志里是 `relation does not exist` | 数据库迁移没跑 —— 检查 `VIGIL_ADMIN_TOKEN` 启动日志 |
| `/api/ready` 一直不通过 | PG 没起来或连接串不对 |
| 容器反复重启 | 内存不够 —— PG 至少给 512MB |
