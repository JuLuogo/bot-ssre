# 开发文档

## 本地环境
```bash
npm install
cp .dev.vars.example .dev.vars                     # 填本地密钥（可全空先跑）
npx wrangler d1 migrations apply acg-db --local     # 初始化本地 D1
npm run dev                                         # http://localhost:8787
npx tsc --noEmit                                    # 类型检查
```
本地 D1/KV 由 miniflare 模拟，数据在 `.wrangler/state/`（已被 .gitignore 忽略）。`.dev.vars` 里的键会作为 secret 注入，启动日志会列出所有 binding。

## 目录职责
```
src/
  index.ts           入口：fetch 路由（webhook → /api → 静态资源）+ scheduled，并把 ctx 传给 webhook
  pipeline.ts        编排：拉取 → 过滤 → 去重 → 装配渠道 → 推送 → 记录（榜单源；随机源被排除）
  ondemand.ts        按需返图：触发词匹配、随机源聚合与故障切换、ondemand 配置读写
  types.ts           Illust / SourceAdapter / ChannelAdapter / AppConfig / Env
  http.ts            fetchJson + 统一 UA + 超时
  filter.ts          rating 归一化与全年龄判定
  store.ts           KV：去重标记、cron 幂等
  diag.ts            KV 环形诊断日志（后台「🩺 触发诊断」）
  auth.ts            后台登录门禁：ADMIN_TOKEN 口令 + HMAC cookie 会话，fail-closed
  db.ts              D1：settings / sources / pushed / runs / subscribers
  creds.ts           凭证层：D1 credentials 覆盖 env（白名单 + 掩码）
  config.ts          配置门面（委托 db.ts）
  api.ts             /api/* 全部路由（除 login/logout 外一律需鉴权）
  telegram_bot.ts    Telegram webhook（触发词返图 + 订阅命令）
  qqbot_webhook.ts   QQ 官方 webhook（op=13 + 事件 + 触发词返图）
  onebot_webhook.ts  个人 QQ（NapCat）上报入口
  qqsign.ts          Ed25519 派生 / 签名 / 验签
  sources/           数据源适配器 + 注册表（含 randomapi_providers 固定注册表）
  channels/          推送渠道适配器
public/index.html    管理后台（原生 JS 单页，无构建步骤）
migrations/          D1 迁移，按序号执行
```

三个 webhook 的共同结构：便宜的判断（验签、触发匹配）留在请求内 → **立刻回 200** → `ctx.waitUntil()` 里抓图并发送。原因见 [技术原理](ARCHITECTURE.md) 第 14 节，不要改回同步。

## 调试手法

**手动触发定时任务**（wrangler 4 的本地路径）：
```bash
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```
或直接打业务接口（推荐，能直接看到 summary）：
```bash
curl -X POST http://localhost:8787/api/run
```

**查看/改本地数据库**：
```bash
npx wrangler d1 execute acg-db --local --command "SELECT * FROM sources"
npx wrangler d1 execute acg-db --local --command "SELECT name, source, updated_at FROM credentials"
```

**线上日志**：`npx wrangler tail`，或控制台 → Worker → Logs（已开启 observability）。

**模拟 QQ 官方 webhook**（需要构造 Ed25519 签名）：
```js
// sign.mjs：node sign.mjs <secret> <timestamp> <body>
import crypto from "node:crypto";
const PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
let seed = Buffer.from(process.argv[2], "utf8");
while (seed.length < 32) seed = Buffer.concat([seed, seed]);
const key = crypto.createPrivateKey({ key: Buffer.concat([PREFIX, seed.subarray(0, 32)]), format: "der", type: "pkcs8" });
console.log(crypto.sign(null, Buffer.from(process.argv[3] + process.argv[4], "utf8"), key).toString("hex"));
```
```bash
BODY='{"op":0,"t":"C2C_MESSAGE_CREATE","d":{"id":"M1","content":"/start","author":{"user_openid":"U1"}}}'
SIG=$(node sign.mjs "$QQ_BOT_SECRET" 1725442341 "$BODY")
curl -X POST http://localhost:8787/qq/webhook -H "X-Signature-Ed25519: $SIG" \
  -H "X-Signature-Timestamp: 1725442341" --data-binary "$BODY"
```
`op=13` 验证不需要签名头，直接 POST `{"op":13,"d":{"plain_token":"...","event_ts":"..."}}` 即可看应答。

**模拟 Telegram webhook**：
```bash
curl -X POST http://localhost:8787/tg/webhook -H "Content-Type: application/json" \
  -d '{"message":{"chat":{"id":123,"type":"private","first_name":"Tester"},"text":"/start"}}'
```

