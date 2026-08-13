# 二次元插画排行 · 定时爬取与推送

定时爬取公开插画排行榜（booru / Pixiv）与 RSS / RSSHub 订阅（如推特作者更新），
按全年龄过滤、去重后，自动推送到 **Telegram** 与 **QQ（NapCat）**，并提供一个**管理后台**。
完全运行在 **Cloudflare Workers** 上。

## 功能
- 定时爬取：Cron Trigger，默认每天北京时间 09:00（UTC 01:00）。
- 数据源：Safebooru / Gelbooru、Pixiv 排行榜、Konachan（moebooru）、RSS / RSSHub。
- 全年龄过滤：booru 按 `rating`，Pixiv 按 `illust_content_type`；可信源（RSS 订阅）可跳过过滤。
- 去重：KV 记录已推送项（带 TTL），避免重复。
- 订阅制：用户对 Telegram 或 QQ 官方机器人发送 `/start` 即可自助订阅（webhook）。
- 推送渠道：Telegram（`sendPhoto`，支持自定义 **API 反代**）、**QQ 官方机器人**（QQ 开放平台 API v2）、个人 QQ（NapCat OneBot HTTP 中转）。
- 管理后台：数据源/订阅增删改、渠道与全局设置、运行历史、最近推送画廊、手动触发。
- 存储：**D1**（配置 / 推送记录 / 运行历史）+ **KV**（去重）。

## 文档
- [技术原理](docs/ARCHITECTURE.md) — 架构与数据流、存储分层取舍、Ed25519 验签、平台限制与对策
- [部署文档](docs/DEPLOYMENT.md) — 从零上线的完整步骤、webhook 配置、验证清单、常见问题
- [开发文档](docs/DEVELOPMENT.md) — 本地调试、如何扩展数据源/渠道/迁移、API 契约

## 架构
```
Cloudflare Worker
├── scheduled(cron)  ── 定时触发 ─┐
├── fetch()                       │
│    ├── /            管理后台(静态资源 ASSETS)
│    └── /api/*       后台接口
│                                 ↓
│                     pipeline.runOnce()
│    拉取(sources/*) → 过滤(filter) → 去重(KV) → 推送(channels/*) → 记录(D1)
├── D1(DB)   settings / sources / pushed / runs
└── KV       seen:*(去重) / exec:*(cron 幂等)
```

## 目录结构
```
src/
  index.ts            fetch + scheduled 入口
  pipeline.ts         编排：拉取→过滤→去重→推送→记录
  db.ts               D1 访问（settings/sources/pushed/runs/subscribers）
  creds.ts            凭证层：D1 credentials 覆盖 env（白名单 + 掩码）
  config.ts           配置门面（委托 D1）
  store.ts            KV 去重与 cron 幂等
  types.ts / http.ts / filter.ts
  telegram_bot.ts     Telegram webhook（/start 自助订阅）
  qqbot_webhook.ts    QQ 官方机器人 webhook（op=13 验证 + 订阅命令）
  qqsign.ts           QQ 回调 Ed25519 签名 / 验签
  sources/            gelbooru · moebooru · pixiv · rss（+ index 注册表）
  channels/           telegram · qqbot(QQ官方) · napcat(个人QQ)
  api.ts              /api 路由
migrations/*.sql      D1 建表：0001 基础 · 0002 订阅者 · 0003 QQ官方设置 · 0004 凭证
public/index.html          管理后台单页
wrangler.jsonc             Worker 配置（cron/KV/D1/assets/vars）
```

## 快速开始（本地）
```bash
npm install
cp .dev.vars.example .dev.vars                    # 填 TG_BOT_TOKEN / ADMIN_TOKEN 等（可留空先跑）
npx wrangler d1 migrations apply acg-db --local   # 初始化本地 D1
npm run dev                                        # 打开 http://localhost:8787
```
- `/` 即管理后台；顶部填 `ADMIN_TOKEN`（本地未设时也可操作）。
- 点“立即爬取推送”手动跑一次；未配推送目标时只拉取不发送。

