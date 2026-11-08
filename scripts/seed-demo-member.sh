#!/bin/sh
# 在**线上** PostgreSQL 里种一个「公开只读演示」成员。
#
# 幂等：
#   - 成员按 email 去重（organizations=1, email=demo@vigil.local）
#   - 项目授权 upsert 成 reader（project 1）
#   - 凭据按 key_hash 去重；明文 token 落到 /opt/vigil/.env 的
#     VIGIL_DEMO_MEMBER_TOKEN，下次重跑复用同一把（不会越种越多）
#
# 用法（在服务器 /opt/vigil 下）：
#   ./scripts/seed-demo-member.sh
#
# 前置：docker 在跑（vigil-postgres-1 可用）、node 可用（生成令牌用）。
set -e

cd "$(dirname "$0")/.." || exit 1

ORG_ID="${VIGIL_DEMO_ORG_ID:-1}"
PROJECT_ID="${VIGIL_DEMO_PROJECT_ID:-1}"
DEMO_EMAIL='demo@vigil.local'
DEMO_NAME='在线演示(只读)'

# 已有 token 就复用，否则现生成一把
TOKEN="${VIGIL_DEMO_MEMBER_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env ]; then
  TOKEN="$(grep -E '^VIGIL_DEMO_MEMBER_TOKEN=' .env | head -1 | cut -d= -f2-)"
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$(node -e 'console.log("vmk_"+require("crypto").randomBytes(24).toString("hex"))')"
fi

HASH="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1],"utf8").digest("hex"))' "$TOKEN")"

echo "[seed] org=$ORG_ID project=$PROJECT_ID email=$DEMO_EMAIL"

docker exec -i vigil-postgres-1 psql -U vigil -d vigil <<SQL
INSERT INTO members (organization_id, email, name, role, created_at)
SELECT $ORG_ID, '$DEMO_EMAIL', '$DEMO_NAME', 'member', (extract(epoch from now()) * 1000)::bigint
WHERE NOT EXISTS (
  SELECT 1 FROM members WHERE organization_id=$ORG_ID AND email='$DEMO_EMAIL'
);

INSERT INTO project_members (project_id, member_id, role)
SELECT $PROJECT_ID, (SELECT id FROM members WHERE organization_id=$ORG_ID AND email='$DEMO_EMAIL'), 'reader'
ON CONFLICT (project_id, member_id) DO UPDATE SET role='reader';

INSERT INTO member_keys (member_id, key_hash, label, created_at)
SELECT (SELECT id FROM members WHERE organization_id=$ORG_ID AND email='$DEMO_EMAIL'),
       '$HASH', '在线演示只读凭据', (extract(epoch from now()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM member_keys WHERE key_hash='$HASH');
SQL

# 把 token 持久化进 .env（幂等：已有就不动）
if ! grep -q '^VIGIL_DEMO_MEMBER_TOKEN=' .env 2>/dev/null; then
  printf 'VIGIL_DEMO_MEMBER_TOKEN=%s\n' "$TOKEN" >> .env
  echo "[seed] 已把 VIGIL_DEMO_MEMBER_TOKEN 追加到 .env"
else
  echo "[seed] .env 已有 VIGIL_DEMO_MEMBER_TOKEN，保持不变"
fi

echo "DEMO_MEMBER_TOKEN=$TOKEN"
