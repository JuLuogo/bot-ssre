# 技术原理

## 1. 总体设计
整个服务是**一个 Cloudflare Worker**，没有常驻进程、没有长连接，两个入口：

| 入口 | 触发方式 | 职责 |
|---|---|---|
| `scheduled()` | Cron Trigger（UTC） | 定时执行「爬取 → 过滤 → 去重 → 推送 → 记录」 |
| `fetch()` | HTTP 请求 | 管理后台静态资源、`/api/*` 接口、`/tg/webhook`、`/qq/webhook` |

两条约束由此推导出来：

1. **QQ 个人号无法直连**。NapCat / Lagrange 这类框架需要与 QQ 服务器保持长连接，Worker 做不到，所以个人 QQ 只能走「外部 NapCat 暴露 HTTP，Worker 主动调用」的中转模式。QQ 官方机器人则是纯 HTTP + webhook，天然契合 Worker。
2. **状态必须全部外置**。Worker 实例随时被回收，模块级变量不可靠，因此配置、订阅者、推送记录、运行历史进 D1，去重标记进 KV。

## 2. 数据流

```
Cron(UTC 01:00) ──┐
                  ├──→ pipeline.runOnce(env)
POST /api/run ────┘         │
                            │ 1. 遍历「启用」的**榜单源**（排除随机图源，见第 5.1 节）
                            │    SourceAdapter.fetchRanking() → Illust[]
                            │    gelbooru · moebooru · pixiv · rss
                            │
                            │ 2. 分级过滤（逐条）
                            │    trusted 源直接放行；否则要求 rating === "safe"
                            │
                            │ 3. 去重：KV `seen:<source>:<id>` 命中则丢弃
                            │
                            │ 4. 截断：candidates.slice(0, perRunTotalCap)
                            │
                            │ 5. 组装渠道：每个渠道
                            │    targets = 后台固定配置 ∪ 已启用订阅者（Set 去重）
                            │
                            │ 6. 逐图 × 逐渠道 × 逐目标推送
                            │    单个目标失败只记入 errors，不影响其他
                            │
                            └ 7. 任一渠道成功 → KV 标记 seen + D1 写 pushed
                                 结束时把摘要写入 D1 runs
```

另一条独立的数据流是「按需返图」，不走 `runOnce`：

```
提示词触发（TG / QQ官方 / NapCat webhook）┐
                                          ├──→ ondemand.fetchRandomIllusts(env, tags, count)
后台「推送随机新图」→ pushRandomBatch ────┘         │
                                                   │ 无关键词：随机图源（randompic + randomapi）
                                                   │          随机排序、逐个尝试、失败自动切换、够数即停
                                                   │ 有关键词：走支持 tag 的 booru（rating:safe）
                                                   └ 不写 seen（随机图强制推，不做跨次去重）
```

关键取舍：**只有推送成功过的条目才写 seen**。若先标记再推送，一次网络抖动会让这张图永久丢失；反过来最坏情况只是下次重试。

## 3. 归一化：`Illust`
各数据源的字段差异被压平成同一结构，下游（过滤、去重、渠道）只认这一个类型：

| 字段 | 含义 | 各源来源举例 |
|---|---|---|
| `source` | 来源标识（也是去重命名空间） | booru 用站点主机名首段；RSS 用订阅 label |
| `id` | 站内唯一 id | booru `post.id`；pixiv `illust_id`；RSS `guid#图序号` |
| `imageUrl` | **可被第三方服务器直接拉取**的图片地址 | booru `sample_url`；pixiv 反代后的 url；RSS 正文 img |
| `pageUrl` | 原作品页 | 用于消息里的出处链接 |
| `rating` | 归一化分级 | `safe` / `questionable` / `explicit` / `unknown` |
| `score` / `rank` / `tags` / `title` / `author` | 展示与排序用 | 缺失则留空 |

## 4. 存储分层：为什么配置在 D1、去重在 KV

| | D1（SQLite） | KV |
|---|---|---|
| 免费额度 | 500 万行读/天、**10 万行写/天**、5 GB | 10 万次读/天、**1000 次写/天** |
| 一致性 | 强一致，写完立即读到 | 最终一致，全球传播有延迟 |
| 查询能力 | SQL（JOIN / ORDER BY / 聚合） | 仅按 key 取值 + 前缀 list |
| 过期 | 需自己写清理 | 原生 `expirationTtl` |

