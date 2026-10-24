import type { Database } from 'better-sqlite3'

/**
 * 表结构定义。
 *
 * 设计上有两个刻意的选择：
 *
 * 1. **errors 表存聚合结果，error_events 表存原始事件**
 *    没有 events 表的话，聚合后就再也看不到「这个错误具体长什么样」——
 *    而排查问题恰恰需要看原始现场。events 表保留最近 N 条，
 *    errors 表只保留汇总计数和最新一份栈。
 *
 * 2. **UNIQUE(app_id, fingerprint) 是聚合的物理保证**
 *    不靠应用层「先查再插」，而是靠数据库约束 + UPSERT。
 *    应用层的先查再插在并发下必然出重复行 —— 这在单进程 Node 里
 *    概率低，但一旦上多实例就必然出现「同一个错误好几行」。
 */
export function initSchema(db: Database): void {
  db.exec(`
    -- 应用注册表：一个 app_id 对应一套 token
    CREATE TABLE IF NOT EXISTS apps (
      app_id           TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      -- token 只存哈希，不存明文：数据库泄露不等于所有应用的 token 泄露
      token_hash       TEXT NOT NULL,
      -- 上传 sourcemap 用的独立 token，只在 CI 里，绝不进浏览器
      upload_token_hash TEXT NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL,
      last_seen_at     INTEGER
    );

    -- 聚合后的错误
    CREATE TABLE IF NOT EXISTS errors (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id         TEXT NOT NULL,
      fingerprint    TEXT NOT NULL,
      category       TEXT NOT NULL,
      kind           TEXT NOT NULL,
      name           TEXT,
      message        TEXT NOT NULL,
      url            TEXT,
      url_path       TEXT,
      referrer       TEXT,
      user_agent     TEXT,
      browser        TEXT,
      os             TEXT,
      device         TEXT,
      environment    TEXT,
      release        TEXT,
      session_id     TEXT,
      user_id        TEXT,
      first_seen     INTEGER NOT NULL,
      last_seen      INTEGER NOT NULL,
      count          INTEGER NOT NULL DEFAULT 1,
      raw_stack      TEXT,
      resolved_stack TEXT,
      http_json      TEXT,
      resource_json  TEXT,
      FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE,
      UNIQUE (app_id, fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_errors_app_last_seen ON errors(app_id, last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_errors_app_count     ON errors(app_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_errors_app_release   ON errors(app_id, release);

    -- 原始事件明细（保留现场）
    CREATE TABLE IF NOT EXISTS error_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id      TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      error_id    INTEGER,
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_events_app_fp ON error_events(app_id, fingerprint, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_error  ON error_events(error_id, occurred_at DESC);

    -- sourcemap：按 app + release + 文件名索引
    CREATE TABLE IF NOT EXISTS sourcemaps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id      TEXT NOT NULL,
      release     TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      base_name   TEXT NOT NULL,
      map_json    TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE,
      UNIQUE (app_id, release, file_name)
    );

    CREATE INDEX IF NOT EXISTS idx_sourcemaps_lookup ON sourcemaps(app_id, release, base_name);
  `)
}