## 部署到 Cloudflare
```bash
# 1) 创建 D1，把输出的 database_id 填进 wrangler.jsonc
npx wrangler d1 create acg-db
npx wrangler d1 migrations apply acg-db --remote

# 2) 创建 KV，把 id 填进 wrangler.jsonc
npx wrangler kv namespace create acg-kv

# 3) 设置密钥
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put NAPCAT_BASE_URL   # 个人QQ(NapCat) 用，可选
npx wrangler secret put NAPCAT_TOKEN      # 个人QQ(NapCat) 用，可选
npx wrangler secret put QQ_BOT_APPID      # QQ 官方机器人，可选
npx wrangler secret put QQ_BOT_SECRET     # QQ 官方机器人，可选
npx wrangler secret put TG_WEBHOOK_SECRET # Telegram 订阅制 webhook 校验，可选

# 4) wrangler.jsonc 的 vars.PIXIV_PROXY_HOST 填 i.pximg 反代域名（可选）

# 5) 部署
npm run deploy
```
> 部署后在 Cloudflare 控制台 Workers → Triggers 可见 Cron；Logs 看每次运行。

## 密钥与变量

| 名称 | 类型 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | **仅 secret** | 保护 `/api` 写操作（后台顶部输入）。不可入库。 |
| `TG_BOT_TOKEN` | secret | Telegram Bot Token（@BotFather 创建） |
| `ADMIN_TOKEN` | secret | 保护 `/api` 写操作（后台顶部输入） |
| `TG_WEBHOOK_SECRET` | secret | Telegram webhook 校验密钥（订阅制，可选） |
| `QQ_BOT_APPID` | secret | QQ 官方机器人 AppID（机器人 ID） |
| `QQ_BOT_SECRET` | secret | QQ 官方机器人 AppSecret（机器人密钥，同时用于 webhook 验签） |
| `NAPCAT_BASE_URL` | secret | QQ：你的 NapCat OneBot HTTP 地址 |
| `NAPCAT_TOKEN` | secret | QQ：NapCat access token（可选） |
| `PIXIV_PROXY_HOST` | var | i.pximg 反代域名（仅域名），空则跳过 Pixiv |
| `ENVIRONMENT` | var | 值为 production 时，未设 ADMIN_TOKEN 则拒绝写操作 |

## 数据源字段
| 字段 | 适用 | 说明 |
|---|---|---|
| adapter | 全部 | `gelbooru` / `moebooru` / `pixiv` / `rss` |
| label | 全部 | 展示名；RSS 用作 source 名 |
| site | booru/rss | booru 站点 base；**RSS 填 RSSHub 路由完整 URL** |
| tags | booru | 查询标签，如 `sort:score:desc` |
| mode | pixiv | `daily` / `weekly` / `monthly`（勿用 `_r18`） |
| limit | 全部 | 每次取前 N 条 |
| trusted | 全部 | 可信源跳过全年龄过滤（RSS 默认开） |

## 管理后台
访问 Worker 根路径，顶部填 `ADMIN_TOKEN`（写操作需要），页面自上而下：
- **状态总览**：各渠道配置状态、上次运行摘要、「立即爬取推送」、三个渠道的**连通性自检**按钮。
- **密钥与凭证**：直接填写各密钥并保存到 D1（掩码显示、标注来源 d1/env、可清除回退）。
- **Webhook 地址**：自动显示本站 `/tg/webhook` 与 `/qq/webhook`，含可一键复制的 `setWebhook` 命令。
- **数据源 / 订阅**：表格增删改、启用开关；表单随类型给出该填哪些字段的提示。
- **推送渠道与全局**：Telegram（chat_ids / API 反代）、QQ 官方机器人（targets）、个人 QQ（群号）、单次上限、去重天数。
- **订阅者**：按平台筛选、查看、删除。
- **运行历史**：每次运行的拉取/过滤/推送数，错误可展开查看全部。
- **最近推送**：图片画廊，标注来源、作者与送达渠道。

## RSSHub 集成
1. 自建 RSSHub（参见 https://docs.rsshub.app ）。
2. 后台「数据源 / 订阅」新增：adapter=`rss`，label 任意，site 填路由完整 URL，例如
   `https://你的RSSHub域名/twitter/user/某用户`。
