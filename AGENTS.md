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
- **不要新增公开（免鉴权）的 `/api` 端点**。例外：webhook `/tg/webhook`、`/qq/webhook`、`/onebot/webhook` 各自验签，保持公开。

### 6. 按需图内容保持全年龄
OneBot 按需命令（`涩图` / `/setu`）只返回 `rating:safe`（经 `isAllAges` 过滤），**不接 explicit/NSFW 分级**。

### 7. 验证
- 后端改动跑 `npx tsc --noEmit`。
- 需要本地跑时用 `npx wrangler dev --local`；测登录要注入密钥（`--var ADMIN_TOKEN:<值>` 或写 `.dev.vars`），本地 D1 先 `npx wrangler d1 migrations apply acg-db --local` 建表。
- 收尾清理临时文件、还原 `.dev.vars` 等本地改动。

---

# 当前工作进度（截至 2026-08-14）

> 本节记录进行中的工作终止点，供下一次开工接续。**更新本文件时请顺带刷新本节。**

## 已完成并已推送（线上生效）
- 后台全量登录门禁（`src/auth.ts`，ADMIN_TOKEN 口令，fail-closed）✅ 已部署
- QQ 官方回调 op=13 走快路径（Worker Secret 优先，2ms）→ **回调验证已通过** ✅
- Pixiv 榜单 API 反代 `PIXIV_API_BASE`（绕开 Cloudflare IP 被 Pixiv 封 403）✅ 已部署
- 手动「推送随机新图」按钮（可填张数、不去重、随机 booru）✅ 已部署
- 提示词触发返图扩展到全平台（TG / QQ官方 / NapCat）+ 触发词/张数后台可配 ✅ 已部署

## 进行中：接入自有静态随机图库（randompic）

**randompic 代码、迁移和 API 审核文档已推送到 origin/main（randompic commit `26744d9`，文档收尾 commit `b67ca7c`）；等待 Workers Builds 自动部署后做线上验证。**

| 状态 | 文件 | 说明 |
|---|---|---|
| 新增 ✅ | `src/sources/randompic.ts` | 读 `random.js` counts → 服务端随机编号 → 拼 `{site}/ri/{type}/{num}.webp`；每类 HEAD 健康检查；manifest 缓存 KV 15min；单批 Set 去重 |
| 新增 ✅ | `migrations/0005_randompic.sql` | 默认插入自有图库数据源（幂等，已本地验证重复执行只 1 条） |
| 修改 ✅ | `src/types.ts` | `SourceConfig.adapter` 加 `randompic` |
| 修改 ✅ | `src/sources/index.ts` | 注册 randompic 适配器 |
| 修改 ✅ | `src/ondemand.ts` | `fetchRandomIllusts` 无关键词时优先 randompic，带关键词回退 booru |
| 修改 ✅ | `public/index.html` | 下拉加 randompic 选项 + hint |
| 修改 ✅ | `docs/DEPLOYMENT.md` / `.gitignore` | 文档与忽略 `.serena/` |
| 新增 ✅ | `docs/RANDOM_IMAGE_APIS.md` | 已补完 7 节、共 50 个候选/实测项，并区分推荐、待审、候选、失效，不会自动启用第三方源 |

**本地验证结果（可信）：**
- `npx tsc --noEmit` ✅ EXIT:0
- 迁移幂等：独立本地 D1 连续 apply 两次，randompic 数据源仅 1 条 ✅
- 适配器执行测试：取 10 张 → 10 张去重、全部 `pic.060730.xyz`、自动跳过当前 404 的 `j` 类、第二次调用命中 KV 缓存（0 次外部请求）✅

**关键事实（勿再踩坑）：**
- 图片域名**只用 `https://pic.060730.xyz`**；`pic.0721030.xyz` 不可用（523），**忽略不探测**。
- 图库当前 `h=979, v=3596, j=1793`，`j` 路径当前 404 → 适配器自动跳过。
- 自有图库已确认 **100% 全年龄**，适配器标 `rating: "safe"`，无需再过滤。

## 待办（下次开工按序执行）
1. 线上验证 randompic + randomapi（见下）。
2. 部署后线上验证：后台「数据源」新增一行选 `randomapi` → 下拉选一个源（如 `pic-re`/`alcy-moe`）启用 → 点「推送随机新图」/ 私聊发触发词，应收到该源的图片。
3. randompic：后台出现「自有随机图库」；无关键词返图应来自 `pic.060730.xyz`。
4. 逐个启用第三方源观察错误/耗时；被 IP 风控的源（nekos.best/waifu.im/lolicon）会自动故障切换。

