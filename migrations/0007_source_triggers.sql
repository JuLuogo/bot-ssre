-- 源级触发词 + pixiv 全部/部分推送开关。
-- 注意：ALTER ADD COLUMN 非幂等（重复执行会报 duplicate column）。
-- 本迁移经 wrangler d1 migrations apply 一次性执行、有 d1_migrations 追踪，勿手动重复 apply。
ALTER TABLE sources ADD COLUMN trigger TEXT;               -- 该源专属触发词，空=不单独触发
ALTER TABLE sources ADD COLUMN push_all INTEGER DEFAULT 0; -- 仅 pixiv：1=全部(分批)，0=部分(取前 limit)
