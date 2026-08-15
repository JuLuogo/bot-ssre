// 按需抓图（OneBot 命令用）：与运行时解耦的纯逻辑，便于日后移植到 VPS/Docker。
// 配置存 settings key `ondemand`，由所有平台的提示词触发返图共用。
import type { Env, Illust, SourceConfig } from "./types";
import { getConfig } from "./config";
import { getSourceAdapter } from "./sources";
import { isAllAges } from "./filter";

export interface OnDemandConfig {
  enabled: boolean; // 是否响应命令
  triggers: string[]; // 全局随机触发词（后跟空格 + 关键词作为 tag）
  rankingTriggers: string[]; // 大类：pixiv 榜单触发词
  count: number; // 每次触发推送张数
  requireAtInGroup: boolean; // 群聊是否必须 @机器人
  allowPrivate: boolean; // 是否响应私聊
}

const DEFAULT_ONDEMAND: OnDemandConfig = {
  enabled: true,
  triggers: ["涩图", "色图", "来张图", "/setu"],
  rankingTriggers: ["排行", "榜单", "pixiv"],
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
      if (!Array.isArray(c.rankingTriggers)) c.rankingTriggers = DEFAULT_ONDEMAND.rankingTriggers;
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

/** 去掉首尾空白（含全角空格）与开头残留的 @机器人 文本。 */
function clean(s: string): string {
  return s
    .replace(/^[\s　]+|[\s　]+$/g, "")
    .replace(/^@\S+[\s　]*/, "");
}

/**
 * 等长归一：把易混的「色」并到「涩」（用户在「涩图」「色图」之间摇摆，配一个就都能触发），
 * 并做 ASCII 小写。刻意保持与输入等长，使下标可直接用于取关键词。
 */
function fold(s: string): string {
  return s.replace(/色/g, "涩").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** 命中触发词时返回其后的关键词作为 tag（要求触发词后是空格或结束，避免"涩图集"误触）。 */
export function matchTrigger(text: string, triggers: string[]): { hit: boolean; tags: string } {
  const cleaned = clean(text);
  const folded = fold(cleaned);
  for (const trig of triggers) {
    if (!trig) continue;
    const t = fold(clean(trig));
    if (!t) continue;
    if (folded === t) return { hit: true, tags: "" };
    if (folded.startsWith(t) && /^[\s　]/.test(folded.slice(t.length))) {
      // 关键词取自原文，避免把 tag 里的「色」也改成「涩」
      return { hit: true, tags: cleaned.slice(t.length).trim() };
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

function dedupeShuffle(pool: Illust[], want: number): Illust[] {
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

/**
 * 抓取 N 张全年龄插画（随机、去重、打乱）。
 * 无关键词时优先随机图源（自有 pic 站 + 已启用的第三方随机图 API），随机顺序、逐个故障切换；
 * 有关键词或随机源都失败时走 booru（支持按 tag 检索），并经 isAllAges 只留 rating:safe。
 */
export async function fetchRandomIllusts(env: Env, tags: string, count: number): Promise<Illust[]> {
  const cfg = await getConfig(env);
  const want = Math.max(1, count);

  // 1) 无关键词：随机图源（randompic + randomapi）随机顺序尝试，失败自动切换
  if (!tags.trim()) {
    const randomSources = cfg.sources.filter(
      (s) => s.enabled && (s.adapter === "randompic" || s.adapter === "randomapi"),
    );
    const pool: Illust[] = [];
    for (const s of randomSources.sort(() => Math.random() - 0.5)) {
      const adapter = getSourceAdapter(s.adapter);
      if (!adapter) continue;
      try {
        const items =
          (await adapter.fetchRanking(env, { limit: want, site: s.site, mode: s.mode, label: s.label })) ?? [];
        pool.push(...items);
      } catch {
        // 故障切换到下一个随机源
      }
      if (pool.length >= want) break;
    }
    if (pool.length > 0) return dedupeShuffle(pool, want);
  }

  // 2) booru 随机（支持 tag）
  const enabled: Booru[] = cfg.sources
    .filter((s) => s.enabled && (s.adapter === "gelbooru" || s.adapter === "moebooru"))
    .map((s) => ({ adapter: s.adapter as Booru["adapter"], site: s.site, label: s.label }));

  const candidates: Booru[] =
    enabled.length > 0 ? enabled : [{ adapter: "gelbooru", site: "https://safebooru.org", label: "safebooru" }];

  const perFetch = Math.min(100, Math.max(want * 3, 40));
  const pool: Illust[] = [];
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
  return dedupeShuffle(pool, want);
}

/** 抓取一张全年龄插画（按需命令用）。 */
export async function fetchOneIllust(env: Env, tags: string): Promise<Illust | null> {
  const arr = await fetchRandomIllusts(env, tags, 1);
  return arr[0] ?? null;
}

// ---------------- 触发解析 / 单源抓取 / 榜单分批 / 菜单 ----------------

const RANKING_FULL_MAX = 100; // pixiv「全部」模式一天最多铺开多少张（多页抓取上限）

export type Action =
  | { kind: "source"; source: SourceConfig; tags: string }
  | { kind: "ranking"; tags: string }
  | { kind: "random"; tags: string }
  | { kind: "menu" };

/**
 * 解析一条消息该触发什么（三平台共用）。优先级：
 * 源专属触发词 > 大类榜单触发词 > 全局随机触发词 > 菜单兜底。
 */
export async function resolveAction(env: Env, text: string): Promise<Action> {
  const od = await getOnDemandConfig(env);
  const cfg = await getConfig(env);
  // 1) 源专属触发词
  for (const s of cfg.sources) {
    if (!s.enabled || !s.trigger || !s.trigger.trim()) continue;
    const { hit, tags } = matchTrigger(text, [s.trigger]);
    if (hit) return { kind: "source", source: s, tags };
  }
  // 2) 大类：pixiv 榜单
  const rank = matchTrigger(text, od.rankingTriggers);
  if (rank.hit) return { kind: "ranking", tags: rank.tags };
  // 3) 全局随机（现有外壳）
  const rand = matchTrigger(text, od.triggers);
  if (rand.hit) return { kind: "random", tags: rand.tags };
  // 4) 菜单兜底
  return { kind: "menu" };
}

/** 从指定的一个源抓 count 张（按 adapter 分派）。 */
export async function fetchFromSource(env: Env, source: SourceConfig, count: number, tags: string): Promise<Illust[]> {
  const adapter = getSourceAdapter(source.adapter);
  if (!adapter) return [];
  const want = Math.max(1, count);

  if (source.adapter === "pixiv") {
    if (source.pushAll) return fetchRankingBatch(env, source, want);
    const items = await adapter.fetchRanking(env, { limit: want, mode: source.mode, site: source.site, label: source.label });
    return items.slice(0, want);
  }
  if (source.adapter === "gelbooru" || source.adapter === "moebooru") {
    const items = await adapter.fetchRanking(env, {
      limit: Math.min(100, Math.max(want * 3, 40)),
      tags: booruQuery(source.adapter, tags),
      site: source.site,
      label: source.label,
    });
    return dedupeShuffle(items.filter(isAllAges), want);
  }
  // randompic / randomapi / rss
  const items = (await adapter.fetchRanking(env, { limit: want, site: source.site, mode: source.mode, label: source.label, tags })) ?? [];
  return dedupeShuffle(items, want);
}

/**
 * pixiv 榜单「全部」分批：整榜缓存 KV，按 offset 每次取一批，跨调用推进，记录进度；
 * 跨天缓存换新自动从头开始；本日推完返回空数组。
 */
export async function fetchRankingBatch(env: Env, source: SourceConfig, chunk: number): Promise<Illust[]> {
  const id = source.id ?? 0;
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `rankcache:${id}:${today}`;
  const offKey = `rankoffset:${id}`;

  let list = await env.KV.get<Illust[]>(cacheKey, "json").catch(() => null);
  if (!list || list.length === 0) {
    const adapter = getSourceAdapter("pixiv");
    if (!adapter) return [];
    list = await adapter.fetchRanking(env, {
      limit: RANKING_FULL_MAX,
      mode: source.mode,
      site: source.site,
      label: source.label,
    });
    if (!list || list.length === 0) return [];
    await env.KV.put(cacheKey, JSON.stringify(list), { expirationTtl: 86400 });
    await env.KV.put(offKey, JSON.stringify({ date: today, offset: 0 }), { expirationTtl: 2 * 86400 });
  }

  const prog = (await env.KV.get<{ date: string; offset: number }>(offKey, "json").catch(() => null)) ?? {
    date: today,
    offset: 0,
  };
  let offset = prog.date === today ? prog.offset : 0;
  if (offset >= list.length) return []; // 本日榜单已铺完

  const batch = list.slice(offset, offset + Math.max(1, chunk));
  offset += batch.length;
  await env.KV.put(offKey, JSON.stringify({ date: today, offset }), { expirationTtl: 2 * 86400 });
  return batch;
}

/** 大类榜单：聚合所有启用的 pixiv 源（各自遵守自己的 全部/部分 设置）。 */
export async function fetchRankingIllusts(env: Env, count: number): Promise<Illust[]> {
  const cfg = await getConfig(env);
  const pixivSources = cfg.sources.filter((s) => s.enabled && s.adapter === "pixiv");
  const pool: Illust[] = [];
  for (const s of pixivSources) {
    try {
      pool.push(...(await fetchFromSource(env, s, count, "")));
    } catch {
      // 换下一个 pixiv 源
    }
    if (pool.length >= count) break;
  }
  return pool.slice(0, Math.max(1, count));
}

/** 按解析出的动作抓图（source/ranking/random）；menu 不在此处理。 */
export async function fetchForAction(env: Env, action: Action, count: number): Promise<Illust[]> {
  if (action.kind === "source") return fetchFromSource(env, action.source, count, action.tags);
  if (action.kind === "ranking") return fetchRankingIllusts(env, count);
  if (action.kind === "random") return fetchRandomIllusts(env, action.tags, count);
  return [];
}

/** 生成菜单文本：当前可用关键词（源级 + 大类）与命令。 */
export async function buildMenu(env: Env): Promise<string> {
  const od = await getOnDemandConfig(env);
  const cfg = await getConfig(env);
  const lines: string[] = ["🎯 可用关键词"];
  for (const s of cfg.sources) {
    if (s.enabled && s.trigger && s.trigger.trim()) lines.push(`· ${s.trigger.trim()} → ${s.label}`);
  }
  if (od.rankingTriggers.length) lines.push(`· ${od.rankingTriggers.join(" / ")} → Pixiv 榜单`);
  if (od.triggers.length) lines.push(`· ${od.triggers.join(" / ")} → 随机图`);
  lines.push("", "💬 命令", "· /start 订阅 · /stop 退订 · /status 状态");
  return lines.join("\n");
}