- **配置 / 订阅者 / 推送记录 / 运行历史 / 凭证 → D1**：后台改完必须立刻生效（强一致），且要按时间倒序分页查询（SQL）。KV 每天 1000 次写的上限对「频繁改配置 + 每次推送写记录」明显不够。
- **去重标记 → KV**：只需要 `key 存在?` 这一种查询，而且天然需要「N 天后过期以便重新可推」——正好是 KV 的 `expirationTtl`，用 D1 反而要额外写定时清理。

D1 表职责：

```
settings(key, value)          # telegram / napcat / qqbot / global 四行 JSON
sources(...)                  # 数据源与 RSS 订阅（统一一张表，adapter 区分）
pushed(source, post_id, ...)  # 推送记录，UNIQUE(source, post_id)，画廊数据源
runs(...)                     # 每次运行摘要，errors 存 JSON 数组
subscribers(platform, chat_id, enabled, ...)   # 自助订阅者，UNIQUE(platform, chat_id)
credentials(name, value, updated_at)           # 后台可配置的密钥（明文）
```

KV 键空间：`seen:<source>:<id>`（去重）、`exec:<cron>-<scheduledTime>`（cron 幂等）、`qqbot:token`（access_token 缓存）。

## 5. 适配器模式
两个接口把「从哪拿」和「发到哪」解耦，新增站点或平台都只写一个文件：

```ts
interface SourceAdapter  { name; fetchRanking(env, opts): Promise<Illust[]> }
interface ChannelAdapter { name; push(env, illust, target, opts?): Promise<void> }
```

- 数据源注册表在 `src/sources/index.ts`，`sources.adapter` 字段就是这里的 key。
- 渠道在 `pipeline` 中按配置装配，每个渠道带自己的 `opts`（如 Telegram 的 `apiBase`）。
- `SourceOptions` 是各源参数的并集（`site` / `tags` / `mode` / `limit` / `label`），各适配器只取自己关心的字段——用一张 `sources` 表承载多种形态的代价最小。

### 5.1 图源分工：榜单源 vs 随机源

六个 adapter 分成两类，**服务两条不同的数据流**，这是刻意的：

| 类别 | adapter | 参与 `runOnce`（定时/立即运行） | 参与按需返图与「推送随机新图」 |
|---|---|---|---|
| 榜单源 | `gelbooru` `moebooru` `pixiv` `rss` | ✅ | 仅带关键词时用 booru 做 tag 检索 |
| 随机源 | `randompic` `randomapi` | ❌ 被 `runOnce` 显式排除 | ✅ 主力 |

为什么随机源不进 `runOnce`：

1. **子请求配额**。`randomapi` 预置了 16 个启用源，若每次 cron 都遍历，一次运行就要对十几个第三方 API 各发一次请求，叠加富媒体上传与推送（QQ 官方每图 2 次请求）后逼近 Workers 的子请求上限。按需返图则是随机排序、逐个尝试、**够数即停**，通常只打 1 个源。
2. **语义与去重库**。定时推送的语义是「今天的排行榜新图」；随机图每次 id 都不同，永远"新"，会挤占 `perRunTotalCap` 并不断往 KV 去重库灌无意义的 key，把真正的榜单新图冲淡。

反过来，随机源在按需路径上被优先使用：`ondemand.fetchRandomIllusts` 无关键词时只用随机源（自有 `randompic` 与第三方 `randomapi` 混在一起随机排序、失败自动切下一个），有关键词时才回落到支持 tag 的 booru。

### 5.2 第三方随机图 API 的安全边界

`randomapi` 的目标 URL **只能来自代码里的固定注册表** `src/sources/randomapi_providers.ts`，后台只能选 slug，不能填任意 URL——否则等于给后台开了一个 SSRF 入口。三层校验：

1. `sources.site` 存的是 slug，`/api/sources` 写入时用 `getProvider(slug)` 校验，未知 slug 拒绝；`needsKey` 的源拒绝启用。
2. 按 provider 声明的协议取图：`json`（用该源专属 `extract` 读字段）/ `redirect`（`redirect:"manual"` 读 `Location`）/ `direct`（端点本身即随机图，加随机参数生成多张互不相同的稳定 URL）。
3. 最终图片 URL 必须 `https`，且满足 provider 声明的 `imageHosts` 后缀白名单；跳转域名不固定的源退化为「必须有图片扩展名」。

