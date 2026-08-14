-- 初始化：设置、数据源、推送记录、运行历史。

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter    TEXT    NOT NULL,          -- gelbooru | pixiv | moebooru | rss
  enabled    INTEGER NOT NULL DEFAULT 1,
  label      TEXT    NOT NULL,
  site       TEXT,                       -- booru 站点 base，或 RSSHub 路由完整 URL
  tags       TEXT,                       -- booru 查询标签
  mode       TEXT,                       -- pixiv 榜单模式
  limit_n    INTEGER NOT NULL DEFAULT 5, -- 每次取前 N 条
  trusted    INTEGER NOT NULL DEFAULT 0, -- 1=可信来源，跳过全年龄过滤（RSS 订阅）
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pushed (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  source    TEXT    NOT NULL,
  post_id   TEXT    NOT NULL,
  title     TEXT,
  author    TEXT,
  image_url TEXT,
  page_url  TEXT,
  channels  TEXT,                        -- JSON 数组：成功推送到的渠道
  pushed_at INTEGER NOT NULL,
  UNIQUE(source, post_id)
);
CREATE INDEX IF NOT EXISTS idx_pushed_at ON pushed(pushed_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  fetched     INTEGER DEFAULT 0,
  filtered    INTEGER DEFAULT 0,
  pushed      INTEGER DEFAULT 0,
  errors      TEXT                        -- JSON 数组
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

-- 默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('telegram', '{"enabled":true,"chatIds":[],"apiBase":"https://api.telegram.org"}'),
  ('napcat',   '{"enabled":false,"groupIds":[]}'),
  ('global',   '{"perRunTotalCap":10,"seenTtlDays":30}');

-- 默认数据源（仅当 sources 表为空时写入，保证迁移可重复执行不产生重复行）
INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT * FROM (VALUES
  ('gelbooru', 1, 'Safebooru',  'https://safebooru.org', 'sort:score:desc', NULL,    5, 0, 1),
  ('pixiv',    1, 'Pixiv 日榜', NULL,                    NULL,              'daily', 5, 0, 2),
  ('moebooru', 0, 'Konachan',   'https://konachan.com',  'order:score',     NULL,    5, 0, 3)
) WHERE NOT EXISTS (SELECT 1 FROM sources);
