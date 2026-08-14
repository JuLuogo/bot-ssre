// 静态随机图适配器（如用户自建 https://pic.060730.xyz）。
// 读取站点 random.js 中的 counts={type:count,...}，但图片始终从配置的站点域名读取：
// {site}/ri/{type}/{num}.webp（num ∈ 1..count）。自动探测并跳过不可达类型。
// 无需执行客户端脚本；图库由站点保证内容分级（这里标 safe）。
import type { Env, Illust, SourceAdapter, SourceOptions } from "../types";

interface RandomPicManifest {
  counts: Record<string, number>;
  domains: Record<string, string>;
}

const CACHE_TTL = 900;

async function probeDomain(domain: string, type: string): Promise<boolean> {
  try {
    const res = await fetch(`${domain}/ri/${type}/1.webp`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok && (res.headers.get("Content-Type") || "").startsWith("image/");
  } catch {
    return false;
  }
}

async function resolveManifest(env: Env, site: string): Promise<RandomPicManifest> {
  const cacheKey = `randompic:manifest:${site}`;
  const cached = await env.KV.get<RandomPicManifest>(cacheKey, "json");
  if (cached && Object.keys(cached.domains).length > 0) return cached;

  const res = await fetch(`${site}/random.js`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`random.js HTTP ${res.status}`);
  const js = await res.text();

  let counts: Record<string, number> = {};
  try {
    counts = JSON.parse(js.match(/counts\s*=\s*(\{[^}]*\})/)?.[1] || "{}") as Record<string, number>;
  } catch {
    counts = {};
  }

  const domains: Record<string, string> = {};
  await Promise.all(
    Object.entries(counts).map(async ([type, count]) => {
      if (!Number.isInteger(count) || count <= 0) return;
      if (await probeDomain(site, type)) domains[type] = site;
    }),
  );

  const manifest = { counts, domains };
  if (Object.keys(domains).length > 0) {
    await env.KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: CACHE_TTL });
  }
  return manifest;
}

function selectImage(manifest: RandomPicManifest, types: string[], picked: Set<string>): string | null {
  const available = types.filter((type) => manifest.domains[type] && Number(manifest.counts[type]) > 0);
  const capacity = available.reduce((sum, type) => sum + manifest.counts[type], 0);
  if (picked.size >= capacity || capacity === 0) return null;

  for (;;) {
    let offset = Math.floor(Math.random() * capacity);
    let chosen = available[0];
    for (const type of available) {
      if (offset < manifest.counts[type]) {
        chosen = type;
        break;
      }
      offset -= manifest.counts[type];
    }
    const num = Math.floor(Math.random() * manifest.counts[chosen]) + 1;
    const id = `${chosen}-${num}`;
    if (!picked.has(id)) return id;
  }
}

export const randompic: SourceAdapter = {
  name: "randompic",
  async fetchRanking(env: Env, opts: SourceOptions): Promise<Illust[]> {
    const site = (opts.site || "https://pic.060730.xyz").replace(/\/$/, "");
    const manifest = await resolveManifest(env, site);
    const configured = (opts.mode || Object.keys(manifest.counts).join(","))
      .split(/[,，\s]+/)
      .filter(Boolean);
    const usable = configured.filter((type) => manifest.domains[type] && Number(manifest.counts[type]) > 0);
    if (usable.length === 0) throw new Error("randompic 没有可达的图片类型");

    const capacity = usable.reduce((sum, type) => sum + manifest.counts[type], 0);
    const limit = Math.min(Math.max(0, opts.limit), capacity);
    const picked = new Set<string>();
    while (picked.size < limit) {
      const id = selectImage(manifest, usable, picked);
      if (!id) break;
      picked.add(id);
    }

    const label = opts.label || "randompic";
    return [...picked].map((id): Illust => {
      const [type, num] = id.split("-");
      const imageUrl = `${manifest.domains[type]}/ri/${type}/${num}.webp`;
      return {
        source: label,
        id,
        title: `${label} ${type}#${num}`,
        author: "",
        imageUrl,
        pageUrl: imageUrl,
        rating: "safe",
        score: 0,
        tags: [],
      };
    });
  },
};
