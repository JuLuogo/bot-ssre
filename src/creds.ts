// 凭证层：允许在管理后台配置密钥/变量，存 D1 `credentials` 表（明文），运行时覆盖 env。
// 安全约定：
//  1) ADMIN_TOKEN 永不入库（它是保护 /api 的信任根，只能用 wrangler secret 设置）；
//  2) API 只回显掩码与来源，永不返回原文；
//  3) 未在 D1 配置的项自动回退到 wrangler secret / vars。
import type { Env } from "./types";

/** 允许后台写入的键（白名单，防止任意键注入） */
export const CREDENTIAL_KEYS = [
  "TG_BOT_TOKEN",
  "TG_WEBHOOK_SECRET",
  "NAPCAT_BASE_URL",
  "NAPCAT_TOKEN",
  "QQ_BOT_APPID",
  "QQ_BOT_SECRET",
  "PIXIV_PROXY_HOST",
] as const;

export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

const isAllowed = (name: string): name is CredentialKey =>
  (CREDENTIAL_KEYS as readonly string[]).includes(name);

/** 掩码显示：保留首尾各 4 位 */
export function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 4)}${"*".repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`;
}

interface CredRow {
  name: string;
  value: string;
  updated_at: number;
}

async function readAll(env: Env): Promise<CredRow[]> {
  try {
    const { results } = await env.DB.prepare("SELECT name, value, updated_at FROM credentials").all<CredRow>();
    return results ?? [];
  } catch {
    return []; // 表不存在（未迁移）时静默回退到 env
  }
}

/**
 * 合并 D1 凭证到 env（D1 优先），返回同样的 Env 形状，
 * 因此下游代码无需改动，只要在入口调用一次。
 */
export async function resolveEnv(env: Env): Promise<Env> {
  const rows = await readAll(env);
  if (rows.length === 0) return env;
  const overrides: Record<string, string> = {};
  for (const r of rows) {
    if (isAllowed(r.name) && r.value) overrides[r.name] = r.value;
  }
  return { ...env, ...overrides } as Env;
}

export interface CredentialStatus {
  name: CredentialKey;
  configured: boolean;
  source: "d1" | "env" | "none";
  masked: string;
  updatedAt: number | null;
}

/** 各凭证的配置状态（不含原文） */
export async function listCredentialStatus(env: Env): Promise<CredentialStatus[]> {
  const rows = await readAll(env);
  const byName = new Map(rows.map((r) => [r.name, r]));
  return CREDENTIAL_KEYS.map((name) => {
    const row = byName.get(name);
    const envVal = (env as unknown as Record<string, string | undefined>)[name] || "";
    if (row?.value) {
      return { name, configured: true, source: "d1" as const, masked: mask(row.value), updatedAt: row.updated_at };
    }
    if (envVal) {
      return { name, configured: true, source: "env" as const, masked: mask(envVal), updatedAt: null };
    }
    return { name, configured: false, source: "none" as const, masked: "", updatedAt: null };
  });
}

export async function setCredential(env: Env, name: string, value: string): Promise<boolean> {
  if (!isAllowed(name)) return false;
  await env.DB.prepare(
    "INSERT INTO credentials(name, value, updated_at) VALUES(?,?,?) " +
      "ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(name, value, Date.now())
    .run();
  return true;
}

/** 删除 D1 里的覆盖值，回退到 wrangler secret / vars */
export async function deleteCredential(env: Env, name: string): Promise<boolean> {
  if (!isAllowed(name)) return false;
  await env.DB.prepare("DELETE FROM credentials WHERE name = ?").bind(name).run();
  return true;
}
