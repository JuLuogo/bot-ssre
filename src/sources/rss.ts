// RSS / RSSHub 适配器：拉取 RSS/Atom XML，提取每条的图片，归一化为 Illust（trusted 源）。
import type { Env, Illust, SourceAdapter, SourceOptions } from "../types";
import { UA } from "../http";

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagText(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decodeEntities(m[1]) : undefined;
}

function extractImages(xmlBlock: string): string[] {
  const urls = new Set<string>();
  const add = (u: string) => urls.add(u.replace(/&amp;/g, "&"));
  for (const m of xmlBlock.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of xmlBlock.matchAll(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of xmlBlock.matchAll(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/gi)) add(m[1]);
  return [...urls];
}

export const rss: SourceAdapter = {
  name: "rss",
  async fetchRanking(_env: Env, opts: SourceOptions): Promise<Illust[]> {
    const url = opts.site;
    if (!url) throw new Error("RSS 订阅缺少 URL（site 字段）");
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
    const xml = await res.text();
    const label = opts.label || new URL(url).hostname;

    const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    const out: Illust[] = [];
    for (const block of blocks.slice(0, opts.limit)) {
      const title = tagText(block, "title") || "";
      let link = tagText(block, "link") || "";
      if (!link) {
        const lm = block.match(/<link[^>]+href=["']([^"']+)["']/i);
        if (lm) link = lm[1];
      }
      const guid = tagText(block, "guid") || tagText(block, "id") || link || title;
      const author =
        tagText(block, "dc:creator") || tagText(block, "author") || tagText(block, "name") || "";
      const content =
        tagText(block, "content:encoded") || tagText(block, "description") || tagText(block, "content") || "";

      extractImages(content + " " + block).forEach((img, idx) => {
        out.push({
          source: label,
          id: `${guid}#${idx}`,
          title: title || "(RSS)",
          author,
          imageUrl: img,
          pageUrl: link || url,
          rating: "safe", // trusted 订阅来源
          score: 0,
          tags: [],
        });
      });
    }
    return out;
  },
};