单源单次外部请求上限 6、超时 12s。全部 provider 由迁移 `0006_randomapi_sources.sql` 预置（16 启用 / 2 needsKey 关闭），也可在后台点「一键补全全部随机图 API 源」（`POST /api/sources/seed-providers`，幂等）——后者不依赖迁移是否执行。**改注册表后要同步那个迁移文件**，审核结论记录在 `docs/RANDOM_IMAGE_APIS.md`。

## 6. 分级过滤
「只推全年龄」在三个层面落实：

1. **源头**：Pixiv 只取非 `_r18` 榜单；safebooru 本身就是全年龄站。
2. **字段判定**：
   - booru / moebooru：`rating` 归一化，仅 `safe`（含 gelbooru 的 `general`）放行；`sensitive` 归入 `questionable` 一并拒绝。
   - Pixiv：`illust_content_type.sexual === 0 && !lo && !grotesque` 才判为 `safe`。
3. **可信豁免**：`sources.trusted = 1` 的源跳过过滤。RSS 订阅默认 trusted——推特作者的图没有任何分级字段可判，强行过滤只会全部拦掉，所以改为「由你自己决定订阅谁」。

## 7. 去重与幂等
- **内容去重**：`seen:<source>:<id>`，TTL = `seenTtlDays`。`source` 参与 key，因此不同站点的同 id 不会互相干扰。
- **Cron 幂等**：Cron Trigger 是 at-least-once，同一时间点可能触发两次。用 `exec:<cron>-<scheduledTime>` 抢占，命中则 `controller.noRetry()` 直接返回，避免重复推送。

## 8. 推送目标解析
每个渠道的目标集合都是**「后台固定配置 ∪ 已启用订阅者」**，用 `Set` 去重：

| 渠道 | 固定配置 | 订阅者（platform） | 目标格式 |
|---|---|---|---|
| Telegram | `telegram.chatIds` | `telegram` | `chat_id`（个人/群/频道通用） |
| QQ 官方 | `qqbot.targets` | `qqbot` | `group:<group_openid>` / `user:<user_openid>` |
| 个人 QQ | `napcat.groupIds` | —（无自助订阅） | 群号 |

QQ 官方的 target 带前缀是因为官方 API 的单聊与群聊是**两套互不通用的端点**（`/v2/users/{openid}/...` vs `/v2/groups/{openid}/...`），连富媒体上传都不能跨场景复用，所以必须在 target 里带上场景信息。

## 9. 订阅制原理
两个平台都走 webhook，逻辑同构：收到消息 → 解析首个 token 作为命令 → 写/改 `subscribers` → 被动回复。

**Telegram**：`POST /tg/webhook`。用 `setWebhook` 时设置的 `secret_token` 校验（对比 `X-Telegram-Bot-Api-Secret-Token` 头）。命令去掉 `@botname` 后缀以支持群内 `/start@mybot`。

**QQ 官方**：`POST /qq/webhook`，比 TG 复杂两点：

1. **回调地址验证（op=13）**：平台下发 `{plain_token, event_ts}`，要求用 AppSecret 派生的 Ed25519 私钥对 `event_ts + plain_token`（注意顺序：时间戳在前）签名并回 hex。
2. **事件验签**：每个事件请求带 `X-Signature-Ed25519`（hex）与 `X-Signature-Timestamp`，待验签内容是 `timestamp + 原始请求体`，**必须用未经反序列化的原始字节**，否则重新序列化导致的空格/字段顺序变化会让验签失败。

### Ed25519 在 Workers 上的实现要点
官方 SDK 用 `ed25519.GenerateKey(reader(seed))`，Workers 的 WebCrypto 没有「从 seed 生成密钥对」这个原语，做法是：

```
seed  = AppSecret 反复自我拼接直到 ≥32 字节，取前 32 字节
DER   = 302e020100300506032b657004220420 || seed      # Ed25519 的 PKCS#8 固定前缀
priv  = crypto.subtle.importKey("pkcs8", DER, {name:"Ed25519"}, true, ["sign"])
jwk   = crypto.subtle.exportKey("jwk", priv)          # 借导出拿到公钥 x
pub   = crypto.subtle.importKey("jwk", {kty:"OKP",crv:"Ed25519",x:jwk.x}, ..., ["verify"])
```

