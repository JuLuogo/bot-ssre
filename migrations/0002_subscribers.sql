-- 订阅者：Telegram 用户/群通过 /start 自助订阅。
CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT    NOT NULL DEFAULT 'telegram',
  chat_id    TEXT    NOT NULL,
  title      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(platform, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_sub_platform ON subscribers(platform, enabled);
