-- 凭证：可在管理后台配置的密钥/变量（D1 优先，未配置则回退到 wrangler secret / vars）。
-- 注意：这里是明文存储，ADMIN_TOKEN 不入库（仍只用 wrangler secret，作为保护 /api 的信任根）。
CREATE TABLE IF NOT EXISTS credentials (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
