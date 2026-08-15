# 部署文档

## 前置要求
- Node.js ≥ 18、npm
- Cloudflare 账号（免费版足够；D1 + KV + Workers + Cron 都在免费额度内）
- 首次使用需登录：`npx wrangler login`
- 可选：Telegram Bot（@BotFather）、QQ 开放平台机器人、自建 RSSHub、i.pximg 反代、自建 NapCat
- 仅"本地 CLI 部署"方式需要 `npx wrangler login`；"连 Git 部署"不需要。

---

## 快速部署 · 连 Git 到新账号（推荐，KV/D1 与建表全自动）

连接 Git 仓库即可，附属资源（KV/D1）和数据库表都会在部署时自动创建，换任何账号都不用改配置。

1. **准备仓库**：把本仓库放到你的 GitHub/GitLab。
2. **面板连 Git**：Cloudflare 面板 → Workers & Pages → Create → Workers → **Connect to Git**，选中仓库与 `main` 分支。
3. **设置 Deploy command（关键，决定表能否自动建）**：改成 **先部署、再迁移**——
   ```
   npx wrangler deploy && npx wrangler d1 migrations apply acg-db --remote
   ```
   > ⚠️ 顺序不能反：库是在 `wrangler deploy` 过程中才被"自动开通"创建的，迁移必须排在它后面，否则库还没建就迁移会失败。
4. **保存并部署**。首次构建会依次：自动创建 KV + D1 `acg-db` → 部署 Worker → 跑迁移建好 6 张表。之后每次 `git push` 到 `main` 自动重部署。
5. **补密钥/变量（手动，按需）**：`ADMIN_TOKEN`（见 §5）、各渠道密钥（§7）、webhook 地址（§8）。这些是密钥/实例数据，不随仓库自动化，每个账号单独设。

> `wrangler.jsonc` 已**省略 KV/D1 的 id**，靠 automatic resource provisioning 在任意账号自动开通，所以换账号无需改配置。
> 若面板里的 Worker 名与 `wrangler.jsonc` 的 `name`（`bot-ssre`）不一致会告警，改成一致即可。

下面 §1–§6 是"本地 CLI 部署"（方式 B）的分步说明；已用上面的连 Git 方式可跳到 §7 配置密钥。

---

## 1. 安装依赖
```bash
npm install
```

## 2. 创建 D1 数据库（仅本地 CLI 方式；连 Git 会自动创建，可跳过）
```bash
npx wrangler d1 create acg-db
```
输出里会给出 `database_id`。**连 Git 自动开通时不要填 id**（保持省略）；仅本地 CLI 方式才把它填进 `wrangler.jsonc`：
```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "acg-db",
    "database_id": "把这里换成上面输出的 id",
    "migrations_dir": "migrations" }
]
```

## 3. 创建 KV 命名空间（仅本地 CLI 方式；连 Git 会自动创建，可跳过）
```bash
npx wrangler kv namespace create acg-kv
```
仅本地 CLI 方式把输出的 `id` 填进 `wrangler.jsonc` 的 `kv_namespaces[0].id`；连 Git 自动开通时保持省略。

## 4. 应用数据库迁移（schema 如何"自动写入"）

数据库表结构**不写在 `wrangler.jsonc` 里**（wrangler 配置不支持内嵌 SQL）。Cloudflare 的官方做法就是 `migrations/` 目录 + 配置里的 `migrations_dir` —— 这就是"配置驱动、创建时自动建表"的机制。

**手动执行一次（本地 CLI）：**
```bash
npx wrangler d1 migrations apply acg-db --remote   # 本地开发用 --local
```
会依次执行：`0001` 基础（settings/sources/pushed/runs + 默认数据源）、`0002` 订阅者、`0003` QQ 官方设置、`0004` 凭证、`0005` 自有静态随机图库。

**连 Git 自动构建时（推荐）：** 在 Workers Builds 的 **Deploy command** 里让每次部署自动建库并同步 schema——**先部署、再迁移**（库是部署时才自动开通的，迁移必须排在其后）：
```
npx wrangler deploy && npx wrangler d1 migrations apply acg-db --remote
```
这样任何缺失的表都会在部署时自动补齐，新增迁移也会自动跟上。

> **迁移是幂等的**：`CREATE TABLE IF NOT EXISTS`、`INSERT OR IGNORE`，且默认数据源用 `WHERE NOT EXISTS (SELECT 1 FROM sources)` 守卫——只在 sources 表为空时写入。所以上面的命令**重复执行安全，不会产生重复行**。

