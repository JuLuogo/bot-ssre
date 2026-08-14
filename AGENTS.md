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
