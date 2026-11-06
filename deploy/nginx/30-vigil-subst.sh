#!/bin/sh
# 渲染 vigil-proxy.conf（API 反代片段）。
#
# 官方 entrypoint 的 20-envsubst-on-templates.sh 只会把
# /etc/nginx/templates/*.template 渲染到 /etc/nginx/conf.d/ ——
# 而 vigil-proxy.conf 是被 include 进 location 的**片段**
#（proxy_pass / set 在 http 层非法，落进 conf.d/ 会直接起不来），
# 所以这里自己渲染到它真正的位置。
#
# 脚本序号 30：排在 20-envsubst 之后、40-vigil-auth 之前。
#
# ⚠️ envsubst 的替换列表**只写 ${VIGIL_ADMIN_TOKEN} 这一个**。
#    不带列表的话 `$host` / `$uri` / `$vigil_collector` 这些 nginx
#    变量会被当成 shell 环境变量抽成空串 —— 配置就废了。
set -e

SRC=/etc/nginx/templates/vigil-proxy.conf.template
DST=/etc/nginx/vigil-proxy.conf

if [ ! -f "$SRC" ]; then
  echo "[vigil] $SRC 不存在，跳过渲染" >&2
  exit 0
fi

envsubst '${VIGIL_ADMIN_TOKEN}' < "$SRC" > "$DST"

if grep -qF '${VIGIL_ADMIN_TOKEN}' "$DST"; then
  echo "[vigil] ============================================================" >&2
  echo "[vigil]  ⚠️  VIGIL_ADMIN_TOKEN 没有被注入：管理接口的 token 注入将是" >&2
  echo "[vigil]     空值，面板所有请求都会 401。请检查 compose 的 environment。" >&2
  echo "[vigil] ============================================================" >&2
else
  echo "[vigil] vigil-proxy.conf 渲染完成（token 已注入）"
fi
