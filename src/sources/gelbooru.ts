// Gelbooru 风格适配器：safebooru / gelbooru 的 dapi JSON。
import type { Env, Illust, SourceAdapter, SourceOptions } from "../types";
import { fetchJson } from "../http";
import { normalizeBooruRating } from "../filter";

interface GelbooruPost {
  id: number | string;
  file_url?: string;
  sample_url?: string;
  preview_url?: string;
  rating?: string;
  score?: number | null;
  tags?: string;
}

function pickImage(p: GelbooruPost): string {
  return p.sample_url || p.file_url || p.preview_url || "";
}

export const gelbooru: SourceAdapter = {
  name: "gelbooru",
  async fetchRanking(_env: Env, opts: SourceOptions): Promise<Illust[]> {
    const site = (opts.site || "https://safebooru.org").replace(/\/$/, "");
    const host = new URL(site).hostname;
    const label = host.split(".")[0] || "gelbooru";

    const fetchOnce = async (tags: string): Promise<GelbooruPost[]> => {
      const url = `${site}/index.php?page=dapi&s=post&q=index&json=1&limit=${opts.limit}&tags=${encodeURIComponent(tags)}`;
      const data = await fetchJson<GelbooruPost[] | { post?: GelbooruPost[] }>(url);
      return Array.isArray(data) ? data : data.post ?? [];
    };

    // 部分 gelbooru fork 不支持 sort: 元标签，拉空则回退到无标签（最新）。
    let posts = await fetchOnce(opts.tags ?? "");
    if (posts.length === 0 && opts.tags) posts = await fetchOnce("");

    return posts
      .filter((p) => pickImage(p))
      .map((p): Illust => ({
        source: label,
        id: String(p.id),
        title: String(p.tags || "").split(/\s+/).slice(0, 3).join(" ") || `#${p.id}`,
        author: "",
        imageUrl: pickImage(p),
        pageUrl: `${site}/index.php?page=post&s=view&id=${p.id}`,
        rating: normalizeBooruRating(p.rating),
        score: Number(p.score) || 0,
        tags: String(p.tags || "").split(/\s+/).filter(Boolean),
      }));
  },
};
