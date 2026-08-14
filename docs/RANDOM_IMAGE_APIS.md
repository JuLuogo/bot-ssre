# 随机图 API 审核清单

核验日期：2026-08-14。用于选择“提示词 → 返回单张随机图”的图片源。

状态：**实测**=本轮请求返回有效图片/JSON；**待审**=可达但分级或稳定性不明确；**候选**=有作者资料但未完成实测；**失效**=超时、404、DNS 失效或不适用。

> 本机可用不代表 Cloudflare Worker 出口一定可用。正式接入前仍需线上实测。

## 1. 当前首选：自有静态随机图库

| 项目 | 结果 |
|---|---|
| 页面/清单 | `https://pic.060730.xyz/` / `https://pic.060730.xyz/random.js` |
| 数量 | `h=979`、`v=3596`、`j=1793`，脚本声明共 6368 张 |
| 分级 | 用户确认 100% 全年龄 |
| 可用路径 | `https://pic.060730.xyz/ri/h/{n}.webp`、`/ri/v/{n}.webp` |
| 当前异常 | `j` 当前 404，适配器自动跳过 |
| 明确忽略 | `pic.0721030.xyz` 不可用，不探测、不使用 |
| 接入原理 | Worker 读取 `random.js` 的 counts，在服务端随机编号并拼静态 URL，不执行浏览器 JS |
| 容灾/配额 | 每类 HEAD 健康检查；manifest 缓存 KV 15 分钟；单批 Set 去重 |

无关键词提示词返图和“推送随机新图”优先用此源；带关键词时回退到支持 tag 的 booru。

## 2. 推荐审核池：官方资料明确且实测可用

