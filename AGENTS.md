# AGENTS.md — 本仓库协作约定（bot-ssre）

面向 AI 编码代理的固定流程。**开工前先读本文件并遵守。** 沟通与文档一律用简体中文。

## 项目速览
- Cloudflare Workers 应用（ACG 插画排行推送 + OneBot 按需返图）。入口 `src/index.ts`。
- 绑定：D1 `DB`（数据库名 `acg-db`）、KV `KV`、静态后台 `public/index.html`（ASSETS）。
- 部署：GitHub 仓库连 Cloudflare **Workers Builds**，push 到 `main` 自动构建部署。

## 固定流程（务必遵守）

### 1. 改完必须提交并推送到 main
Workers Builds 从 GitHub 拉代码构建；**只在本地改、不 push，线上不会更新**（本项目踩过这个坑）。
每次改完：`npx tsc --noEmit` 校验 → commit → `git push origin main` → 再看构建结果。

### 2. 部署靠自动开通，不手动建资源
- `wrangler.jsonc` **省略 KV/D1 的 id**，靠 automatic resource provisioning 在任意账号自动创建；换账号无需改配置。
- Workers Builds 的 **Deploy command 固定为「先部署再迁移」**：
  ```
  npx wrangler deploy && npx wrangler d1 migrations apply acg-db --remote
  ```
  顺序不能反：库是在 `wrangler deploy` 时才自动开通的，迁移必须排在其后。
- 环境变量/密钥（`ADMIN_TOKEN`、各渠道 token、webhook 地址）是实例数据，**每个账号手动设，不进仓库**。

### 3. 迁移必须幂等
`migrations/*.sql` 要能重复执行不报错、不产生重复数据：用 `CREATE TABLE IF NOT EXISTS`、`INSERT OR IGNORE`，种子数据用 `... SELECT ... WHERE NOT EXISTS (...)` 守卫。

### 4. 用 Cloudflare MCP 操作云端
建库/建表/查数据用 `cloudflare-bindings`（`d1_database_query` 等）；查构建用 `cloudflare-builds`；查运行日志用 `cloudflare-observability`。

### 5. 后台必须保持登录保护（安全红线）
- 后台页 + **所有 `/api`（读和写）** 都要经 `src/auth.ts` 的 `isAuthed`（用 `ADMIN_TOKEN` 登录，cookie 会话）。
- **fail-closed**：未设 `ADMIN_TOKEN` 时后台完全锁死。不要为了方便改成免鉴权。
- `assets.run_worker_first` 必须为 `true`，否则静态页会绕过 Worker 门禁。
- **不要新增公开（免鉴权）的 `/api` 端点**。例外：webhook `/tg/webhook`、`/qq/webhook`、`/onebot/webhook` 各自验签，保持公开；`GET /img/<key>` 图片中转出口保持公开（key 为 128bit 随机不可枚举、只吐图片字节、不涉后台数据，QQ 与画廊都靠它取图）。

### 6. 按需图内容保持全年龄
OneBot 按需命令（`涩图` / `/setu`）只返回 `rating:safe`（经 `isAllAges` 过滤），**不接 explicit/NSFW 分级**。

### 7. webhook 必须立即应答，重活交给 `waitUntil`
「抓图 → 富媒体上传 → 发送」要数秒；在 webhook 请求里同步做完，平台会先超时断连，而**客户端断连会取消 Worker 请求上下文**，发送被中途掐断且完全静默（踩过这个坑，排查代价很大）。
三个 webhook（`qqbot_webhook.ts` / `telegram_bot.ts` / `onebot_webhook.ts`）统一：验签与触发匹配留在请求内 → **立刻回 200** → `ctx.waitUntil()` 里完成抓图与发送。
后台任务失败要**回一句话告诉用户**，不要只 `console.warn`。

### 8. 图源分工：榜单源进 cron，随机源只服务按需
- 榜单源 `gelbooru` / `moebooru` / `pixiv` / `rss` → 参与 `runOnce`（定时 + 立即运行）。
- 随机源 `randompic` / `randomapi` → **被 `runOnce` 显式排除**，只服务「提示词触发返图」与「推送随机新图」。
理由：16 个启用的第三方 API 若每次 cron 都遍历会逼近子请求上限；随机图 id 每次都不同，会挤占 `perRunTotalCap` 并往去重库灌无意义 key。详见 `docs/ARCHITECTURE.md` 5.1。