3. `trusted` 默认开（RSS 视为可信，跳过全年龄过滤）；`limit` 控制每次取前 N 条。
4. 抓取时解析每条的图片（正文 `<img>`、`media:content`、`enclosure`），逐张推送。
- 若 RSSHub 需要鉴权 key，直接把 `?key=xxx` 带在 site URL 里。
- 推特图片多为 `pbs.twimg.com`，通常公网可拉；个别失败会自动回退为 Worker 下载后上传。

## Telegram API 反代
若出口访问 `api.telegram.org` 受限，在后台「TG API 反代 base」填你的反代域名
（如 `https://tg.example.com`）；`sendPhoto` 会拼为 `${apiBase}/bot<token>/sendPhoto`，
反代需原样转发 Bot API 路径。留空则用官方地址。

## Telegram 订阅制（用户自助订阅）
推送目标 = 后台固定 `TG chat_ids` ∪ 通过机器人 `/start` 自助订阅的用户（自动去重）。

1. （推荐）设置 webhook 密钥：`npx wrangler secret put TG_WEBHOOK_SECRET`
2. 部署后向 Telegram 注册 webhook（换成你的 token / worker 域名 / secret）：
   `curl "https://api.telegram.org/bot<token>/setWebhook" -d "url=https://<worker域名>/tg/webhook" -d "secret_token=<你的secret>"`
   （若用了 TG API 反代，把 `api.telegram.org` 换成你的反代域名）
3. 用户对机器人发送 `/start` 订阅、`/stop` 退订、`/status` 查看；后台「订阅者」区块可查看/删除。
4. 群 / 频道：把 bot 拉进去并发 `/start@你的bot`，整个群/频道即成为推送目标。

## 在后台配置密钥（D1 凭证层）
除 `ADMIN_TOKEN` 外，所有密钥/变量都可以**直接在管理后台填写**，无需 `wrangler secret` + 重新部署：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 高 | D1 `credentials` 表 | 后台「密钥与凭证」里填写的值 |
| 低 | `wrangler secret` / `vars` | D1 未配置时自动回退 |

可后台配置的键：`TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`NAPCAT_BASE_URL`、`NAPCAT_TOKEN`、`QQ_BOT_APPID`、`QQ_BOT_SECRET`、`PIXIV_PROXY_HOST`（白名单，其它键会被拒绝）。

**为什么用 D1 而不是 KV**：配置这类数据要求写入后立即一致，且读写频繁。D1 免费额度为每天 500 万行读 / 10 万行写，而 KV 免费额度每天仅 1000 次写且为最终一致（改完可能读到旧值）。所以配置、订阅、记录全部放 D1，KV 只留给「去重标记」——正好用上它的自动过期(TTL)。

**安全权衡（务必了解）**：
- D1 中的凭证是**明文存储**。能读你 D1 的人（CF 账号、`wrangler d1 execute`）就能看到原文。
- 接口只返回**掩码**（如 `1234****0000`）与来源标签，**永不回显原文**；写入是单向的。
- `ADMIN_TOKEN` **不入库**，只能 `npx wrangler secret put ADMIN_TOKEN`。它是保护后台的信任根，若也能从后台改写就形成自我提权。
- 生产环境务必设置 `ADMIN_TOKEN`；未设置时 `ENVIRONMENT=production` 会直接拒绝所有写操作。
- 想彻底避免明文，就别在后台填，继续用 `wrangler secret`——两种方式随时可切换（清除 D1 里的值即回退）。

## 连通性自检
后台状态卡右侧三个按钮，分别真实调用：
- **Telegram** → `getMe`（走你配置的 apiBase，可验证反代是否可用）
- **QQ官方** → `getAppAccessToken`（验证 AppID/Secret 是否匹配）
- **NapCat** → `get_login_info`（验证地址与 token 是否可达）

失败会回显具体 HTTP 状态与平台返回的错误信息，便于排错。

## QQ 官方机器人（QQ 开放平台）
与个人 QQ(NapCat) **并存**，可只启用其一或同时启用。官方方式无需自建服务、更稳定合规，但主动推送有频次限制。

1. 在 https://q.qq.com/ 创建机器人，取得 **AppID(机器人ID)** 与 **AppSecret(机器人密钥)**：
   `npx wrangler secret put QQ_BOT_APPID` 、 `npx wrangler secret put QQ_BOT_SECRET`
2. 开放平台「开发设置」把回调地址填为 `https://<worker域名>/qq/webhook`（必须 HTTPS，端口限 80/443/8080/8443），并订阅事件：单聊消息、群 @ 消息、机器人加群等。
   平台会先发 `op=13` 验证请求，Worker 用 AppSecret 派生的 Ed25519 私钥签名应答，自动通过。
