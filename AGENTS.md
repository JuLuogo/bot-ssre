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

**randompic 代码与迁移已提交到本地 commit `26744d9`，但该 commit 尚未推送到 origin/main；API 审核文档已补完但也有未提交改动。**

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
1. `npx tsc --noEmit` + `npx wrangler deploy --dry-run` 做最终校验。
2. 提交文档收尾改动，然后 `git push origin main`（会同时推送 ahead 的 `26744d9`）。
3. 等 Workers Builds 构建；若 builds MCP 不在线，用 Git 状态/Cloudflare 面板确认。
4. 远程 D1 迁移：Deploy command 为「先部署再迁移」，`0005` 会自动应用（幂等，安全）。
5. 部署后线上验证：后台出现「自有随机图库」；点「推送随机新图」/ 私聊发触发词，应收到 `pic.060730.xyz` 图片。
6. 可选：审核 `docs/RANDOM_IMAGE_APIS.md` 后，再决定添加哪个第三方备用源；默认不会自动启用。

## 环境/账号备注（2026-08-14）
- Worker：`bot-ssre`；后台 `https://bot-ssre.juluogogo.workers.dev`（或 `https://bot-ces.060730.xyz`）。
- 本会话 `cloudflare-builds` / `cloudflare-observability` MCP 当前断开；`cloudflare-bindings` 仍可用。
- 当前分支 `main` 比 `origin/main` ahead 1（`26744d9`），另有文档/AGENTS 未提交改动。