## 已完成：第三方随机图 API 注册表（randomapi）— commit `8519d1f` 已推送

- `src/sources/randomapi_providers.ts`：审核通过的源固定注册表（json/redirect/direct 三协议 + needsKey 锁定项）；后台只能选 slug，不能填任意 URL（防 SSRF）。
- `src/sources/randomapi.ts`：按协议取稳定图片 URL，https+域名白名单/扩展名校验、去重、单源上限 6、超时 12s。
- `ondemand.fetchRandomIllusts`：无关键词聚合 randompic+randomapi 随机顺序故障切换；带关键词走 booru。
- `api`：`GET /api/providers`；`/api/sources` 校验 randomapi slug、需密钥拒启用。
- 后台数据源表单加 randomapi 选项 + provider 下拉。
- 用户审核结论：`docs/RANDOM_IMAGE_APIS.md` 第 6 节全部不接，其余接入。
- 本地实测：redirect(alcy)/direct(pic.re)/json(nekosia,nekos-life) 均返回合法去重 URL；needsKey/未知 slug 返回空；非 200 源自动回退（nekos.best/lolicon 从本机 IP 被 403，属预期）。

## 环境/账号备注（2026-08-15）
- Worker：`bot-ssre`；后台 `https://bot-ssre.juluogogo.workers.dev`（或 `https://bot-ces.060730.xyz`）。
- `randompic`(commit `26744d9`) 与 `randomapi`(commit `8519d1f`) 均已推送 origin/main。
- 本会话 `cloudflare-builds` / `cloudflare-observability` MCP 断开；`cloudflare-bindings` 可用。工作区 `.claude/` 未跟踪（计划/临时目录，勿提交）。

## 进行中：QQ 官方「触发词无反应 / 群聊收不到推送」修复（2026-08-15）

用户实测症状：① 私聊发触发词无任何反应；② 后台「推送随机新图」能到私聊，**群聊收不到**；③ `/start` 能正常回复。

已定位并修复（本地 `npx tsc --noEmit` ✅、`wrangler deploy --dry-run` ✅、matchTrigger 13 例单测全 PASS）：

| 问题 | 根因 | 修复 |
|---|---|---|
| 触发词无反应 | webhook 里同步做「抓图 + 富媒体上传 + 发送」耗时数秒，QQ/TG/NapCat 侧先超时断连 → Worker 请求上下文被取消，发送半途中止（`/start` 只发文本很快所以正常） | 三个 webhook 全部改为**立刻回 200 + `ctx.waitUntil()` 后台完成**（`qqbot_webhook.ts` / `telegram_bot.ts` / `onebot_webhook.ts`，入口 `index.ts` 传 `ctx`） |
| 多张图只到第一张 | 同一 `msg_id` 被动回复必须带**不同 `msg_seq`**，否则被 QQ 当重复消息丢弃 | `sendImage`/`sendText` 增加 `msgSeq` 参数，返图循环里递增 |
| 群聊收不到主动推送 | QQ 官方对**群主动消息**有报备/频次限制（被动回复不受限） | 记住该会话最近 msg_id（KV `qqbot:lastmsg:<target>`，TTL 270s），`qqbot.push` **优先按被动回复发**，失败再退回主动消息 |
| 看不到失败原因 | 「推送随机新图」只 toast 错误条数；错误文本是英文原始 JSON | `explainQQError()` 按 message 关键字补中文提示（不硬编码官方码值，原始返回保留）；后台推送结果**直接展开错误列表**，并新增 `summary.notes` 显示本次实际尝试的渠道与目标（可判断群是不是根本没进目标列表） |
| 发「色图」不触发 | 后台触发词是「涩图」，与「色图」是不同汉字 | `matchTrigger` 归一化：**色/涩 同字**、ASCII 大小写、全角空格、开头残留 `@xxx`；默认触发词补 `色图`、`来张图`（关键词 tag 仍取原文，不改写） |

**待线上验证（部署后按序）：**
1. 私聊发「涩图」/「色图」→ 应返图（若仍无反应，看后台运行历史/日志）。
2. 群里 @机器人 发触发词 → 应返图（被动回复，不占额度）。
3. **群里先随便发一条消息**，5 分钟内点后台「推送随机新图」→ 应能进群（走被动窗口）；结果区会列出 `qqbot 目标(N): group:… , user:…` 与失败原因。
4. 若群里 5 分钟窗口外仍收不到，且错误提示「主动消息待审核/未报备」→ 需去 QQ 开放平台申请群主动消息额度，这是平台限制而非代码问题。
5. randompic / randomapi 的线上验证（见上一节待办）仍未做。