3. 用户对机器人发 `/start` 订阅、`/stop` 退订；把机器人拉进群后 @它 发 `/start` 即订阅该群（`GROUP_ADD_ROBOT` 事件也会自动订阅）。
4. 后台「渠道与全局」勾选「启用 QQ 官方机器人」。目标可留空（全靠订阅），也可手填 `group:<group_openid>` / `user:<user_openid>`。

实现要点：
- `access_token` 由 `/app/getAppAccessToken` 获取并缓存在 KV（有效期 7200s，提前 60s 刷新）。
- 图片先经富媒体接口 URL 上传换 `file_info`，再以 `msg_type=7` 发送；若接口不接受同时带文案，会自动回退为仅图片。
- 入站回调按官方规范校验 Ed25519 签名（`X-Signature-Ed25519` + `X-Signature-Timestamp`，签名体为 `timestamp + body`）。
- **注意主动消息频控**：群聊认证机器人约 60 条/分钟、每群每天 1000 条，未认证更低。建议把「单次推送上限」设小些。
- `openid` 按 AppID 隔离，更换机器人需要用户重新订阅。

## QQ（NapCat，个人号）
Worker 无法常驻长连接，故 QQ 走**外部 NapCat 中转**：
1. 在你的机器/服务器运行 NapCat，开启 OneBot v11 **HTTP 服务端**。
2. `NAPCAT_BASE_URL` 填该 HTTP 地址，`NAPCAT_TOKEN` 填 access token（若开启）。
3. 后台「QQ 群号」填目标群并勾选启用。
- Worker 调用 `POST {base}/send_group_msg`，用图文消息段发送。

## API 参考
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 环境、配置、上次运行、各项是否已配置 |
| GET | `/api/recent` | 最近推送记录 |
| GET | `/api/runs` | 运行历史 |
| POST | `/api/run` | 手动触发一次（需 token） |
| GET | `/api/sources` | 数据源列表 |
| POST | `/api/sources` | 新增/更新数据源（带 id 即更新，需 token） |
| DELETE | `/api/sources?id=` | 删除数据源（需 token） |
| GET / POST | `/api/config` | 读 / 写渠道与全局设置（POST 需 token） |
| GET | `/api/subscribers` | 订阅者列表 |
| DELETE | `/api/subscribers?id=` | 删除订阅者（需 token） |
| GET | `/api/credentials` | 凭证状态（只含掩码与来源） |
| POST | `/api/credentials` | 写入凭证到 D1（白名单，需 token） |
| DELETE | `/api/credentials?name=` | 清除 D1 凭证并回退 secret（需 token） |
| POST | `/api/test?target=` | 连通性自检：telegram / qqbot / napcat（需 token） |
| POST | `/tg/webhook` | Telegram 更新回调（/start /stop /status） |
| POST | `/qq/webhook` | QQ 官方机器人回调（op=13 验证 + 订阅命令） |

写操作请求头：`Authorization: Bearer <ADMIN_TOKEN>`。

## 修改定时频率

编辑 `wrangler.jsonc` 的 `triggers.crons`（UTC 时间）。例：
`"0 1 * * *"` = 每天北京 09:00；`"0 */6 * * *"` = 每 6 小时。改后重新部署。

## 说明与风险
- 分级：booru / Pixiv 默认只推全年龄；RSS 订阅视为可信不过滤，请自行确认来源。
- 去重：`seenTtlDays` 天后同一条可再次推送；榜单每日变化，通常不会刷屏。
- QQ 走非官方框架 NapCat，有账号风险，请知悉。
- 版权：仅供个人自用；公开分发 / 商用请自行确认各来源授权。
- D1 免费额度（写 10 万行/天、读 500 万行/天）对本场景绰绰有余。



