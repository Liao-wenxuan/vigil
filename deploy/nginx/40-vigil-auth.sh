#!/bin/sh
# 生成面板的登录保护配置（Basic Auth）。
#
# 由 nginx 官方镜像的 entrypoint 在启动时执行（/docker-entrypoint.d/ 下的脚本
# 会按文件名顺序跑，40 排在 20-envsubst 之后 —— 那时 default.conf 已经渲染好了）。
#
# ## 为什么用「写一个空文件」来表达「不启用」
#
# nginx 没有条件语法，模板里那句 `include /etc/nginx/vigil-auth.conf;`
# 必须永远成立。所以鉴权开不开，由这个脚本决定文件里有没有 auth_basic 指令：
#   - 有密码  → 写入 auth_basic + 凭据文件
#   - 没密码  → 留空文件（include 空文件等于什么都不加）
#
# ## 三个通道里这个文件管哪个
#
#   A. 匿名 + vmk_ 成员令牌 → 公开只读（@vigil_public_api，不含本文件）
#   B. 匿名 + 无凭据        → 本文件（弹登录框）
#   C. 通过 Basic Auth       → 本文件（登录成功后注入管理员令牌）
set -e

AUTH_CONF=/etc/nginx/vigil-auth.conf
HTPASSWD=/etc/nginx/.htpasswd

: > "$AUTH_CONF"

if [ -n "${VIGIL_PANEL_PASSWORD:-}" ]; then
  USER_NAME="${VIGIL_PANEL_USER:-admin}"

  if ! command -v openssl >/dev/null 2>&1; then
    echo "[vigil] 镜像里没有 openssl，无法生成 Basic Auth 凭据" >&2
    exit 1
  fi

  # -apr1 是 htpasswd 的 MD5 格式，nginx 认这个
  printf '%s:%s\n' "$USER_NAME" "$(openssl passwd -apr1 "$VIGIL_PANEL_PASSWORD")" > "$HTPASSWD"

  # ⚠️ worker 进程以 nginx 用户运行，600/root 会让它读不到文件 ——
  #    症状是「不带凭据 401，带了凭据 500」：
  #    error.log 里是 open() "/etc/nginx/.htpasswd" failed (13: Permission denied)。
  chown root:nginx "$HTPASSWD" 2>/dev/null || chown 0:101 "$HTPASSWD"
  chmod 640 "$HTPASSWD"

  printf 'auth_basic "Vigil";\nauth_basic_user_file %s;\n' "$HTPASSWD" > "$AUTH_CONF"
  echo "[vigil] 面板已启用登录保护（用户 $USER_NAME）"
else
  echo "[vigil] ============================================================"
  echo "[vigil]  ⚠️  未设置 VIGIL_PANEL_PASSWORD：面板的管理接口不校验身份。"
  echo "[vigil]     任何人都能读走全部错误数据（含用户行为与会话回放）。"
  echo "[vigil]     公网部署请务必设置："
  echo "[vigil]       echo 'VIGIL_PANEL_PASSWORD=<强密码>' >> .env"
  echo "[vigil]       docker compose up -d dashboard"
  echo "[vigil] ============================================================"
fi