### 9. 第三方随机图 API 只能来自固定注册表
`src/sources/randomapi_providers.ts` 是唯一来源，后台只能选 slug、**不能填任意 URL**（否则等于开了 SSRF 入口）。
最终图片 URL 强制 https + `imageHosts` 白名单（域名不固定的源退化为图片扩展名校验）。`needsKey` 的源可入库但拒绝启用。
**改注册表后要同步 `migrations/0006_randomapi_sources.sql`**；审核结论只记在 `docs/RANDOM_IMAGE_APIS.md`，未通过的不进注册表。

### 10. QQ 群主动消息无权限是平台限制，别再加重试/队列
向群发主动消息返回 `{"code":40034105,"message":"主动消息失败, 无权限"}`（实测：同一次推送 `user:` 成功、`group:` 全失败）。
带 `msg_id` 的被动回复不需要该权限，所以群里关键词返图是好的。已有对策：`qqbot.push` 复用 KV `qqbot:lastmsg:<target>` 的 5 分钟窗口；配置 `qqbot.groupActivePush=false` 时直接过滤掉 `group:` 目标。
用户已否决「失败挂队列、等群内下次发言补发」的方案（行为不可预期）。同一 `msg_id` 回复多条必须给不同 `msg_seq`。

### 11. 验证
- 后端改动跑 `npx tsc --noEmit`，再跑 `npx wrangler deploy --dry-run`。
- 改了 `public/index.html` 的内联脚本，至少做一次语法校验（`new Function(scriptText)`）并确认新增元素 id 存在。
- 迁移改动：用独立本地 D1 验证幂等 —— `npx wrangler d1 migrations apply acg-db --local --persist-to .tmp-d1`，再把同一 SQL `--file` 执行两遍，确认行数不变。
- 需要本地跑时用 `npx wrangler dev --local`；测登录要注入密钥（`--var ADMIN_TOKEN:<值>` 或写 `.dev.vars`）。
- 收尾清理临时文件（`.tmp-*`）、还原 `.dev.vars` 等本地改动。

---

# 当前工作进度（截至 2026-08-15）

> 本节只记「现在的状态 + 下一步」。设计原理与踩坑结论沉淀在 `docs/ARCHITECTURE.md`，
> 第三方源审核结论在 `docs/RANDOM_IMAGE_APIS.md`。**更新本文件时请顺带刷新本节。**

## 状态：功能已全部完成并推送，QQ 官方端用户实测无 bug

| 模块 | 状态 |
|---|---|
| 后台全量登录门禁（ADMIN_TOKEN，fail-closed） | ✅ 线上生效 |
| QQ 官方回调 op=13 快路径（Worker Secret，~2ms） | ✅ 回调验证通过 |
| Pixiv 榜单反代 `PIXIV_API_BASE`（绕开 Pixiv 封 Cloudflare IP） | ✅ 线上生效 |
| 提示词触发返图（TG / QQ官方 / NapCat，触发词与张数后台可配） | ✅ 用户实测正常 |
| 手动「推送随机新图」（张数可填、不去重） | ✅ 私聊正常；群聊受 QQ 主动消息权限限制 |
| 自有静态图库 `randompic`（`pic.060730.xyz`） | ✅ 已接入并默认优先 |
| 第三方随机图 API `randomapi`（18 源预置，16 启用 / 2 需密钥关闭） | ✅ 已入库 |
| 触发诊断日志（KV 环形，后台「🩺 触发诊断」） | ✅ 可用 |

## 剩余待办

1. **用户侧**：去 QQ 开放平台确认能否开通群主动消息权限。开不了就在后台取消勾选「向 QQ 群主动推送」，
   群里改为只用关键词触发（见固定约定第 10 条）。开通入口未在官方文档核实到确切路径，可问「QQ 机器人反馈助手」。
2. **线上验证随机源**：后台「数据源」应有 18 行 `randomapi`（没有就点「一键补全全部随机图 API 源」）；
   多次触发返图后在「🩺 触发诊断」里看 `来源=` 是否在不同源之间轮换，以确认多源随机 + 故障切换生效。