| # | 服务 | 官方资料/端点 | 返回 | 分级/规模 | 结论 |
|---:|---|---|---|---|---|
| 1 | pic.re | [文档](https://doc.pic.re/) · `https://pic.re/image?max_size=1024` | WebP | 官方 SFW、70,000+ | 实测 200；外部首选 |
| 2 | Nekos API v4 | [文档](https://nekosapi.com/docs/images/random) · `/v4/images/random?rating=safe&limit=1` | JSON | 可固定 safe，1–100 张 | 实测 200；有直图端点 |
| 3 | nekos.best | [文档](https://docs.nekos.best/getting-started/api-endpoints) · `/api/v2/neko?amount=1` | JSON | 官方全 SFW | 实测 200；需合法 UA |
| 4 | Nekosia | [官网](https://nekosia.cat/) · `/api/v1/images/catgirl` | JSON | 官方 SFW，约 1,710 张 | 实测 200；图库偏小 |
| 5 | waifu.im | [文档](https://docs.waifu.im/docs/getting-started/) · `/images?IsNsfw=False` | JSON | 默认 SFW，4,000+ | 实测 200；筛选强 |
| 6 | Lolicon v2 | [文档](https://github.com/Tsuk1ko/lolicon-api-docs/blob/main/setu.md) · `/setu/v2?r18=0&num=1&excludeAI=true` | JSON | `r18=0` | 实测 200；适合 tag，图域可能需代理 |
| 7 | UAPI | [文档](https://uapis.cn/docs/api-reference/get-random-image) · `/api/v1/random/image?category=acg` | 302/图片 | 官方称 100,000+ ACG | 实测最终 200 JPEG；分级需抽样 |
| 8 | DMOE | [官网](https://www.dmoe.cc/) · `/random.php?return=json` | JSON/图片 | 官方称 5,200+ | 实测 200；未明确严格 SFW |
| 9 | Danbooru | [文档](https://danbooru.donmai.us/wiki_pages/help:api) · `/posts/random.json?tags=rating:general` | JSON | 百万级；强制 general | 实测 200；需唯一 UA/限流 |
| 10 | Konachan.net | [SFW 站](https://konachan.net/) · `/post.json?limit=1&tags=order:random` | JSON | `.net` 为 SFW | 实测 200；勿用 `.com` |
| 11 | Safebooru | [官网](https://safebooru.org/) · dapi JSON | JSON | 大型 SFW booru | 实测 200；拉批后本地随机 |
| 12 | PurrBot | [文档](https://docs.purrbot.site/api) · `/v2/img/sfw/neko/img` | JSON | SFW/NSFW 路径分离 | 实测 200；偏 reaction/neko |
| 13 | nekos.dev | `https://api.nekos.dev/api/v3/images/sfw/img/neko` | JSON | SFW 路径 | 实测 200；文档较弱 |
| 14 | nekos.life | `https://nekos.life/api/v2/img/neko` | JSON | 分类式 | 实测 200；旧项目，低优先级 |

## 3. 中文圈：实测可达，但接入前需人工抽样内容

| # | 服务 | 端点 | 返回 | 当前判断 |
|---:|---|---|---|---|
| 15 | [LoliAPI ACG](https://docs.loliapi.com/api-shi-yong-wen-dang/sui-ji-er-ci-yuan-tu-pian) | `https://www.loliapi.com/acg/` | 302 → WebP | 实测 200；未见严格全年龄承诺 |
| 16 | LoliAPI 背景图 | `https://www.loliapi.com/bg/` | 302 → WebP | 实测 200；背景图库，分级未明确 |
| 17 | [栗次元萌图](https://t.alcy.cc/) | `https://t.alcy.cc/moe/` | WebP | 实测 200；官方未声明严格 SFW |
| 18 | 栗次元竖图 | `https://t.alcy.cc/mp/` | WebP | 实测 200；适合手机/聊天场景 |
| 19 | 栗次元原神 | `https://t.alcy.cc/ycy/` | WebP | 实测 200；主题明确，仍需抽样 |
| 20 | Jitsu | `https://moe.jitsu.top/img/` | 302 → JPEG | 实测 200；无可靠分级说明 |
| 21 | ANOSU 兼容入口 | `https://api.anosu.top/img` | 301 → Jitsu | 实测 200；与 Jitsu 重复，不建议同时接 |
| 22 | mtyqx | `https://api.mtyqx.cn/api/random.php` | JPEG | 实测 200；文档、规模、分级未确认 |
| 23 | 杜锦随机图 | `https://api.dujin.org/pic/` | 302 → JPEG | 实测 200；源图常经新浪/百度，分级未知 |
| 24 | Paugram 壁纸 | `https://api.paugram.com/wallpaper/` | 302 → JPEG | 实测 200；壁纸类，未承诺全年龄 |
| 25 | pic.re 国内可达入口 | `https://pic.re/image` | WebP | 实测 200；已列推荐池，官方明确 SFW |

## 4. 中文圈：有作者/官方资料，尚待逐项复测

| # | 服务 | 资料/可能端点 | 待确认事项 |
|---:|---|---|---|
| 26 | [夜轻随机图](https://blog.yeqing.net/acg-api/) | 文档列 `api.php`、`pc.php`、`pe.php`，支持 `return=json/all` | 取文档当前域名复测；核对限流与内容样本 |
| 27 | [MoeRNG](https://github.com/Grabrun/MoeRNG) | 自建型随机图 API，JSON/302、多分类 | 这是程序而非公共稳定实例，适合自部署 |
| 28 | [鸡屎 API](https://api-doc.jsms2.cn/) | 随机/方形/横/竖/UA 自适应接口 | 当前端点、内容分级、图库规模需确认 |
| 29 | [欧阳琪琪 v2](https://api.ouyangqiqi.cn/dm/v2%E7%89%88%E6%9C%AC/%E8%B0%83%E7%94%A8%E4%B8%8E%E5%8F%82%E6%95%B0/) | 文档称可用无序参数减少缓存重复 | 端点连通性与图片域名稳定性待测 |
| 30 | [Sitetu](https://www.sitetu.cn/api) | 随机图、列表、搜索、标签接口 | 官方页可达；具体端点与分级需确认 |
| 31 | [南风 API](https://api.sretna.cn/) | 随机动漫图接口 | 免费宣称；规模、限流、分级待核 |
| 32 | [梓宸 ACG API](https://app.zichen.zone/api/acg/) | 随机 ACG 图片 | 公益服务，需确认端点与防滥用规则 |
| 33 | [Elaina Cat](https://api.elaina.cat/) | 自适应/横屏/竖屏 | 内容分级、规模和稳定性待核 |
| 34 | Cirno AniPic | `https://api.cirno.me/anipic` | 官方介绍可查；返回格式和分级待测 |
| 35 | Cirno AniBG | `https://api.cirno.me/anibg` | 官方介绍可查；返回格式和分级待测 |

## 5. 国际候选与备用源

| # | 服务 | 端点/用途 | 状态与风险 |
|---:|---|---|---|
| 36 | Nekos API 文件端点 | `https://api.nekosapi.com/v4/images/random/file?rating=safe` | 实测 302 → WebP；推荐备用 |
| 37 | yande.re | `https://yande.re/post.json?limit=40&tags=rating:s+order:random` | 实测 JSON；必须 rating:s 并本地复核 |
| 38 | Zerochan | `https://www.zerochan.net/{tag}?json` | 实测 JSON；无可靠 rating 参数，60 req/min |
| 39 | Waifu.it | [文档](https://docs.waifu.it/rest-api/Images/Waifu/search) · `/api/v4/waifu` | 官方文档可用；需要 Authorization token |
| 40 | OtakuGIFs | [官网](https://otakugifs.xyz/) | Reaction GIF API；适合动作回复，不是静态插画主源 |
| 41 | Kawaii.red | [文档](https://docs.kawaii.red/request-structure) | Reaction GIF；需要免费 token，分级需审核 |
| 42 | Danbooru | [API 文档](https://danbooru.donmai.us/wiki_pages/help:api) | 大型图库；需唯一 UA、限流约束和 rating:general |
| 43 | Konachan.net | `https://konachan.net/post.json?limit=40&tags=order:random` | SFW 站点；不要使用 `.com` |
| 44 | PurrBot | [文档](https://docs.purrbot.site/api) | SFW/NSFW 路径分离；偏 reaction/neko |
| 45 | nekos.dev | `/api/v3/images/sfw/img/neko` | SFW 路径；文档较弱，低优先级 |
| 46 | nekos.life | `/api/v2/img/neko` | 实测 JSON；项目维护度较低 |
| 47 | Lorem Picsum | [文档](https://picsum.photos/) · `https://picsum.photos/800/1200?random=1` | 实测图片；通用摄影，不是二次元 |
| 48 | Unsplash | [API 文档](https://unsplash.com/documentation/#get-a-random-photo) | 需要 Access Key，须遵守 hotlink/署名规则 |
| 49 | Pexels | [API 文档](https://www.pexels.com/api/) | 需要 API key；无专用随机端点，需搜索后随机 |
| 50 | SourceSplash | [官网](https://www.sourcesplash.com/) | 通用图片聚合；免费额度和内容授权需审核 |

## 6. 失效、不建议或不符合当前约束

| 服务 | 结果 | 原因 |
|---|---|---|
| waifu.pics | 失效 | API 子域 DNS 不可用，主站跳转到其他站点 |
| Gelbooru | 暂不接 | 无凭证请求实测 401，需要 user_id + api_key；且含成人内容 |
| Rule34 | 不接 | R18-only，不符合当前项目全年龄约束 |
| Konachan.com | 不接 | 含成人内容；仅考虑 Konachan.net |
| BTSTU | 本轮超时 | HTTP 000，无法确认稳定性 |
| VVHan | 本轮超时 | HTTP 000，无法确认稳定性 |
| SEOVX | 本轮超时 | HTTP 000，无法确认稳定性 |
| toubiec | 本轮超时 | HTTP 000，无法确认稳定性 |
| ixiaowai | 本轮超时 | HTTP 000，无法确认稳定性 |
| iw233 | 本轮超时 | HTTP 000，无法确认稳定性 |
| Oick | 404 | 旧端点失效 |
| loliapi `/pc/` | 404 | 应使用当前文档中的 `/acg/` 或 `/bg/` |
| mwm.moe `/pc` | 兼容跳转 | 实际跳到 alcy，不应重复接入 |

## 7. 建议审核顺序

1. **先用自有图库**：已确认全年龄；`randompic` 已接入，默认优先，且不依赖第三方 key。
2. **第一外部备用**：`pic.re`，官方明确 SFW，接口简单、直接返回 WebP。
3. **需要 tag 检索**：优先现有 Safebooru；其次 Lolicon（固定 `r18=0`，但图片域可能需要代理）。
4. **需要大图库**：Nekos API、Danbooru、Konachan.net；逐图过滤/限流后再启用。
5. **LoliAPI、栗次元、Jitsu、mtyqx、杜锦**：虽然本轮能返回图片，但先人工抽样，再决定是否接入生产。

本清单只用于审核，不会自动把第三方服务加入默认数据源。
