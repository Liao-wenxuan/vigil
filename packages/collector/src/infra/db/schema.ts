import { bool, json, longText, pk, text, ts, type Dialect } from './dialect.js'

/**
 * 数据表结构（v2）。
 *
 * 按域分组：租户 / 问题 / 性能 / 告警 / 制品 / 审计。
 *
 * ## 和 v1 的区别
 *
 * v1 只有 4 张表（apps / errors / error_events / sourcemaps），
 * 错误是「一条记录」，没有生命周期、没有归属、没有版本概念。
 *
 * v2 的核心变化：
 * 1. **错误 → Issue**。issue 是聚合后的工单，带状态机、负责人、评论、活动流。
 * 2. **项目（Project）是一等公民**。组织 → 团队 → 项目 → 环境 / 版本。
 * 3. **版本（Release）成为回归判定的锚**。在 1.4.3 解决的问题，
 *    只有 1.4.4+ 再出现才算回归。
 * 4. **性能是一等公民**。事务 + span 独立建模，采样与保留策略独立。
 * 5. **告警**有规则、通道、触发记录三张表。
 */
export function buildSchema(dialect: Dialect): string {
  const PK = pk(dialect)
  const TS = ts(dialect)
  const BOOL = bool(dialect)
  const JSON = json(dialect)
  const TEXT = text(dialect)
  const LONG = longText(dialect)

  return `
-- ============================================================
-- 租户域：组织 → 团队 → 项目
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
  id ${PK},
  slug ${TEXT} NOT NULL UNIQUE,
  name ${TEXT} NOT NULL,
  created_at ${TS} NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id ${PK},
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug ${TEXT} NOT NULL,
  name ${TEXT} NOT NULL,
  created_at ${TS} NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS members (
  id ${PK},
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email ${TEXT} NOT NULL,
  name ${TEXT} NOT NULL,
  role ${TEXT} NOT NULL DEFAULT 'member',
  created_at ${TS} NOT NULL,
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, member_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id ${PK},
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  slug ${TEXT} NOT NULL,
  name ${TEXT} NOT NULL,
  platform ${TEXT} NOT NULL DEFAULT 'javascript',
  -- 数据保留天数（超出后由清理任务裁剪）
  retention_days INTEGER NOT NULL DEFAULT 90,
  -- 事件配额：超出后摄入接口返回 429
  event_quota INTEGER NOT NULL DEFAULT 1000000,
  created_at ${TS} NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role ${TEXT} NOT NULL DEFAULT 'reader',
  PRIMARY KEY (project_id, member_id)
);

-- 项目密钥：runtime（上报）与 upload（sourcemap）严格分离，只存哈希
CREATE TABLE IF NOT EXISTS project_keys (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind ${TEXT} NOT NULL,
  key_hash ${TEXT} NOT NULL,
  label ${TEXT},
  created_at ${TS} NOT NULL,
  last_used_at ${TS}
);

CREATE INDEX IF NOT EXISTS idx_project_keys_hash ON project_keys(key_hash);

CREATE TABLE IF NOT EXISTS environments (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug ${TEXT} NOT NULL,
  name ${TEXT} NOT NULL,
  is_production ${BOOL} NOT NULL DEFAULT 0,
  created_at ${TS} NOT NULL,
  UNIQUE (project_id, slug)
);

-- 版本：回归判定的锚
CREATE TABLE IF NOT EXISTS releases (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version ${TEXT} NOT NULL,
  commit_sha ${TEXT},
  created_at ${TS} NOT NULL,
  deployed_at ${TS},
  UNIQUE (project_id, version)
);

-- ============================================================
-- 问题域：Issue 是一等公民
-- ============================================================

CREATE TABLE IF NOT EXISTS issues (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint ${TEXT} NOT NULL,
  -- 短 ID，团队内部口头交流用（类似 "VIG-1A2B"）
  short_id ${TEXT} NOT NULL,

  category ${TEXT} NOT NULL,
  kind ${TEXT} NOT NULL,
  title ${TEXT} NOT NULL,
  -- 错误消息：冗余自最近一次事件。
  -- 搜索要按消息搜（「Cannot read properties」比标题更常用），不能每次都去 join 事件表
  message ${LONG} NOT NULL DEFAULT '',
  -- 触发页面：冗余自最近一次事件。列表页要显示「哪个页面出的问题」
  url ${TEXT},
  -- 路径部分（去 query），用来按页面聚合
  url_path ${TEXT},
  -- 最近一次事件的原始栈与还原后的栈。
  -- 还原后的栈是「sourcemap 还原到源码位置」的结果 —— 列表页要直接展示它，
  -- 不能每次都重新还原一遍
  raw_stack ${LONG},
  resolved_stack ${JSON},
  -- 责任点：最接近根因的那一帧
  culprit ${TEXT},
  level ${TEXT} NOT NULL DEFAULT 'error',
  -- 环境与版本：冗余自**最近一次事件**。
  -- 告警规则要按环境/版本过滤，而这两个字段住在 event 上 ——
  -- 不冗余的话每条规则都要 join 一遍事件表。
  environment ${TEXT},
  release ${TEXT},

  -- 主状态 + 子状态。拆两层是因为「未解决」不是一个状态
  status ${TEXT} NOT NULL DEFAULT 'unresolved',
  substatus ${TEXT} NOT NULL DEFAULT 'new',

  count INTEGER NOT NULL DEFAULT 1,
  user_count INTEGER NOT NULL DEFAULT 0,

  first_seen ${TS} NOT NULL,
  last_seen ${TS} NOT NULL,

  -- 已解决：时间 + 版本。版本是回归判定的锚
  resolved_at ${TS},
  resolved_in_release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL,
  -- 版本字符串副本：比较新旧必须按**版本语义**，
  -- 不能按 release 的自增 id —— 用户可能先建 1.4.10 再建 1.4.3
  resolved_in_release ${TEXT},

  -- 已归档：策略 + 阈值
  archived_at ${TS},
  archive_strategy ${TEXT},
  archive_until_count INTEGER,
  archive_until_user_count INTEGER,

  assignee_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  is_bookmarked ${BOOL} NOT NULL DEFAULT 0,
  is_subscribed ${BOOL} NOT NULL DEFAULT 0,
  -- 是否已被人工「看过」—— 决定 substatus 从 new 转 ongoing
  has_seen ${BOOL} NOT NULL DEFAULT 0,

  metadata_json ${JSON},
  created_at ${TS} NOT NULL,
  updated_at ${TS} NOT NULL,
  UNIQUE (project_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_issues_project_last ON issues(project_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_issues_project_count ON issues(project_id, count DESC);
CREATE INDEX IF NOT EXISTS idx_issues_status        ON issues(project_id, status, substatus);
CREATE INDEX IF NOT EXISTS idx_issues_assignee      ON issues(project_id, assignee_id);

-- Issue 的一次发生
CREATE TABLE IF NOT EXISTS issue_events (
  id ${PK},
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 事件唯一 ID：同一条事件重复上报时用来去重
  event_id ${TEXT} NOT NULL,
  occurred_at ${TS} NOT NULL,
  received_at ${TS} NOT NULL,
  user_id ${TEXT},
  session_id ${TEXT},
  url ${TEXT},
  release ${TEXT},
  environment ${TEXT},
  -- 报错瞬间的性能快照（错误与性能关联）
  vitals_json ${JSON},
  payload_json ${JSON}
);

CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_events_project ON issue_events(project_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_events_uid ON issue_events(project_id, event_id);

-- 活动流：每一次状态变化都留痕，包括系统自己改主意
CREATE TABLE IF NOT EXISTS issue_activity (
  id ${PK},
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_type ${TEXT} NOT NULL,
  actor_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  action ${TEXT} NOT NULL,
  reason ${TEXT},
  data_json ${JSON},
  created_at ${TS} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issue_activity_issue ON issue_activity(issue_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issue_comments (
  id ${PK},
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  body ${LONG} NOT NULL,
  created_at ${TS} NOT NULL,
  updated_at ${TS} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, created_at DESC);

-- 自定义标签：可搜索、可过滤
CREATE TABLE IF NOT EXISTS issue_tags (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  key ${TEXT} NOT NULL,
  value ${TEXT} NOT NULL,
  PRIMARY KEY (issue_id, key, value)
);

CREATE INDEX IF NOT EXISTS idx_issue_tags_lookup ON issue_tags(key, value);

-- 受影响的用户：一条用户只在同一个 issue 里计一次
-- （用户数是排序和告警阈值的重要维度，不能靠 events 表 count distinct —— 那是 O(n) 全扫）
CREATE TABLE IF NOT EXISTS issue_users (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id ${TEXT} NOT NULL,
  first_seen ${TS} NOT NULL,
  last_seen ${TS} NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_users_user ON issue_users(user_id);

-- ============================================================
-- 性能域
-- ============================================================

CREATE TABLE IF NOT EXISTS transactions (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
  release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL,

  name ${TEXT} NOT NULL,
  type ${TEXT} NOT NULL DEFAULT 'page',
  duration_ms INTEGER NOT NULL,

  fcp INTEGER, lcp INTEGER, cls REAL, inp INTEGER, ttfb INTEGER,
  tbt INTEGER, long_task_count INTEGER DEFAULT 0,

  resource_count INTEGER DEFAULT 0,
  transfer_size INTEGER DEFAULT 0,

  page_url ${TEXT},
  referrer ${TEXT},
  user_agent ${TEXT},
  browser ${TEXT},
  os ${TEXT},
  device ${TEXT},
  session_id ${TEXT},
  user_id ${TEXT},
  release ${TEXT},
  environment ${TEXT},

  started_at ${TS} NOT NULL,
  received_at ${TS} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_project_time ON transactions(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_project_lcp   ON transactions(project_id, lcp);
CREATE INDEX IF NOT EXISTS idx_tx_name          ON transactions(project_id, name);

CREATE TABLE IF NOT EXISTS spans (
  id ${PK},
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name ${TEXT} NOT NULL,
  type ${TEXT} NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at ${TS},
  status_code INTEGER,
  url ${TEXT},
  size_bytes INTEGER,
  initiator_type ${TEXT}
);

CREATE INDEX IF NOT EXISTS idx_spans_tx     ON spans(transaction_id);
CREATE INDEX IF NOT EXISTS idx_spans_project ON spans(project_id, duration_ms DESC);

-- ============================================================
-- 告警域
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_channels (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name ${TEXT} NOT NULL,
  type ${TEXT} NOT NULL,
  config_json ${JSON},
  enabled ${BOOL} NOT NULL DEFAULT 1,
  created_at ${TS} NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name ${TEXT} NOT NULL,
  type ${TEXT} NOT NULL,
  conditions_json ${JSON},
  threshold INTEGER NOT NULL DEFAULT 1,
  window_seconds INTEGER NOT NULL DEFAULT 300,
  channel_ids_json ${JSON},
  enabled ${BOOL} NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at ${TS} NOT NULL,
  updated_at ${TS} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_project ON alert_rules(project_id, enabled);

CREATE TABLE IF NOT EXISTS alert_incidents (
  id ${PK},
  rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  status ${TEXT} NOT NULL DEFAULT 'triggered',
  triggered_at ${TS} NOT NULL,
  resolved_at ${TS},
  -- 去重键：同一个键在窗口内不重复告警，避免告警疲劳
  dedupe_key ${TEXT} NOT NULL,
  payload_json ${JSON}
);

CREATE INDEX IF NOT EXISTS idx_alert_incidents_dedupe ON alert_incidents(dedupe_key, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_incidents_rule  ON alert_incidents(rule_id, triggered_at DESC);

-- ============================================================
-- 会话回放与用户行为
-- ============================================================

-- 会话：一次标签页访问
--
-- ⚠️ 回放事件流**按会话存最新的一份**，不是按错误存。
--    客户端的缓冲区是滚动窗口，第 2 个错误带的上传窗口比第 1 个更长，
--    两份都存就是重复数据。代价是：回放展示的是**最近一次快照**，
--    不精确对应每个错误的时间点 —— 文档里写明了这个限制。
CREATE TABLE IF NOT EXISTS replay_sessions (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id ${TEXT} NOT NULL,
  user_id ${TEXT},
  started_at ${TS} NOT NULL,
  ended_at ${TS} NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  entry_page ${TEXT},
  exit_page ${TEXT},
  path_json ${JSON},
  user_agent ${TEXT},
  browser ${TEXT},
  os ${TEXT},
  device ${TEXT},
  referrer ${TEXT},
  error_count INTEGER NOT NULL DEFAULT 0,
  -- 回放流
  replay_events INTEGER NOT NULL DEFAULT 0,
  replay_bytes INTEGER NOT NULL DEFAULT 0,
  replay_updated_at ${TS},
  created_at ${TS} NOT NULL,
  UNIQUE (project_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_sessions_time ON replay_sessions(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_user ON replay_sessions(project_id, user_id);

-- 回放事件流（rrweb 格式）
--
-- seq 是**连续**的：rrweb 的数据是「一个全量快照 + 一串增量」，
-- 丢一段后面全对不上。所以 UNIQUE (project_id, session_id, seq)。
CREATE TABLE IF NOT EXISTS replay_events (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id ${TEXT} NOT NULL,
  seq INTEGER NOT NULL,
  timestamp ${TS} NOT NULL,
  event_type INTEGER NOT NULL,
  data_json ${JSON} NOT NULL,
  created_at ${TS} NOT NULL,
  UNIQUE (project_id, session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_replay_events_session ON replay_events(project_id, session_id, seq);

-- 行为事件：PV / 路由 / 点击
CREATE TABLE IF NOT EXISTS behavior_events (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id ${TEXT} NOT NULL,
  user_id ${TEXT},
  type ${TEXT} NOT NULL,
  name ${TEXT} NOT NULL,
  url ${TEXT},
  timestamp ${TS} NOT NULL,
  duration_ms INTEGER,
  data_json ${JSON}
);

CREATE INDEX IF NOT EXISTS idx_behavior_project_time ON behavior_events(project_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_project_type ON behavior_events(project_id, type);
CREATE INDEX IF NOT EXISTS idx_behavior_session ON behavior_events(project_id, session_id);

-- ============================================================
-- 制品域：构建产物与 sourcemap
-- ============================================================

CREATE TABLE IF NOT EXISTS artifacts (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id INTEGER REFERENCES releases(id) ON DELETE CASCADE,
  file_name ${TEXT} NOT NULL,
  kind ${TEXT} NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  checksum ${TEXT},
  uploaded_at ${TS} NOT NULL,
  UNIQUE (project_id, release_id, file_name, kind)
);

-- sourcemap 内容单独存 —— 它是「敏感数据」：公开可下载等于公开源码
CREATE TABLE IF NOT EXISTS sourcemaps (
  id ${PK},
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id INTEGER REFERENCES releases(id) ON DELETE CASCADE,
  file_name ${TEXT} NOT NULL,
  base_name ${TEXT} NOT NULL,
  map_json ${LONG} NOT NULL,
  uploaded_at ${TS} NOT NULL,
  UNIQUE (project_id, release_id, file_name)
);

CREATE INDEX IF NOT EXISTS idx_sourcemaps_lookup ON sourcemaps(project_id, base_name);

-- ============================================================
-- 审计
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id ${PK},
  organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type ${TEXT} NOT NULL,
  actor_id INTEGER,
  action ${TEXT} NOT NULL,
  target_type ${TEXT},
  target_id ${TEXT},
  data_json ${JSON},
  created_at ${TS} NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log(organization_id, created_at DESC);
`
}
