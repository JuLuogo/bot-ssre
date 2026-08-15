// 图片中转：QQ 官方只能自己去拉 URL（接口不收字节），而它的国内服务器拉不动
// 慢反代（如 pixiv 回源冷启动 10s+）会超时报 40093007。
// 于是让 Worker 先把图下载好、存进 R2，再把 bot 自己的静态地址 /img/<key> 交给 QQ——
// 这个地址是「秒回静态」，和已验证能通的 pic.060730.xyz 同类，QQ 就能拉到。
//
// 只为 QQ 中转：**发完立即删**，不常驻存储。后台画廊预览直接用原反代地址
// （管理员浏览器能直接访问反代，无需中转）。pruneOrphans 只兜底清理极少数
// 「Worker 中途崩溃、put 了没 delete」的孤儿对象。
import type { Env } from "./types";

const PREFIX = "relay/";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";
const MAX_BYTES = 20 * 1024 * 1024; // QQ 富媒体上限较高，这里防御性截断
const ORPHAN_MAX_AGE_HOURS = 6; // 正常对象秒删，超过此龄的必是孤儿

const keyRe = /^[a-f0-9]{32}$/;

/**
 * 下载图片存进 R2，返回随机 key（失败返回 null）。
 * key 是 128bit 随机、不可枚举；调用方拼成 {PUBLIC_BASE_URL}/img/<key> 交给 QQ，发完即删。
 */
export async function stageImage(env: Env, imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": BROWSER_UA, Referer: "https://www.pixiv.net/" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    const key = crypto.randomUUID().replace(/-/g, "");
    await env.R2.put(PREFIX + key, buf, { httpMetadata: { contentType: ct } });
    return key;
  } catch {
    return null;
  }
}

/** 删除中转对象（QQ 在 /files 阶段已取走，发送后立即调用）。best-effort。 */
export async function dropImage(env: Env, key: string): Promise<void> {
  if (!keyRe.test(key)) return;
  try {
    await env.R2.delete(PREFIX + key);
  } catch {
    // ignore
  }
}

/** 公开路由 GET /img/<key>：从 R2 取字节返回。只服务图片，key 不可枚举。 */
export async function serveImage(env: Env, key: string): Promise<Response> {
  if (!keyRe.test(key)) return new Response("bad key", { status: 400 });
  const obj = await env.R2.get(PREFIX + key);
  if (!obj) return new Response("not found", { status: 404 });
  const ct = obj.httpMetadata?.contentType || "image/jpeg";
  return new Response(obj.body, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** 兜底清理孤儿对象（正常发完即删，这里只清 Worker 崩溃遗留的）。每日 cron 调用。 */
export async function pruneOrphans(env: Env): Promise<number> {
  const cutoff = Date.now() - ORPHAN_MAX_AGE_HOURS * 3600 * 1000;
  const toDelete: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const list = await env.R2.list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const o of list.objects) {
        if (o.uploaded.getTime() < cutoff) toDelete.push(o.key);
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor && toDelete.length < 1000);
    if (toDelete.length) await env.R2.delete(toDelete);
  } catch {
    // ignore
  }
  return toDelete.length;
}
