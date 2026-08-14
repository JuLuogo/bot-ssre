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

<!-- MORE -->
