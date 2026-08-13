// KV：去重标记与 cron 幂等标记。（推送记录 / 运行历史见 db.ts）
import type { Env } from "./types";

const seenKey = (source: string, id: string) => `seen:${source}:${id}`;

export async function isSeen(env: Env, source: string, id: string): Promise<boolean> {
  return (await env.KV.get(seenKey(source, id))) !== null;
}

export async function markSeen(env: Env, source: string, id: string, ttlDays: number): Promise<void> {
  await env.KV.put(seenKey(source, id), "1", { expirationTtl: Math.max(60, Math.floor(ttlDays * 86400)) });
}

/** cron at-least-once 幂等：同一 execId 只跑一次。返回 true 表示已执行过。 */
export async function alreadyExecuted(env: Env, execId: string): Promise<boolean> {
  if (await env.KV.get(`exec:${execId}`)) return true;
  await env.KV.put(`exec:${execId}`, "1", { expirationTtl: 3600 });
  return false;
}
