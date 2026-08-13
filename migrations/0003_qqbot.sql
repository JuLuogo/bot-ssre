-- QQ 官方机器人（QQ 开放平台）默认设置。
-- targets 形如 "group:<group_openid>" / "user:<user_openid>"；也可由用户 /start 自助订阅。
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('qqbot', '{"enabled":false,"targets":[]}');