即：**用 PKCS#8 包装 seed 导入私钥，再借 JWK 导出反推公钥**。签名前还按官方规范校验 `sig.length === 64 && (sig[63] & 224) === 0`。

正确性用官方文档的示例值验证过：secret `DG5g3B4j9X2KOErG` + 示例 `plain_token/event_ts` 产出的签名与文档一致。Ed25519 是确定性签名，同样输入必然同样输出，因此这是强验证。

## 10. QQ 官方机器人的几个特殊流程
**access_token**：`POST /app/getAppAccessToken`（body 里 `appId`/`clientSecret`）换取，有效期 7200 秒。缓存在 KV `qqbot:token`，存 `{token, exp}` 并提前 60 秒失效，同时给 KV 设同长度 TTL 兜底。官方在有效期内重复调用返回同一个值，所以不必担心并发刷新产生多份。

**发图是两步**：官方不接受直接塞图片 URL 的消息，必须
1. `POST /v2/{groups|users}/{openid}/files`，`{file_type:1, url, srv_send_msg:false}` → 拿 `file_info`；
2. `POST /v2/{groups|users}/{openid}/messages`，`{msg_type:7, media:{file_info}}`。

代码里第 2 步会先尝试带 `content` 文案，被拒则自动回退为仅图片——因为不同环境对富媒体消息能否附带文本的行为不完全一致。

**主动消息 vs 被动回复**（线上实测确认的硬约束）：

| | 被动回复 | 主动消息 |
|---|---|---|
| 触发条件 | 请求体带用户消息的 `msg_id`，且在其后 5 分钟内 | 不带 `msg_id` |
| 权限 | 无需额外权限 | **需在 QQ 开放平台单独申请** |
| 额度 | 不占额度 | 按额度计费、有频控 |

未获权限时向群发主动消息返回 `{"code":40034105,"message":"主动消息失败, 无权限"}`。实测同一次推送里 `user:` 目标成功、`group:` 目标全部 40034105 —— 即**单聊主动消息有额度、群聊没有**。由此推出三条实现：

1. 提示词触发返图一律带 `msg_id` 走被动回复，所以群里的关键词返图不需要任何额外权限。
2. `qqbot.push`（定时/手动推送）会先查 KV `qqbot:lastmsg:<target>`——webhook 每收到一条消息就把 `msg_id` 记进去（TTL 270s）——命中就按被动回复发，未命中才发主动消息。因此群内刚有人说话时，手动推送也能进群。
3. 配置项 `qqbot.groupActivePush`（默认 true）关掉后，`assembleChannels` 直接过滤掉 `group:` 目标：申请不到权限时，群里只保留关键词触发，不再产生成批注定失败的请求。

**同一 `msg_id` 回复多条必须给不同 `msg_seq`**，否则第 2 条起会被 QQ 当重复消息丢弃——返图张数 >1 时表现为「只收到第一张」。`sendImage` / `sendText` 都接受 `msgSeq`，返图循环里递增。

## 11. Telegram 发图的两条路径
```
① sendPhoto {photo: <图片URL>}     ← 首选：Telegram 服务器自己去拉，Worker 不碰图片字节
   ↓ 失败（防盗链 / TG 拉不到 / 图片过大）
② Worker fetch 图片 → FormData multipart 上传
```
路径 ① 几乎不消耗 Worker 资源（无 CPU、无内存压力），所以永远先试它；② 是兜底。`apiBase` 可配置为反代域名，两条路径都会走反代。

## 12. Pixiv 反代原理
`i.pximg.net` 对 `Referer` 做防盗链，Telegram/QQ 的服务器不会带 pixiv 的 Referer，必然拉取失败。解决办法是把排行榜返回的图片 URL 主机名替换成你自建的反代域名：

```
https://i.pximg.net/c/480x960/img-master/.../123_p0_master1200.jpg
                ↓ 替换 host 为 PIXIV_PROXY_HOST
https://你的反代域名/c/480x960/img-master/.../123_p0_master1200.jpg
```
未配置 `PIXIV_PROXY_HOST` 时 Pixiv 适配器直接返回空数组并打日志，而不是产出必然发送失败的条目。排行榜接口本身（`ranking.php?format=json`）无需登录、无需特殊头即可访问。