## 5. 设置管理口令（必须）
```bash
npx wrangler secret put ADMIN_TOKEN
```
这是保护整个管理后台（页面 + 所有 `/api` 读写）的登录口令，**不能**在后台配置（避免自我提权）。未设置时后台 fail-closed：只能看到登录页且无法读取或修改数据。

建议同时把 `wrangler.jsonc` 的 `vars.ENVIRONMENT` 改为 `production` 再部署。

## 6. 部署

**方式一 · 本地 CLI：**
```bash
npm run deploy
```

**方式二 · 连 Git 自动构建（本项目当前采用，推荐）：** 见开头的「快速部署 · 连 Git」。Deploy command 设为（**先部署再迁移**）：
```
npx wrangler deploy && npx wrangler d1 migrations apply acg-db --remote
```
之后每次 `git push` 到 `main` 自动构建部署。

> 注意 `wrangler.jsonc` 的 `name` 需与面板里的 Worker 名一致（本项目为 `bot-ssre`），否则会告警并尝试开 PR 改名。

部署完成后 Worker 地址形如 `https://<worker名>.<你的子域>.workers.dev`（本项目：`https://bot-ssre.juluogogo.workers.dev`）。

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

**个人 QQ / NapCat（按需命令，发命令实时返图）**：在 NapCat 里开启**反向 HTTP 上报（HTTP POST）**，地址填 `https://<你的worker域名>/onebot/webhook`。
- 建议在 NapCat 设一个 `secret`，并把同值填到凭证 `NAPCAT_WEBHOOK_SECRET`（命中命令时验签）；顺手关闭心跳上报。
- 回图靠 Worker 主动调用，需另配 `NAPCAT_BASE_URL` / `NAPCAT_TOKEN`（公网可达的 OneBot HTTP 地址）。
- 用法：群里 **@机器人 + 触发词 [关键词]**，私聊发送 **触发词 [关键词]**。触发词、每次张数、群聊需 @、私聊开关都在后台「提示词触发返图」卡片配置，统一存于 `ondemand` 设置键；带关键词时作为 booru tag 查询，无关键词时优先自有随机图库。

> 回调必须是 HTTPS，端口限 80/443/8080/8443 —— workers.dev 域名默认满足。

## 9. 上线验证清单
| 检查 | 方法 | 期望 |
|---|---|---|
| 后台可访问 | 浏览器打开 Worker 地址 | 先出登录页，输入 `ADMIN_TOKEN` 后进入管理后台 |
| 凭证生效 | 状态栏 pill | 对应渠道显示「已配置」 |
| 渠道连通 | 点「测试 Telegram / QQ官方 / NapCat」 | ✅ 与 bot 名称 / token 获取成功 |
| 抓取正常 | 点「立即爬取推送」 | 拉取 > 0；未配目标时提示「没有可用的推送目标」 |
| 实际送达 | 配好 chat_id 或订阅后再点一次 | 目标会话收到图片 |
| 订阅制 | 对 bot 发 `/start` | 收到「已订阅」，后台订阅者列表出现该条 |
| 随机图源已入库 | 后台「数据源」表格 | 有 18 行 `randomapi`（16 启用 / 2 需密钥关闭）+ 1 行 `randompic`；若没有，点「一键补全全部随机图 API 源」 |
| 提示词返图 | 私聊 bot 发触发词（默认 `涩图`/`色图`） | 收到图片；多次触发后「🩺 触发诊断」里 `来源=` 会在不同源间轮换 |
| 随机推送 | 点「推送随机新图」 | 结果区列出 `xxx 目标(N): ...` 与逐目标错误（若有） |
| QQ 群推送 | 点「推送随机新图」后看结果区 | 若出现 `40034105 主动消息无权限`，说明群主动推送要去 QQ 开放平台申请权限；申请不到就取消勾选「向 QQ 群主动推送」 |
| 定时任务 | Cloudflare 控制台 → Workers → 你的 Worker → Triggers | 能看到 Cron；Logs 里有每次运行记录 |

> 注意：`randompic` / `randomapi` **不参与定时抓取**，所以「立即爬取推送」的拉取数只反映 booru / Pixiv / RSS。随机图走「推送随机新图」与提示词触发。

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

