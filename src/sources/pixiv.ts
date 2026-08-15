// Pixiv 排行榜适配器：ranking.php JSON + i.pximg 反代。
import type { Env, Illust, SourceAdapter, SourceOptions } from "../types";
import { fetchJson } from "../http";

interface PixivRankItem {
  illust_id: number | string;
  title: string;
  user_name: string;
  url: string;
  tags: string[];
  rank: number;
  view_count?: number;
  illust_content_type?: { sexual?: number; lo?: boolean; grotesque?: boolean };
}

// 完整伪装成浏览器请求 Pixiv：只带爬虫 UA / 缺 Origin 时 Pixiv 常直接 403，
// 即便出口 IP 干净也会被拦。头照 JuLuogo/pixiv(Vercel 反代)项目对齐。
const PIXIV_BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  Origin: "https://www.pixiv.net",
  Referer: "https://www.pixiv.net/",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
};

/**
 * 把榜单返回的图片地址整体改用 PIXIV_PROXY_HOST（换掉 origin，保留路径）。
 * 不能只 `replace("i.pximg.net")`：若 PIXIV_API_BASE 是 PixivNow 类实例，返回的图片域名
 * 已被它换成自家代理（路径仍是 pximg 路径），此时应统一改回后台配置的自有反代域名。
 */
function toProxyUrl(rawUrl: string, host: string): string {
  if (!host) return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.protocol = "https:";
    u.host = host;
    return u.toString();
  } catch {
    return rawUrl.replace("i.pximg.net", host);
  }
}

export const pixiv: SourceAdapter = {
  name: "pixiv",
  async fetchRanking(env: Env, opts: SourceOptions): Promise<Illust[]> {
    const host = (env.PIXIV_PROXY_HOST || "").trim();
    if (!host) {
      console.warn("[pixiv] PIXIV_PROXY_HOST 未配置，跳过 Pixiv 源");
      return [];
    }
    const mode = opts.mode || "daily"; // 使用非 _r18 榜单
    // 榜单 API 走反代(PIXIV_API_BASE)以绕开 Pixiv 对 Cloudflare/机房 IP 的 403 封锁；留空则直连。
    const apiBase = (env.PIXIV_API_BASE || "https://www.pixiv.net").replace(/\/$/, "");
    const want = Math.max(1, opts.limit);
    // 榜单每页约 50；需要更多就翻页拼够（硬上限 10 页 ≈ 500，防失控）。
    const maxPages = Math.min(10, Math.ceil(want / 50));
    const raw: PixivRankItem[] = [];
    for (let p = 1; p <= maxPages && raw.length < want; p++) {
      const url = `${apiBase}/ranking.php?mode=${encodeURIComponent(mode)}&content=illust&format=json&p=${p}`;
      let data: { contents?: PixivRankItem[] };
      try {
        data = await fetchJson<{ contents?: PixivRankItem[] }>(url, { headers: PIXIV_BROWSER_HEADERS });
      } catch (e) {
        if (p === 1) throw e; // 第一页就失败才算真失败；后续页失败用已拿到的
        break;
      }
      const page = data.contents ?? [];
      if (page.length === 0) break;
      raw.push(...page);
    }
    return raw
      // 丢弃 pixiv 的"受限/需登录"占位图（url 落在 s.pximg.net/common/.../limit_unviewable*）：
      // 它不是真作品，推过去只是一张灰色占位 PNG。
      .filter((c) => {
        const u = String(c.url || "");
        return u && !u.includes("limit_unviewable") && !u.includes("s.pximg.net/common");
      })
      .slice(0, want)
      .map((c): Illust => {
        const ct = c.illust_content_type ?? {};
        const safe = (ct.sexual ?? 0) === 0 && !ct.lo && !ct.grotesque;
        return {
          source: "pixiv",
          id: String(c.illust_id),
          title: c.title || `#${c.illust_id}`,
          author: c.user_name || "",
          imageUrl: toProxyUrl(String(c.url || ""), host),
          pageUrl: `https://www.pixiv.net/artworks/${c.illust_id}`,
          rating: safe ? "safe" : (ct.sexual ?? 0) >= 2 ? "explicit" : "questionable",
          score: Number(c.view_count) || 0,
          tags: Array.isArray(c.tags) ? c.tags : [],
          rank: Number(c.rank) || undefined,
        };
      });
  },
};
