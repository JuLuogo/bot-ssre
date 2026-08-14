-- 自有静态随机图库：运行时解析 random.js 的 domain/counts，图库更新无需改机器人代码。
INSERT INTO sources (adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order)
SELECT 'randompic', 1, '自有随机图库', 'https://pic.060730.xyz', NULL, 'v,h,j', 5, 1, 4
WHERE NOT EXISTS (
  SELECT 1 FROM sources WHERE adapter = 'randompic' AND site = 'https://pic.060730.xyz'
);
