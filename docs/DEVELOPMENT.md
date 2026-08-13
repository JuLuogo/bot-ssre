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
  index.ts           入口：fetch 路由（webhook → /api → 静态资源）+ scheduled
  pipeline.ts        编排：拉取 → 过滤 → 去重 → 装配渠道 → 推送 → 记录
  types.ts           Illust / SourceAdapter / ChannelAdapter / AppConfig / Env
  http.ts            fetchJson + 统一 UA + 超时
  filter.ts          rating 归一化与全年龄判定
  store.ts           KV：去重标记、cron 幂等
  db.ts              D1：settings / sources / pushed / runs / subscribers
  creds.ts           凭证层：D1 credentials 覆盖 env（白名单 + 掩码）
  config.ts          配置门面（委托 db.ts）
  api.ts             /api/* 全部路由
  telegram_bot.ts    Telegram webhook（订阅命令）
  qqbot_webhook.ts   QQ 官方 webhook（op=13 + 事件）
  qqsign.ts          Ed25519 派生 / 签名 / 验签
  sources/           数据源适配器 + 注册表
  channels/          推送渠道适配器
public/index.html    管理后台（原生 JS 单页，无构建步骤）
migrations/          D1 迁移，按序号执行
```

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
迁移只能追加、不可修改已应用的文件（wrangler 用 `d1_migrations` 表记录）。写 DDL 时用 `IF NOT EXISTS`，seed 数据用 `INSERT OR IGNORE`，保证重复执行安全。

## 扩展：新增可后台配置的凭证
在 `src/creds.ts` 的 `CREDENTIAL_KEYS` 里加键名即可——后台表格、掩码、来源标签、写入白名单全部自动生效。同时在 `types.ts` 的 `Env` 里声明该字段。
**不要**把 `ADMIN_TOKEN` 加进去。

## API 契约
所有响应都是 `{ ok: boolean, ... }`；失败时带 `error` 字段。写操作需 `Authorization: Bearer <ADMIN_TOKEN>`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/status` | — | 环境、完整配置、上次运行、各项 configured 标记、`origin` |
| GET | `/api/recent` | — | 最近 60 条推送记录 |
| GET | `/api/runs` | — | 最近 20 次运行 |
| POST | `/api/run` | ✔ | 同步执行一次并返回 summary |
| POST | `/api/test?target=` | ✔ | `telegram` / `qqbot` / `napcat` 连通性自检 |
| GET/POST/DELETE | `/api/sources` | 读免/写✔ | 数据源 CRUD（POST 带 id 即更新） |
| GET/POST | `/api/config` | 读免/写✔ | 渠道与全局设置（不含 sources） |
| GET/DELETE | `/api/subscribers` | 读免/写✔ | 支持 `?platform=telegram\|qqbot\|all` |
| GET/POST/DELETE | `/api/credentials` | 读免/写✔ | 只回掩码；POST `{name,value}`；DELETE `?name=` |
| POST | `/tg/webhook` | 平台签名 | Telegram 更新 |
| POST | `/qq/webhook` | 平台签名 | QQ 官方事件 / op=13 验证 |

## 代码约定
- 全部 TypeScript strict；提交前跑 `npx tsc --noEmit`。
- D1 一律用 prepared statement + `bind()`，不做字符串拼接。
- 外部请求统一走 `http.ts` 的 `fetchJson`（带 UA 与超时）；直接用 `fetch` 时也要显式 `AbortSignal.timeout`。
- 错误信息面向使用者，用中文并带上下文（哪个源 / 哪个目标 / HTTP 状态）。
- 注释解释「为什么」，不解释「做了什么」。
- 后台页面不引入任何构建工具与外部依赖，保持单文件可直接部署。

## 踩过的坑
- **webhook 里回复失败不能返回 5xx**：平台会重推事件，导致重复处理。回复一律 best-effort。
- **QQ 验签必须用原始请求体**：先 `JSON.parse` 再 `stringify` 会改变字节，验签必失败。
- **Workers 不能从 seed 直接生成 Ed25519 公钥**：用 PKCS#8 包装 seed 导入私钥，再 `exportKey("jwk")` 反推公钥。
- **shell heredoc 会吃掉 `\\`**：在 bash 里写含 `[\\s\\S]` 的测试脚本会变成 `[sS]`，正则失效。用编辑器写文件，别用 heredoc 传含反斜杠的代码。
- **`wrangler dev` 停掉后子进程可能仍占端口**：换端口或用 `netstat -ano | grep 8787` 找到 PID 杀掉，否则请求会打到旧代码 + 旧环境变量上（表现为「明明配了 secret 却读不到」）。
- **Windows 终端显示中文乱码**：`curl` 返回的 UTF-8 在 GBK 控制台里是乱码，但存储和响应本身是对的，别被误导。