3. 可选：若希望每日定时推送也混入随机图，需要新增开关（当前按第 8 条约定刻意排除）。

## 已完成：pixiv 图经 R2 中转发 QQ（2026-08-15）

QQ 国内服务器拉不动慢反代（pixiv 回源冷启动 10s+ → `40093007 富媒体文件下载失败`），而随机图（含
自有 `pic.060730.xyz` 静态图）秒回、QQ 能拉到。QQ 接口只收 URL、不收字节（已查官方 botpy SDK 证实）。

**中转只为喂 QQ，发完即删、不存图**。关键取舍：管理员浏览器能直接访问反代（`i.060730.xyz`），
所以**后台画廊直接用原反代地址预览**，中转图不必保留——因此推送记录里存的是原图地址，不是 `/img/<key>`。

- 新增 R2 桶 `bot-ssre-relay`（`wrangler.jsonc` 靠自动开通；换账号首次若没自动建，
  用 `npx wrangler r2 bucket create bot-ssre-relay --location apac`）。
  **地区只能在创建时定、且不可改**：配置文件里 `r2_buckets` 只有 `jurisdiction`、没有 location 字段，
  自动开通会默认建到美西(WNAM)。桶在美西会让 Worker 读 R2 跨太平洋、拖慢 QQ 那次拉取，
  所以应删掉重建为 **APAC**（控制台选 Asia-Pacific，或 CLI 加 `--location apac`）。桶是空的(发完即删)，删了无损。
- `src/relay.ts`：`stageImage` 下载存 R2 → **公开路由 `GET /img/<key>`**（`serveImage`）秒回 →
  `dropImage` 发送后立即删。`pruneOrphans` 每日 cron 只兜底清 6 小时以上的崩溃孤儿。key 128bit 随机不可枚举。
- 中转逻辑在**渠道层**（`channels/qqbot.ts` 的 `sendImage`→`maybeStageForQQ`）：仅当图片 host ==
  `PIXIV_PROXY_HOST` 且配了 `PUBLIC_BASE_URL` 时中转，QQ 发 `{PUBLIC_BASE_URL}/img/<key>`，`finally` 里删。
  其它渠道（TG 全球可达）和画廊记录都用原图地址，pipeline 不参与中转。
- 新增可后台配的凭证 `PUBLIC_BASE_URL`（如 `https://bot-ces.060730.xyz`，须是 QQ 能访问到的域名）。
- **为什么不用第三方免费图床 / 为什么不存图**：QQ 拉图要「国内可达 + 快」，境外免费床国内不稳且有存活/条款风险；
  而中转的唯一目的就是喂 QQ 那一下，喂完 QQ 已存到自己服务器（`/files` 阶段取走），R2 副本即可丢，常驻≈0。

**待线上验证**：设 `PUBLIC_BASE_URL` 后触发/推送 pixiv 图，QQ 应能收到；画廊用原反代地址预览正常。


## 关键事实（勿再踩坑 / 勿再猜）

- 自有图库只用 `https://pic.060730.xyz`；`pic.0721030.xyz` 不可用（523），**忽略不探测**。
  图库 counts 由 `random.js` 运行时读取（曾见 `h=979, v=3596, j=1793`，`j` 当时 404 → 适配器自动跳过）。
  用户已确认该库 **100% 全年龄**，适配器直接标 `rating:"safe"`。
- QQ 群主动消息 `40034105` 无权限：平台限制，代码绕不过去（详见固定约定第 10 条）。
- `nekos-best` / `waifu-im` 对机房 IP 有风控（本机实测返 0 张），保持启用，线上会自动切下一个源。
- 触发词匹配对「色 / 涩」不区分，另兼容 ASCII 大小写、全角空格、开头残留 `@xxx`。

## 环境/账号备注

- Worker：`bot-ssre`；后台 `https://bot-ssre.juluogogo.workers.dev`（或 `https://bot-ces.060730.xyz`）。
- 本会话 `cloudflare-builds` / `cloudflare-observability` MCP 断开（HTTP 405），因此线上日志/构建只能靠后台诊断卡片与运行历史。
- 工作区 `.claude/` 未跟踪（计划/临时目录，勿提交）。

