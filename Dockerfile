# syntax=docker/dockerfile:1
#
# 多阶段构建：一个 Dockerfile，两个 target。
#
#   --target collector  → 采集服务镜像（Node 运行 dist/index.js）
#   --target dashboard  → 面板静态资源镜像（nginx）
#
# 为什么分两个 target：采集服务是**有状态**的（SQLite + 上传数据），
# 面板是**纯静态**的。混在一个镜像里会让面板跟着采集服务一起重启。
#
# ⚠️ 本机 Docker 因缺 WSL2 跑不起来，**这个镜像没有实跑验证过**。
#    CI 里的 build 步骤是它第一次真正被构建的地方。

# ============================================================
# 构建阶段
# ============================================================
FROM node:22-alpine AS build

WORKDIR /app

# 先只拷 package.json，让 npm ci 有缓存可复用
# （源码变了不用重装依赖）
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk/package.json packages/sdk/
COPY packages/collector/package.json packages/collector/
COPY packages/dashboard/package.json packages/dashboard/

RUN npm ci

COPY . .

# 构建 SDK（浏览器产物）、Collector（Node）、Dashboard（静态资源）
RUN npm run build --workspace @vigil/sdk \
 && npm run build --workspace @vigil/collector \
 && npm run build --workspace @vigil/dashboard

# ============================================================
# 采集服务
# ============================================================
FROM node:22-alpine AS collector

# better-sqlite3 是原生模块，需要在**同版本 glibc/musl** 上编译，
# 所以运行镜像和构建镜像必须一致（这里都是 alpine）
RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4318
# SQLite 模式的数据库路径（不设 DATABASE_URL 时才用到）
ENV VIGIL_DB_PATH=/data/vigil.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/collector/dist ./packages/collector/dist
COPY --from=build /app/packages/collector/package.json ./packages/collector/package.json
COPY --from=build /app/packages/protocol ./packages/protocol

# SQLite 模式的数据目录。
# ⚠️ 设了 DATABASE_URL（PostgreSQL）时这个目录**不用挂** ——
#    采集服务是无状态的，多副本时每个 Pod 各有一份空目录也没关系。
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4318

# tini 做 PID 1：它会转发信号，
# 否则 Node 收不到 SIGTERM，容器停止时要等 10 秒超时
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/collector/dist/index.js"]

# ============================================================
# 管理面板（静态资源 + API 反代）
# ============================================================
FROM nginx:1.27-alpine AS dashboard

COPY --from=build /app/packages/dashboard/dist /usr/share/nginx/html
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
