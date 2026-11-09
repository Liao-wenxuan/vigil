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
# ✅ 镜像已由 CI 构建推送 GHCR，并在生产（vigil.bscjs.top）实跑验证：
#    Docker Compose 三容器 healthy，部署冒烟 5/5、公开只读三通道冒烟 6/6。
#    本机 Docker 因缺 WSL2 起不来，但那只是本地限制 —— 服务器只 pull，不 build。

# ============================================================
# 构建阶段
# ============================================================
FROM node:22-alpine AS build

# better-sqlite3 是原生模块，alpine 镜像里没有编译工具链 ——
# 没有 python3/make/g++，npm ci 会在 node-gyp 一步直接失败。
RUN apk add --no-cache python3 make g++

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

# openssl 只用于生成 Basic Auth 凭据（见 40-vigil-auth.sh）。
# nginx:alpine 默认不带 CLI。
RUN apk add --no-cache openssl

COPY --from=build /app/packages/dashboard/dist /usr/share/nginx/html

# SDK 的浏览器产物（IIFE）由面板同源托管。
#
# 不托管的话「接入 SDK」这一步在部署文档里根本没有可用的地址 ——
# 文档让用户引 https://cdn/vigil.iife.js，而产物其实叫 index.iife.js，
# 也没有任何地方在提供它。
COPY --from=build /app/packages/sdk/dist /usr/share/nginx/html/sdk

# 配置走「模板 + 启动时渲染」：管理 token 在容器启动时注入，不烘进镜像。
# ⚠️ vigil-proxy.conf **不能**放 /etc/nginx/templates/ —— 官方 20-envsubst
#    会把它渲染进 conf.d/（proxy_pass/set 在 http 层非法，nginx 起不来）。
#    它是被 include 进 location 的片段，由 30-vigil-subst.sh 自己渲染。
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/nginx/vigil-proxy.conf /etc/nginx/vigil-proxy.conf.template
COPY deploy/nginx/30-vigil-subst.sh /docker-entrypoint.d/30-vigil-subst.sh
COPY deploy/nginx/40-vigil-auth.sh /docker-entrypoint.d/40-vigil-auth.sh
COPY deploy/nginx/50-vigil-demo-config.sh /docker-entrypoint.d/50-vigil-demo-config.sh

# 1) 占位文件先建好：即使有人绕过 entrypoint（自己覆盖 CMD），
#    `include` 也不会因为文件不存在让 nginx 起不来。
# 2) 删掉镜像自带的 default.conf —— 不删的话它和我们的 server 抢 80 端口。
# 3) Windows 上 checkout 会带 CRLF，`#!/bin/sh\r` 会让脚本直接跑不起来；
#    nginx 配置里混进 \r 也会在值末尾多出一个字符。统一清掉。
RUN touch /etc/nginx/vigil-proxy.conf /etc/nginx/vigil-auth.conf \
 && rm -f /etc/nginx/conf.d/default.conf \
 && sed -i 's/\r$//' \
      /etc/nginx/templates/default.conf.template \
      /etc/nginx/vigil-proxy.conf.template \
      /docker-entrypoint.d/30-vigil-subst.sh \
      /docker-entrypoint.d/40-vigil-auth.sh \
      /docker-entrypoint.d/50-vigil-demo-config.sh \
 && chmod +x /docker-entrypoint.d/*.sh

EXPOSE 80
