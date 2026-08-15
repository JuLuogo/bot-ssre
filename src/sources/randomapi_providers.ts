// 第三方随机图 API 固定注册表（审核通过后才写入代码；后台只能开关，不能填任意 URL，防 SSRF）。
// 协议：
//   json     —— GET 端点，解析 JSON 取图片 URL（经 extract 提取 + host 校验）
//   redirect —— GET 端点，手动读 302 Location 得到稳定图片 URL（+ host 校验）
//   direct   —— 端点本身每次返回随机图片二进制；直接把端点当图片 URL（加随机参数区分多张）
// needsKey=true 的项在后台显示但不可启用（缺少凭证入口）。

export type ProviderProtocol = "json" | "redirect" | "direct";

export interface RandomProvider {
  slug: string;
  name: string;
  docUrl: string;
  endpoint: string;
  protocol: ProviderProtocol;
  /** 允许的最终图片 host 后缀；留空表示放宽为「https + 图片扩展名」校验（用于跳转目标域名不固定的源）。 */
  imageHosts?: string[];
  supportsTags?: boolean;
  needsKey?: boolean;
  note?: string;
  headers?: Record<string, string>;
  /** json 协议：从响应体提取一个或多个图片 URL。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extract?: (data: any) => string | string[] | undefined | null;
}

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const RANDOM_PROVIDERS: RandomProvider[] = [
  // ---------- JSON ----------
  {
    slug: "lolicon",
    name: "Lolicon（Pixiv 系，可关键词）",
    docUrl: "https://api.lolicon.app/",
    endpoint: "https://api.lolicon.app/setu/v2?r18=0&num=1&size=regular&proxy=i.pixiv.re",
    protocol: "json",
    imageHosts: ["i.pixiv.re"],
    supportsTags: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extract: (d: any) => d?.data?.[0]?.urls?.regular ?? d?.data?.[0]?.urls?.original,
    note: "r18=0 全年龄；图片走 i.pixiv.re 代理，可直接被 TG/QQ 拉取。",
  },
  {
    slug: "nekos-best",
    name: "nekos.best（全 SFW）",
    docUrl: "https://docs.nekos.best/",
    endpoint: "https://nekos.best/api/v2/neko",
    protocol: "json",
    imageHosts: ["nekos.best"],
    headers: { "User-Agent": BROWSER_UA },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extract: (d: any) => d?.results?.[0]?.url,
  },
  {
    slug: "nekosia",
    name: "Nekosia（全 SFW）",
    docUrl: "https://nekosia.cat/documentation",
    endpoint: "https://api.nekosia.cat/api/v1/images/catgirl",
    protocol: "json",
    imageHosts: ["nekosia.cat"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extract: (d: any) => d?.image?.original?.url ?? d?.image?.compressed?.url,
  },
  {
    slug: "nekos-life",
    name: "nekos.life",
    docUrl: "https://nekos.life/",
    endpoint: "https://nekos.life/api/v2/img/neko",
    protocol: "json",
    imageHosts: ["nekos.life"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extract: (d: any) => d?.url,
  },
  {
    slug: "purrbot",
    name: "PurrBot（SFW neko）",
    docUrl: "https://docs.purrbot.site/api",
    endpoint: "https://api.purrbot.site/v2/img/sfw/neko/img",
    protocol: "json",
    imageHosts: ["purrbot.site"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extract: (d: any) => d?.link,
  },
  {
    slug: "waifu-im",
    name: "waifu.im（默认 SFW）",
    docUrl: "https://docs.waifu.im/",
    endpoint: "https://api.waifu.im/search?is_nsfw=false",
    protocol: "json",
    imageHosts: ["waifu.im"],
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extract: (d: any) => d?.images?.[0]?.url,
    note: "部分机房 IP 可能被 Cloudflare 挡（403），失败会自动切换其它源。",
  },
  {
    slug: "nekos-dev",
    name: "nekos.dev v3（SFW）",
    docUrl: "https://nekos.dev/",
    endpoint: "https://api.nekos.dev/api/v3/images/sfw/img/neko",
    protocol: "json",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extract: (d: any) => d?.data?.response?.url ?? d?.url,
    note: "跳转/CDN 域名不固定，按 https + 图片扩展名校验。",
  },

  // ---------- redirect (302 → 稳定图片 URL) ----------
  {
    slug: "alcy-moe",
    name: "栗次元 · 萌图",
    docUrl: "https://t.alcy.cc/",
    endpoint: "https://t.alcy.cc/moe/",
    protocol: "redirect",
    imageHosts: ["alcy.cc"],
  },
  {
    slug: "alcy-mp",
    name: "栗次元 · 竖屏",
    docUrl: "https://t.alcy.cc/",
    endpoint: "https://t.alcy.cc/mp/",
    protocol: "redirect",
    imageHosts: ["alcy.cc"],
  },
  {
    slug: "alcy-ycy",
    name: "栗次元 · 原神",
    docUrl: "https://t.alcy.cc/",
    endpoint: "https://t.alcy.cc/ycy/",
    protocol: "redirect",
    imageHosts: ["alcy.cc"],
  },
  {
    slug: "paugram",
    name: "Paugram 壁纸",
    docUrl: "https://api.paugram.com/",
    endpoint: "https://api.paugram.com/wallpaper/",
    protocol: "redirect",
    imageHosts: ["loli.net"],
  },
  {
    slug: "loliapi-acg",
    name: "LoliAPI · ACG",
    docUrl: "https://docs.loliapi.com/",
    endpoint: "https://www.loliapi.com/acg/",
    protocol: "redirect",
    note: "跳转目标域名会变，按 https + 图片扩展名校验。",
  },
  {
    slug: "jitsu",
    name: "Jitsu 随机图",
    docUrl: "https://moe.jitsu.top/",
    endpoint: "https://moe.jitsu.top/img/",
    protocol: "redirect",
    note: "跳转目标域名不固定，按 https + 图片扩展名校验。",
  },
  {
    slug: "nekosapi-file",
    name: "Nekos API（SFW 直转）",
    docUrl: "https://nekosapi.com/docs",
    endpoint: "https://api.nekosapi.com/v4/images/random/file?rating=safe",
    protocol: "redirect",
    note: "302 转 CDN 图片，域名不固定，按 https + 图片扩展名校验。",
  },

  // ---------- direct (端点每次随机返回图片) ----------
  {
    slug: "pic-re",
    name: "pic.re（官方 SFW，7 万+）",
    docUrl: "https://doc.pic.re/",
    endpoint: "https://pic.re/image",
    protocol: "direct",
    imageHosts: ["pic.re"],
  },
  {
    slug: "dmoe",
    name: "樱花 DMOE 随机图",
    docUrl: "https://www.dmoe.cc/",
    endpoint: "https://www.dmoe.cc/random.php",
    protocol: "direct",
    imageHosts: ["dmoe.cc"],
  },

  // ---------- 需要密钥/令牌：后台展示但暂不可启用 ----------
  {
    slug: "unsplash",
    name: "Unsplash（需 Access Key）",
    docUrl: "https://unsplash.com/documentation",
    endpoint: "https://api.unsplash.com/photos/random",
    protocol: "json",
    needsKey: true,
    note: "需要 Access Key 且须遵守署名/下载追踪；当前未接入凭证入口。",
  },
  {
    slug: "waifu-it",
    name: "Waifu.it（需 Token）",
    docUrl: "https://docs.waifu.it/",
    endpoint: "https://waifu.it/api/v4/waifu",
    protocol: "json",
    needsKey: true,
    note: "需要 Authorization token；当前未接入凭证入口。",
  },
];

export function getProvider(slug: string): RandomProvider | undefined {
  return RANDOM_PROVIDERS.find((p) => p.slug === slug);
}

/** 后台展示用：不含 extract 函数的可序列化清单。 */
export function listProviderMeta(): Array<
  Pick<RandomProvider, "slug" | "name" | "docUrl" | "protocol" | "supportsTags" | "needsKey" | "note">
> {
  return RANDOM_PROVIDERS.map((p) => ({
    slug: p.slug,
    name: p.name,
    docUrl: p.docUrl,
    protocol: p.protocol,
    supportsTags: !!p.supportsTags,
    needsKey: !!p.needsKey,
    note: p.note,
  }));
}
