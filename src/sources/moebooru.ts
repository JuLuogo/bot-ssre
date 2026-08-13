// Moebooru 适配器：yande.re / konachan 的 post.json。
import type { Env, Illust, SourceAdapter, SourceOptions } from "../types";
import { fetchJson } from "../http";
import { normalizeBooruRating } from "../filter";

interface MoebooruPost {
  id: number | string;
  file_url?: string;
  sample_url?: string;
  preview_url?: string;
  rating?: string;
  score?: number;
  tags?: string;
  author?: string;
}

export const moebooru: SourceAdapter = {
  name: "moebooru",
  async fetchRanking(_env: Env, opts: SourceOptions): Promise<Illust[]> {
    const site = (opts.site || "https://konachan.com").replace(/\/$/, "");
    const tags = opts.tags ?? "";
    const url = `${site}/post.json?limit=${opts.limit}&tags=${encodeURIComponent(tags)}`;
    const posts = await fetchJson<MoebooruPost[]>(url);
    const host = new URL(site).hostname;
    const label = host.split(".")[0] || "moebooru";
    return (posts ?? [])
      .filter((p) => p.sample_url || p.file_url)
      .map((p): Illust => ({
        source: label,
        id: String(p.id),
        title: String(p.tags || "").split(/\s+/).slice(0, 3).join(" ") || `#${p.id}`,
        author: p.author || "",
        imageUrl: (p.sample_url || p.file_url)!,
        pageUrl: `${site}/post/show/${p.id}`,
        rating: normalizeBooruRating(p.rating),
        score: Number(p.score) || 0,
        tags: String(p.tags || "").split(/\s+/).filter(Boolean),
      }));
  },
};
