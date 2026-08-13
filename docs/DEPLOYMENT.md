# 部署文档

## 前置要求
- Node.js ≥ 18、npm
- Cloudflare 账号（免费版足够；D1 + KV + Workers + Cron 都在免费额度内）
- 首次使用需登录：`npx wrangler login`
- 可选：Telegram Bot（@BotFather）、QQ 开放平台机器人、自建 RSSHub、i.pximg 反代、自建 NapCat

---

## 1. 安装依赖
```bash
npm install
```

## 2. 创建 D1 数据库
```bash
npx wrangler d1 create acg-db
```
输出里会给出 `database_id`，把它填进 `wrangler.jsonc`：
```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "acg-db",
    "database_id": "把这里换成上面输出的 id",   // ← 替换 REPLACE_WITH_REAL_D1_ID
    "migrations_dir": "migrations" }
]
```

## 3. 创建 KV 命名空间
```bash
npx wrangler kv namespace create acg-kv
```
把输出的 `id` 填进 `wrangler.jsonc` 的 `kv_namespaces[0].id`（替换 `REPLACE_WITH_REAL_KV_ID`）。

## 4. 应用数据库迁移
```bash
npx wrangler d1 migrations apply acg-db --remote
```
会依次建表：`0001` 基础（settings/sources/pushed/runs + 默认数据源）、`0002` 订阅者、`0003` QQ 官方设置、`0004` 凭证。

> 本地开发用 `--local`，两套库互不影响。

## 5. 设置管理口令（必须）
```bash
npx wrangler secret put ADMIN_TOKEN
```
这是保护 `/api` 写操作的唯一凭证，**不能**在后台配置（避免自我提权）。生产环境未设置时，`ENVIRONMENT=production` 会拒绝所有写操作。

建议同时把 `wrangler.jsonc` 的 `vars.ENVIRONMENT` 改为 `production` 再部署。

## 6. 部署
```bash
npm run deploy
```
部署完成后控制台会打印 Worker 地址（形如 `https://acg-rank-pusher.<你的子域>.workers.dev`）。

## 7. 在后台填其余密钥
打开 Worker 地址（即管理后台），顶部填入刚才设置的 `ADMIN_TOKEN`，在「🔑 密钥与凭证」区按需填写并保存：

| 键 | 用途 | 不填的后果 |
|---|---|---|
| `TG_BOT_TOKEN` | Telegram 推送 | Telegram 渠道不可用 |
| `TG_WEBHOOK_SECRET` | Telegram 订阅制校验 | webhook 不校验来源（不推荐） |
| `QQ_BOT_APPID` / `QQ_BOT_SECRET` | QQ 官方机器人 | QQ 官方渠道与其 webhook 不可用 |
| `NAPCAT_BASE_URL` / `NAPCAT_TOKEN` | 个人 QQ 中转 | 个人 QQ 渠道不可用 |
| `PIXIV_PROXY_HOST` | Pixiv 图片反代域名（仅域名） | Pixiv 数据源自动跳过 |

这些值写入 D1，**优先于** `wrangler secret`；也可以坚持用 CLI：
```bash
npx wrangler secret put TG_BOT_TOKEN     # 等等
```
两种方式随时切换：清除后台里的值即回退到 secret。

填完点各渠道的「测试」按钮做连通性自检，应显示 ✅。

## 8. 配置 webhook（要订阅制才需要）
后台「🔗 Webhook 地址」区已生成好地址与命令，可一键复制。

**Telegram**
```bash
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
  -d "url=https://<你的worker域名>/tg/webhook" \
  -d "secret_token=<TG_WEBHOOK_SECRET>"
```
返回 `{"ok":true}` 即成功。之后用户对 bot 发 `/start` 即订阅。

**QQ 官方机器人**：在 QQ 开放平台 →「开发设置」→ 回调地址填 `https://<你的worker域名>/qq/webhook`，并勾选订阅事件（单聊消息、群 @ 消息、机器人加群）。保存时平台会发 `op=13` 验证请求，Worker 自动签名应答通过。

> 回调必须是 HTTPS，端口限 80/443/8080/8443 —— workers.dev 域名默认满足。

## 9. 上线验证清单
| 检查 | 方法 | 期望 |
|---|---|---|
| 后台可访问 | 浏览器打开 Worker 地址 | 显示管理后台 |
| 凭证生效 | 状态栏 pill | 对应渠道显示「已配置」 |
| 渠道连通 | 点「测试 Telegram / QQ官方 / NapCat」 | ✅ 与 bot 名称 / token 获取成功 |
| 抓取正常 | 点「立即爬取推送」 | 拉取 > 0；未配目标时提示「没有可用的推送目标」 |
| 实际送达 | 配好 chat_id 或订阅后再点一次 | 目标会话收到图片 |
| 订阅制 | 对 bot 发 `/start` | 收到「已订阅」，后台订阅者列表出现该条 |
| 定时任务 | Cloudflare 控制台 → Workers → 你的 Worker → Triggers | 能看到 Cron；Logs 里有每次运行记录 |

## 10. 修改定时频率
编辑 `wrangler.jsonc`（**UTC 时间**）后重新部署：
```jsonc
"triggers": { "crons": ["0 1 * * *"] }   // UTC 01:00 = 北京 09:00
```
常用：`"0 */6 * * *"` 每 6 小时；`"30 0,12 * * *"` 每天 UTC 00:30 与 12:30。改动最长需 15 分钟全球生效。

## 11. 更新与回滚
```bash
git pull && npm install          # 拉取更新
npx wrangler d1 migrations apply acg-db --remote   # 若有新迁移
npm run deploy
```
回滚：Cloudflare 控制台 → Worker → Deployments 可一键回退到上一个版本。D1 有 Time Travel（免费版保留 7 天）可恢复数据：
```bash
npx wrangler d1 time-travel restore acg-db --timestamp=<ISO时间>
```

## 12. 常见问题
**推送 0 张，errors 说「没有可用的推送目标」** — 渠道开关没开，或 chat_ids/targets 为空且无订阅者。

**Telegram 报 `chat not found`** — chat_id 不对；群/频道 id 通常是负数（如 `-1001234567890`），且必须先把 bot 加进去。

**Pixiv 拉不到** — `PIXIV_PROXY_HOST` 没配（会跳过并打日志）；或反代不能被 Telegram/QQ 的服务器公网访问，此时图片会走 Worker 下载后上传的兜底路径。

**QQ 官方发送失败 `10004 机器人不存在`** — AppID/Secret 不匹配或机器人状态异常，用「测试 QQ官方」按钮可直接定位。

**QQ 官方 webhook 配置不通过** — 确认 `QQ_BOT_SECRET` 与开放平台一致（验签用的就是它），且回调地址端口合规。

**主动消息被限频** — QQ 官方群聊认证约 60 条/分钟、每群每天 1000 条。把「单次推送上限」调小。

**改了 cron 没反应** — 传播需最多 15 分钟；先用 `/api/run` 验证业务逻辑是否正常。