## 13. 凭证层：D1 覆盖 env
`resolveEnv(env)` 在入口处把 D1 `credentials` 表的值合并到 `env` 上（D1 优先），返回的仍是 `Env` 形状：

```ts
return { ...env, ...overrides }   // KV/DB/ASSETS 等 binding 原样保留
```

这样下游所有 `env.TG_BOT_TOKEN` 之类的读取**完全不用改**，只在 `fetch()` 的 webhook 分支、`scheduled()`、`/api/run`、`/api/test` 这几处调用一次。

安全边界：
- 白名单只有 7 个键，其它名字写入直接拒绝；
- `ADMIN_TOKEN` **不在白名单**——它是保护后台的信任根，若能从后台改写就等于自我提权；
- `/api/credentials` 只返回掩码与来源（`d1` / `env` / `none`），永不回显原文；
- D1 中是明文存储，这是「换取免 CLI 配置便利」的代价，文档里明确告知；删除 D1 记录即回退到 `wrangler secret`。

## 14. Workers 平台限制与对策

| 限制（免费版） | 影响 | 对策 |
|---|---|---|
| CPU 10 ms | 纯计算受限 | 全流程以 I/O 为主，`fetch` 等待不计 CPU；发图优先走「让对方服务器拉 URL」，不在 Worker 内处理图片字节 |
| 子请求 50 次/调用 | 数据源 + 上传 + 推送次数受限 | `perRunTotalCap` 默认 10；QQ 官方每图需 2 次请求（上传+发送），目标多时要相应调小；随机图源不参与 cron 遍历（第 5.1 节） |
| **客户端断连即取消请求上下文** | webhook 里同步做重活会被中途掐断 | 见下方「webhook 必须立即应答」 |
| Cron 传播延迟 ≤15 分钟 | 改 cron 后不立即生效 | 部署后耐心等待，并用 `/api/run` 手动验证逻辑 |
| Cron at-least-once | 可能重复触发 | `exec:*` 幂等键 |
| KV 最终一致 | 刚写的 seen 可能读不到 | 去重容忍极小概率重复；配置类数据一律不用 KV |
| 无 DOMParser | 不能用 DOM 解析 RSS | RSS 用正则提取 `<item>/<entry>` 与图片（`<img>` / `media:content` / `enclosure`） |

### webhook 必须立即应答，重活交给 `waitUntil`

「抓随机图 → 富媒体上传 → 发消息」耗时可达数秒。若在 webhook 的请求处理里同步做完，平台侧（QQ / Telegram / NapCat）会先超时断开连接，而 **Cloudflare 在客户端断连时会取消该请求的上下文**，正在进行的 `fetch` 随之中止 —— 表现为「发了触发词完全没反应，也没有任何错误」。

所以三个 webhook 都是同一结构：验签/匹配这些便宜的判断留在请求内，命中后**立刻返回 200**，把抓图与发送交给 `ctx.waitUntil(...)` 在后台跑完（`waitUntil` 的任务不受客户端断连影响）。这也顺带避免了平台超时重推导致的重复发图。

对应地，后台失败必须**主动告知用户**：`replyIllusts` 在一张都没发出去时会回一句失败原因，而不是只 `console.warn`（静默失败曾经让这个问题极难定位）。

### 诊断日志

`src/diag.ts` 在 KV `diag:events` 维护一个 40 条的环形缓冲（TTL 7 天），记录每条到达的 QQ 消息事件（内容、当时的 `triggers`/`enabled`、是否命中）与返图/推送结果，后台「🩺 触发诊断」卡片展示（`GET /api/diag`，需登录）。

刻意不落 D1：新表需要迁移，而本项目的迁移依赖 Cloudflare MCP 手动执行，MCP 不可用时表建不出来，诊断功能就会连带失效。有了它，「事件没到 / 没命中 / 命中后发送失败」三种情况可以一眼区分。

## 15. 失败隔离
- 单个数据源抓取失败 → 记入 `errors`，其余源照常。
- 单个目标推送失败 → 记入 `errors`，其余目标照常；只要有一个渠道成功就算这张图已推送。
- webhook 里给用户回复消息失败 → 只打日志，仍返回 200。**这点很关键**：QQ/Telegram 对 5xx 会重推事件，若因「回复失败」返回 500，已经成功的订阅会被反复重放。



