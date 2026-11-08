#!/bin/sh
# 线上冒烟：验证公开只读 Demo 与面板登录的三条通道。
#
# 在服务器 /opt/vigil 下跑（需要容器已在跑）：
#   sh scripts/smoke-public-demo.sh
#
# ⚠️ 这个脚本**故意不带** Basic Auth 凭据去测「公开只读」通道 ——
#    带了凭据就测不出「匿名能不能免登录看到演示数据」了。
set -e

DOMAIN="${1:-https://vigil.bscjs.top}"
PASS=0
FAIL=0

check() {
  desc="$1"
  expected="$2"
  actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    printf "  ✓ %-46s %s\n" "$desc" "$actual"
  else
    FAIL=$((FAIL + 1))
    printf "  ✗ %-46s 期望 %s 实际 %s\n" "$desc" "$expected" "$actual"
  fi
}

code() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

echo "[smoke] 目标 $DOMAIN"

echo "[smoke] 1. 静态资源（应当公开）"
check "GET / (面板外壳)" 200 "$(code "$DOMAIN/")"
check "GET /config.js (演示令牌注入)" 200 "$(code "$DOMAIN/config.js")"

echo "[smoke] 2. 管理接口三条通道"
# A：匿名 + 演示令牌 → 200 免登录只读
DEMO_TOKEN="$(grep -E '^VIGIL_DEMO_MEMBER_TOKEN=' .env | cut -d= -f2-)"
if [ -n "$DEMO_TOKEN" ]; then
  check "A 匿名+vmk_ 演示令牌 (期望 200)" 200 \
    "$(code -H "x-vigil-member-token: $DEMO_TOKEN" "$DOMAIN/api/v1/projects")"
else
  echo "  ! .env 里没有 VIGIL_DEMO_MEMBER_TOKEN，跳过 A 通道"
fi
# B：匿名无凭据 → 401 弹登录框
check "B 匿名无凭据 (期望 401)" 401 "$(code "$DOMAIN/api/v1/projects")"

echo "[smoke] 3. 身份识别"
if [ -n "$DEMO_TOKEN" ]; then
  ME="$(curl -s -H "x-vigil-member-token: $DEMO_TOKEN" "$DOMAIN/api/v1/me")"
  echo "  · 演示令牌身份: $ME"
  case "$ME" in
    *'"kind":"member"'*) check "A 通道身份是 member" 0 0 ;;
    *) check "A 通道身份是 member" 1 0 ;;
  esac
fi

echo "[smoke] 4. 只读性（演示令牌不得有写权限）"
if [ -n "$DEMO_TOKEN" ]; then
  # 建项目：org role=member + project role=reader → 必须 403
  WCODE="$(code -X POST -H 'content-type: application/json' \
    -H "x-vigil-member-token: $DEMO_TOKEN" \
    -d '{"name":"smoke-should-not-exist","slug":"smoke-should-not-exist"}' \
    "$DOMAIN/api/v1/organizations/1/projects")"
  if [ "$WCODE" = "403" ]; then
    check "演示令牌建项目 (期望 403)" 403 "$WCODE"
  else
    # 403 / 404 都算「没建成功」，但 403 才是预期的权限拒绝
    check "演示令牌建项目 (期望 403)" 403 "$WCODE"
  fi
fi

echo "[smoke] 结果：通过 $PASS · 失败 $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
