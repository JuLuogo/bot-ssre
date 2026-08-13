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

export const pixiv: SourceAdapter = {
  name: "pixiv",
  async fetchRanking(env: Env, opts: SourceOptions): Promise<Illust[]> {
    const host = (env.PIXIV_PROXY_HOST || "").trim();
    if (!host) {
      console.warn("[pixiv] PIXIV_PROXY_HOST 未配置，跳过 Pixiv 源");
      return [];
    }
    const mode = opts.mode || "daily"; // 使用非 _r18 榜单
    const url = `https://www.pixiv.net/ranking.php?mode=${encodeURIComponent(mode)}&content=illust&format=json&p=1`;
    const data = await fetchJson<{ contents?: PixivRankItem[] }>(url, {
      headers: { Referer: "https://www.pixiv.net/" },
    });
    const contents = data.contents ?? [];
    return contents.slice(0, opts.limit).map((c): Illust => {
      const ct = c.illust_content_type ?? {};
      const safe = (ct.sexual ?? 0) === 0 && !ct.lo && !ct.grotesque;
      return {
        source: "pixiv",
        id: String(c.illust_id),
        title: c.title || `#${c.illust_id}`,
        author: c.user_name || "",
        imageUrl: String(c.url || "").replace("i.pximg.net", host),
        pageUrl: `https://www.pixiv.net/artworks/${c.illust_id}`,
        rating: safe ? "safe" : (ct.sexual ?? 0) >= 2 ? "explicit" : "questionable",
        score: Number(c.view_count) || 0,
        tags: Array.isArray(c.tags) ? c.tags : [],
        rank: Number(c.rank) || undefined,
      };
    });
  },
};
