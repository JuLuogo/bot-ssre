// 轻量诊断日志（KV 环形缓冲）：用于排查"发了触发词没反应"这类线上问题。
// 刻意不落 D1：新表需要迁移，而本项目迁移要经 Cloudflare MCP 手动执行，MCP 不可用时会建不出表。
import type { Env } from "./types";

const KEY = "diag:events";
const MAX = 40;
const TTL_DAYS = 7;

export interface DiagEntry {
  ts: number;
  scope: string; // qqbot / telegram / onebot / push
  msg: string;
}

/** 追加一条诊断记录；任何失败都吞掉（诊断本身绝不能影响主流程）。 */
export async function diag(env: Env, scope: string, msg: string): Promise<void> {
  try {
    const cur = (await env.KV.get<DiagEntry[]>(KEY, "json")) ?? [];
    const next = [{ ts: Date.now(), scope, msg: msg.slice(0, 600) }, ...cur].slice(0, MAX);
    await env.KV.put(KEY, JSON.stringify(next), { expirationTtl: TTL_DAYS * 86400 });
  } catch {
    // ignore
  }
}

export async function listDiag(env: Env): Promise<DiagEntry[]> {
  try {
    return (await env.KV.get<DiagEntry[]>(KEY, "json")) ?? [];
  } catch {
    return [];
  }
}

export async function clearDiag(env: Env): Promise<void> {
  try {
    await env.KV.delete(KEY);
  } catch {
    // ignore
  }
}
