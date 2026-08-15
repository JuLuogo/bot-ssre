-- 预置全部审核通过的第三方随机图 API 数据源（幂等：按 adapter+site(slug) 去重）。
-- site 存 provider slug（不是 URL）；需要密钥的 provider 插入但 enabled=0，后台可见不可用。
-- 本文件由 registry 生成，改注册表后请同步本文件（见 docs/RANDOM_IMAGE_APIS.md）。

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'Lolicon（Pixiv 系，可关键词）', 'lolicon', NULL, NULL, 3, 1, 10
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'lolicon');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'nekos.best（全 SFW）', 'nekos-best', NULL, NULL, 3, 1, 11
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'nekos-best');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'Nekosia（全 SFW）', 'nekosia', NULL, NULL, 3, 1, 12
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'nekosia');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'nekos.life', 'nekos-life', NULL, NULL, 3, 1, 13
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'nekos-life');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'PurrBot（SFW neko）', 'purrbot', NULL, NULL, 3, 1, 14
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'purrbot');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'waifu.im（默认 SFW）', 'waifu-im', NULL, NULL, 3, 1, 15
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'waifu-im');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'nekos.dev v3（SFW）', 'nekos-dev', NULL, NULL, 3, 1, 16
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'nekos-dev');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, '栗次元 · 萌图', 'alcy-moe', NULL, NULL, 3, 1, 17
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'alcy-moe');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, '栗次元 · 竖屏', 'alcy-mp', NULL, NULL, 3, 1, 18
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'alcy-mp');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, '栗次元 · 原神', 'alcy-ycy', NULL, NULL, 3, 1, 19
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'alcy-ycy');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'Paugram 壁纸', 'paugram', NULL, NULL, 3, 1, 20
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'paugram');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'LoliAPI · ACG', 'loliapi-acg', NULL, NULL, 3, 1, 21
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'loliapi-acg');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'Jitsu 随机图', 'jitsu', NULL, NULL, 3, 1, 22
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'jitsu');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'Nekos API（SFW 直转）', 'nekosapi-file', NULL, NULL, 3, 1, 23
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'nekosapi-file');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, 'pic.re（官方 SFW，7 万+）', 'pic-re', NULL, NULL, 3, 1, 24
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'pic-re');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 1, '樱花 DMOE 随机图', 'dmoe', NULL, NULL, 3, 1, 25
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'dmoe');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 0, 'Unsplash（需 Access Key）', 'unsplash', NULL, NULL, 3, 1, 26
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'unsplash');

INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randomapi', 0, 'Waifu.it（需 Token）', 'waifu-it', NULL, NULL, 3, 1, 27
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE adapter = 'randomapi' AND site = 'waifu-it');

