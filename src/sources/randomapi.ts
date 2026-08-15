// 第三方随机图 API 适配器：按注册表 provider 的协议取「稳定图片 URL」。
// site 字段存 provider slug（经注册表校验，非任意 URL）；tags 仅对 supportsTags 的源生效。
import type { Env, Illust, SourceAdapter, SourceOptions } from "../types";
import { getProvider, type RandomProvider } from "./randomapi_providers";

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;
const TIMEOUT_MS = 12000;
const MAX_PER_RUN = 6; // 单个 provider 单次最多外部请求数，控制配额

/** 校验最终图片 URL：必须 https；指定 host 时按后缀匹配，否则要求图片扩展名。 */
function validImageUrl(raw: string | null | undefined, hosts?: string[]): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (hosts && hosts.length > 0) {
    const ok = hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    return ok ? u.toString() : null;
  }
  return IMG_EXT.test(u.pathname) || IMG_EXT.test(u.search) ? u.toString() : null;
}

async function fetchJsonUrl(p: RandomProvider, tags: string): Promise<string[]> {
  let endpoint = p.endpoint;
  if (p.supportsTags && tags.trim()) endpoint += `${endpoint.includes("?") ? "&" : "?"}tag=${encodeURIComponent(tags.trim())}`;
  const res = await fetch(endpoint, { headers: p.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${p.slug} HTTP ${res.status}`);
  const data = await res.json();
  const out = p.extract ? p.extract(data) : undefined;
  const arr = Array.isArray(out) ? out : out ? [out] : [];
  return arr.map((u) => validImageUrl(u, p.imageHosts)).filter((u): u is string => !!u);
}

async function fetchRedirectUrl(p: RandomProvider): Promise<string[]> {
  const res = await fetch(p.endpoint, {
    method: "GET",
    headers: p.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const loc = res.headers.get("location");
  const u = validImageUrl(loc, p.imageHosts);
  return u ? [u] : [];
}

export const randomapi: SourceAdapter = {
  name: "randomapi",
  async fetchRanking(_env: Env, opts: SourceOptions): Promise<Illust[]> {
    const p = getProvider((opts.site || "").trim());
    if (!p || p.needsKey) return []; // 未知或需密钥的源不可运行
    const want = Math.max(1, Math.min(MAX_PER_RUN, opts.limit));
    const label = opts.label || p.slug;
    const tags = opts.tags || "";

    // direct：端点即随机图，用随机参数生成多张互不相同的稳定 URL
    if (p.protocol === "direct") {
      const out: Illust[] = [];
      for (let i = 0; i < want; i++) {
        const cb = crypto.randomUUID();
        const imageUrl = `${p.endpoint}${p.endpoint.includes("?") ? "&" : "?"}_cb=${cb}`;
        if (!validImageUrl(imageUrl, p.imageHosts)) break;
        out.push(toIllust(label, `${p.slug}:${cb}`, imageUrl));
      }
      return out;
    }

    // json / redirect：并发多次取，去重
    const tasks = Array.from({ length: want }, () =>
      p.protocol === "json" ? fetchJsonUrl(p, tags) : fetchRedirectUrl(p),
    );
    const settled = await Promise.allSettled(tasks);
    const seen = new Set<string>();
    const out: Illust[] = [];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const url of r.value) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(toIllust(label, `${p.slug}:${idFromUrl(url)}`, url));
      }
    }
    return out;
  },
};

function idFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
    return seg || url.slice(-24);
  } catch {
    return url.slice(-24);
  }
}

function toIllust(label: string, id: string, imageUrl: string): Illust {
  return {
    source: label,
    id,
    title: label,
    author: "",
    imageUrl,
    pageUrl: imageUrl,
    rating: "safe", // 注册表仅收录全年龄/安全参数的源
    score: 0,
    tags: [],
  };
}
