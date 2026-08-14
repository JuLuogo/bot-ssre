// 按需抓图（OneBot 命令用）：与运行时解耦的纯逻辑，便于日后移植到 VPS/Docker。
// 配置存独立 settings key `napcat_command`，不会被后台保存 napcat 渠道配置时覆盖。
import type { Env, Illust } from "./types";
import { getConfig } from "./config";
import { getSourceAdapter } from "./sources";
import { isAllAges } from "./filter";

export interface OnDemandConfig {
  enabled: boolean; // 是否响应命令
  triggers: string[]; // 触发词（后跟空格 + 关键词作为 tag）
  count: number; // 每次触发推送张数
  requireAtInGroup: boolean; // 群聊是否必须 @机器人
  allowPrivate: boolean; // 是否响应私聊
}

const DEFAULT_ONDEMAND: OnDemandConfig = {
  enabled: true,
  triggers: ["涩图", "/setu"],
  count: 1,
  requireAtInGroup: true,
  allowPrivate: true,
};

const ONDEMAND_KEY = "ondemand";

export async function getOnDemandConfig(env: Env): Promise<OnDemandConfig> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(ONDEMAND_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      const c = { ...DEFAULT_ONDEMAND, ...(JSON.parse(row.value) as Partial<OnDemandConfig>) };
      c.count = Math.max(1, Math.min(20, Number(c.count) || 1));
      if (!Array.isArray(c.triggers) || c.triggers.length === 0) c.triggers = DEFAULT_ONDEMAND.triggers;
      return c;
    }
  } catch {
    // 表未迁移/无记录：用默认
  }
  return DEFAULT_ONDEMAND;
}

export async function setOnDemandConfig(env: Env, cfg: OnDemandConfig): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(ONDEMAND_KEY, JSON.stringify(cfg))
    .run();
}

/** 命中触发词时返回其后的关键词作为 tag（要求触发词后是空格或结束，避免"涩图集"误触）。 */
export function matchTrigger(text: string, triggers: string[]): { hit: boolean; tags: string } {
  for (const trig of triggers) {
    if (!trig) continue;
    if (text === trig) return { hit: true, tags: "" };
    if (text.startsWith(trig)) {
      const after = text.slice(trig.length);
      if (/^\s/.test(after)) return { hit: true, tags: after.trim() };
    }
  }
  return { hit: false, tags: "" };
}

type Booru = { adapter: "gelbooru" | "moebooru"; site?: string; label?: string };

/** 按适配器拼接「安全 + 随机」的查询标签。 */
function booruQuery(adapter: Booru["adapter"], tags: string): string {
  const t = tags.trim();
  // moebooru（konachan/yande）用 rating:s / order:random；gelbooru 系用 rating:safe / sort:random
  return adapter === "moebooru" ? `${t} rating:s order:random`.trim() : `${t} rating:safe sort:random`.trim();
}

/**
 * 抓取 N 张全年龄插画（随机、去重、打乱）。优先用后台已启用的 booru 源，
 * 没有则回退 safebooru。始终经 isAllAges 二次过滤，只返回 rating:safe。
 */
export async function fetchRandomIllusts(env: Env, tags: string, count: number): Promise<Illust[]> {
  const cfg = await getConfig(env);
  const enabled: Booru[] = cfg.sources
    .filter((s) => s.enabled && (s.adapter === "gelbooru" || s.adapter === "moebooru"))
    .map((s) => ({ adapter: s.adapter as Booru["adapter"], site: s.site, label: s.label }));

  const candidates: Booru[] =
    enabled.length > 0 ? enabled : [{ adapter: "gelbooru", site: "https://safebooru.org", label: "safebooru" }];

  const want = Math.max(1, count);
  const perFetch = Math.min(100, Math.max(want * 3, 40));
  const pool: Illust[] = [];

  // 随机打乱源顺序，避免总命中同一个
  for (const s of candidates.sort(() => Math.random() - 0.5)) {
    const adapter = getSourceAdapter(s.adapter);
    if (!adapter) continue;
    try {
      const items = await adapter.fetchRanking(env, {
        limit: perFetch,
        tags: booruQuery(s.adapter, tags),
        site: s.site,
        label: s.label,
      });
      pool.push(...items.filter(isAllAges));
    } catch {
      // 换下一个源
    }
    if (pool.length >= want * 3) break;
  }

  // 去重(按 source:id) + 打乱 + 取前 want
  const seen = new Set<string>();
  const uniq: Illust[] = [];
  for (const it of pool.sort(() => Math.random() - 0.5)) {
    const k = `${it.source}:${it.id}`;
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(it);
    }
  }
  return uniq.slice(0, want);
}

/** 抓取一张全年龄插画（按需命令用）。 */
export async function fetchOneIllust(env: Env, tags: string): Promise<Illust | null> {
  const arr = await fetchRandomIllusts(env, tags, 1);
  return arr[0] ?? null;
}