## 扩展：新增一个数据源
1. 在 `src/sources/` 建 `yoursite.ts`，实现 `SourceAdapter`：
```ts
import type { Env, Illust, SourceAdapter, SourceOptions } from "../types";
import { fetchJson } from "../http";
import { normalizeBooruRating } from "../filter";

export const yoursite: SourceAdapter = {
  name: "yoursite",
  async fetchRanking(_env: Env, opts: SourceOptions): Promise<Illust[]> {
    const data = await fetchJson<YourResp>(`${opts.site}/api?limit=${opts.limit}`);
    return data.items.map((p): Illust => ({
      source: "yoursite",
      id: String(p.id),
      title: p.title ?? `#${p.id}`,
      author: p.artist ?? "",
      imageUrl: p.image,        // 必须是第三方服务器可直接拉取的地址
      pageUrl: p.url,
      rating: normalizeBooruRating(p.rating),   // 或自行判定
      score: Number(p.score) || 0,
      tags: p.tags ?? [],
    }));
  },
};
```
2. 注册进 `src/sources/index.ts` 的 `ADAPTERS`。
3. 在 `src/types.ts` 的 `SourceConfig.adapter` 联合类型里加上 `"yoursite"`。
4. 后台「数据源」表单的 `<select id="f_adapter">` 加一个 `<option>`，并在 `ADAPTER_HINT` 里补一句该填哪些字段。
5. 用后台新增该源 → 点「立即爬取推送」验证 `fetched` 是否 > 0。

注意：`SourceOptions` 是所有源参数的并集，只取你需要的字段；`limit` 请在适配器内部生效（URL 参数或 `slice`）。

## 扩展：新增一个推送渠道
1. 在 `src/channels/` 实现 `ChannelAdapter`：
```ts
export const yourchannel: ChannelAdapter = {
  name: "yourchannel",
  async push(env, illust, target, opts): Promise<void> {
    // 失败请 throw，pipeline 会捕获并写入 errors
  },
};
```
2. `types.ts` 的 `AppConfig` 加该渠道配置（`{ enabled, targets }` 形状）。
3. 加一条 migration，把默认设置 seed 进 `settings`。
4. `db.ts` 的 `loadConfig` / `saveSettings` 各加一行。
5. `pipeline.ts` 装配渠道处加一段（记得合并订阅者：`listSubscriberChatIds(env, "<platform>")`）。
6. `api.ts` 的 `/api/config` POST 里补该字段；`/api/status` 加 configured 标记；需要的话给 `/api/test` 加自检分支。
7. 后台加对应表单块与 `saveConfig` 字段。

## 扩展：新增数据库迁移
```bash
npx wrangler d1 migrations create acg-db add_something   # 生成 migrations/000N_add_something.sql
npx wrangler d1 migrations apply acg-db --local
```
迁移只能追加、不可修改已应用的文件（wrangler 用 `d1_migrations` 表记录）。写 DDL 时用 `IF NOT EXISTS`，seed 数据用 `INSERT OR IGNORE` 或 `INSERT ... SELECT ... WHERE NOT EXISTS (...)`，保证重复执行安全。

验幂等（不要污染主 `.wrangler` 状态）：
```bash
npx wrangler d1 migrations apply acg-db --local --persist-to .tmp-d1
npx wrangler d1 execute acg-db --local --persist-to .tmp-d1 --file migrations/000N_x.sql   # 再跑两遍
npx wrangler d1 execute acg-db --local --persist-to .tmp-d1 --command "SELECT COUNT(*) FROM sources"
rm -rf .tmp-d1
```

`migrations/0006_randomapi_sources.sql` 是**由 `randomapi_providers.ts` 生成**的（18 条 provider seed）。改注册表后要同步这个文件；也可以让用户点后台「一键补全全部随机图 API 源」（`POST /api/sources/seed-providers`），它与迁移等效但不依赖迁移执行。

## 扩展：新增可后台配置的凭证
在 `src/creds.ts` 的 `CREDENTIAL_KEYS` 里加键名即可——后台表格、掩码、来源标签、写入白名单全部自动生效。同时在 `types.ts` 的 `Env` 里声明该字段。
**不要**把 `ADMIN_TOKEN` 加进去。

## API 契约
所有响应都是 `{ ok: boolean, ... }`；失败时带 `error` 字段。

鉴权：**除 `/api/login`、`/api/logout` 与三个 webhook 外，所有 `/api/*`（读和写）都要过 `auth.isAuthed`**。
先 `POST /api/login {password}`（口令 = `ADMIN_TOKEN`）拿 cookie 会话，后续带 cookie。未设 `ADMIN_TOKEN` 时后台整体锁死（登录返回 503）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` · `/api/logout` | 唯一免鉴权的两个 `/api`；登录下发 HMAC cookie |
| GET | `/api/status` | 环境、完整配置、上次运行、各项 configured 标记、`origin` |
| GET | `/api/recent` | 最近 60 条推送记录 |
| GET | `/api/runs` | 最近 20 次运行 |
| POST | `/api/run` | 同步跑一次榜单抓取并返回 summary（含 `notes` 诊断行） |
| POST | `/api/push-random?count=` | 随机推送 1–20 张，不去重 |
| GET/POST | `/api/ondemand` | 提示词返图配置：`{enabled,triggers,count,requireAtInGroup,allowPrivate}` |
| POST | `/api/test?target=` | `telegram` / `qqbot` / `napcat` 连通性自检 |
| GET/POST/DELETE | `/api/sources` | 数据源 CRUD（POST 带 id 即更新；`randomapi` 校验 slug、需密钥拒启用） |
| POST | `/api/sources/seed-providers` | 幂等补全全部注册表 provider，返回 `{added, skipped}` |
| GET | `/api/providers` | 注册表元数据（slug/name/docUrl/protocol/needsKey/note） |
| GET/DELETE | `/api/diag` | 诊断日志读取 / 清空 |
| GET/POST | `/api/config` | 渠道与全局设置（不含 sources；含 `qqbot.groupActivePush`） |
| GET/DELETE | `/api/subscribers` | 支持 `?platform=telegram\|qqbot\|all` |
| GET/POST/DELETE | `/api/credentials` | 只回掩码；POST `{name,value}`；DELETE `?name=` |
| POST | `/tg/webhook` | 平台签名（secret token）；Telegram 更新 |
| POST | `/qq/webhook` | 平台签名（Ed25519）；QQ 官方事件 / op=13 验证 |
| POST | `/onebot/webhook` | 可选 HMAC-SHA1 验签；NapCat 上报 |

## 代码约定
- 全部 TypeScript strict；提交前跑 `npx tsc --noEmit`。
- D1 一律用 prepared statement + `bind()`，不做字符串拼接。
- 外部请求统一走 `http.ts` 的 `fetchJson`（带 UA 与超时）；直接用 `fetch` 时也要显式 `AbortSignal.timeout`。
- 错误信息面向使用者，用中文并带上下文（哪个源 / 哪个目标 / HTTP 状态）。
- 注释解释「为什么」，不解释「做了什么」。
- 后台页面不引入任何构建工具与外部依赖，保持单文件可直接部署。

## 踩过的坑
- **webhook 里同步做重活会被平台超时掐断**：客户端断连会取消 Worker 请求上下文，发送中止且完全静默（"发了触发词没反应"）。三个 webhook 一律「立刻回 200 + `ctx.waitUntil()`」。
- **后台任务失败必须回一句话告诉用户**：只 `console.warn` 会让故障看起来像"机器人没收到"，极难定位。
- **webhook 里回复失败不能返回 5xx**：平台会重推事件，导致重复处理。回复一律 best-effort。
- **QQ 同一 `msg_id` 回复多条要给不同 `msg_seq`**：否则第 2 条起被当重复消息丢弃，表现为"只收到第一张"。
- **QQ 群主动消息要单独申请权限**（无权限报 `40034105`）；被动回复不需要。别用重试或补发队列去绕。
- **QQ 验签必须用原始请求体**：先 `JSON.parse` 再 `stringify` 会改变字节，验签必失败。
- **Workers 不能从 seed 直接生成 Ed25519 公钥**：用 PKCS#8 包装 seed 导入私钥，再 `exportKey("jwk")` 反推公钥。
- **别让十几个随机图 API 进 cron**：子请求上限 + 随机 id 冲淡去重库。随机源只服务按需路径。
- **shell heredoc 会吃掉 `\\`**：在 bash 里写含 `[\\s\\S]` 的测试脚本会变成 `[sS]`，正则失效。用编辑器写文件，别用 heredoc 传含反斜杠的代码。
- **`wrangler dev` 停掉后子进程可能仍占端口**：换端口或用 `netstat -ano | grep 8787` 找到 PID 杀掉，否则请求会打到旧代码 + 旧环境变量上（表现为「明明配了 secret 却读不到」）。
- **Windows 终端显示中文乱码**：`curl` 返回的 UTF-8 在 GBK 控制台里是乱码，但存储和响应本身是对的，别被误导。

