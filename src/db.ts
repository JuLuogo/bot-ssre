// D1 访问层：settings / sources / pushed / runs。全部 prepared statement + bind。
import type { AppConfig, Env, PushRecord, RunSummary, SourceConfig } from "./types";

// ---------- settings（key-value JSON） ----------
async function getSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function putSetting(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

// ---------- sources ----------
interface SourceRow {
  id: number; adapter: string; enabled: number; label: string;
  site: string | null; tags: string | null; mode: string | null;
  limit_n: number; trusted: number; sort_order: number;
}

function rowToSource(r: SourceRow): SourceConfig {
  return {
    id: r.id,
    adapter: r.adapter as SourceConfig["adapter"],
    enabled: !!r.enabled,
    label: r.label,
    site: r.site ?? undefined,
    tags: r.tags ?? undefined,
    mode: r.mode ?? undefined,
    limit: r.limit_n,
    trusted: !!r.trusted,
    sortOrder: r.sort_order,
  };
}

export async function listSources(env: Env): Promise<SourceConfig[]> {
  const { results } = await env.DB.prepare("SELECT * FROM sources ORDER BY sort_order, id").all<SourceRow>();
  return (results ?? []).map(rowToSource);
}

export async function upsertSource(env: Env, s: SourceConfig): Promise<SourceConfig> {
  if (s.id) {
    await env.DB.prepare(
      "UPDATE sources SET adapter=?, enabled=?, label=?, site=?, tags=?, mode=?, limit_n=?, trusted=?, sort_order=? WHERE id=?",
    )
      .bind(s.adapter, s.enabled ? 1 : 0, s.label, s.site ?? null, s.tags ?? null, s.mode ?? null, s.limit, s.trusted ? 1 : 0, s.sortOrder ?? 0, s.id)
      .run();
    return s;
  }
  const res = await env.DB.prepare(
    "INSERT INTO sources(adapter, enabled, label, site, tags, mode, limit_n, trusted, sort_order) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(s.adapter, s.enabled ? 1 : 0, s.label, s.site ?? null, s.tags ?? null, s.mode ?? null, s.limit, s.trusted ? 1 : 0, s.sortOrder ?? 0)
    .run();
  return { ...s, id: Number(res.meta.last_row_id) };
}

export async function deleteSource(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(id).run();
}

// ---------- 组装 / 保存 AppConfig ----------
export async function loadConfig(env: Env): Promise<AppConfig> {
  const [sources, telegram, napcat, qqbot, global] = await Promise.all([
    listSources(env),
    getSetting(env, "telegram", { enabled: true, chatIds: [] as string[], apiBase: "https://api.telegram.org" }),
    getSetting(env, "napcat", { enabled: false, groupIds: [] as string[] }),
    getSetting(env, "qqbot", { enabled: false, targets: [] as string[], groupActivePush: true }),
    getSetting(env, "global", { perRunTotalCap: 10, seenTtlDays: 30 }),
  ]);
  return { sources, telegram, napcat, qqbot, perRunTotalCap: global.perRunTotalCap, seenTtlDays: global.seenTtlDays };
}

export async function saveSettings(env: Env, cfg: AppConfig): Promise<void> {
  await putSetting(env, "telegram", cfg.telegram);
  await putSetting(env, "napcat", cfg.napcat);
  await putSetting(env, "qqbot", cfg.qqbot);
  await putSetting(env, "global", { perRunTotalCap: cfg.perRunTotalCap, seenTtlDays: cfg.seenTtlDays });
}

// ---------- pushed（推送记录 / recent） ----------
export async function recordPush(env: Env, rec: PushRecord): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO pushed(source, post_id, title, author, image_url, page_url, channels, pushed_at) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(rec.source, rec.id, rec.title, rec.author, rec.imageUrl, rec.pageUrl, JSON.stringify(rec.channels), rec.pushedAt)
    .run();
}

interface PushedRow {
  source: string; post_id: string; title: string | null; author: string | null;
  image_url: string | null; page_url: string | null; channels: string | null; pushed_at: number;
}

export async function listRecent(env: Env, limit = 50): Promise<PushRecord[]> {
  const { results } = await env.DB.prepare("SELECT * FROM pushed ORDER BY pushed_at DESC LIMIT ?").bind(limit).all<PushedRow>();
  return (results ?? []).map((r) => ({
    source: r.source,
    id: r.post_id,
    title: r.title ?? "",
    author: r.author ?? "",
    imageUrl: r.image_url ?? "",
    pageUrl: r.page_url ?? "",
    pushedAt: r.pushed_at,
    channels: r.channels ? (JSON.parse(r.channels) as string[]) : [],
  }));
}

// ---------- runs（运行历史） ----------
export async function recordRun(env: Env, s: RunSummary): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO runs(started_at, finished_at, fetched, filtered, pushed, errors) VALUES(?,?,?,?,?,?)",
  )
    .bind(s.startedAt, s.finishedAt, s.fetched, s.filtered, s.pushed, JSON.stringify(s.errors))
    .run();
}

interface RunRow {
  started_at: number; finished_at: number | null;
  fetched: number; filtered: number; pushed: number; errors: string | null;
}

function rowToRun(r: RunRow): RunSummary {
  return {
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? 0,
    fetched: r.fetched,
    filtered: r.filtered,
    pushed: r.pushed,
    errors: r.errors ? (JSON.parse(r.errors) as string[]) : [],
    perSource: {},
  };
}

export async function latestRun(env: Env): Promise<RunSummary | null> {
  const r = await env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").first<RunRow>();
  return r ? rowToRun(r) : null;
}

export async function listRuns(env: Env, limit = 20): Promise<RunSummary[]> {
  const { results } = await env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").bind(limit).all<RunRow>();
  return (results ?? []).map(rowToRun);
}

// ---------- subscribers（自助订阅者） ----------
export interface Subscriber {
  id: number;
  platform: string;
  chatId: string;
  title: string;
  enabled: boolean;
  createdAt: number;
}

interface SubscriberRow {
  id: number; platform: string; chat_id: string; title: string | null; enabled: number; created_at: number;
}

export async function subscribe(env: Env, platform: string, chatId: string, title: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO subscribers(platform, chat_id, title, enabled, created_at) VALUES(?,?,?,1,?) " +
      "ON CONFLICT(platform, chat_id) DO UPDATE SET enabled = 1, title = excluded.title",
  )
    .bind(platform, chatId, title, Date.now())
    .run();
}

export async function unsubscribe(env: Env, platform: string, chatId: string): Promise<void> {
  await env.DB.prepare("UPDATE subscribers SET enabled = 0 WHERE platform = ? AND chat_id = ?").bind(platform, chatId).run();
}

export async function isSubscribed(env: Env, platform: string, chatId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT enabled FROM subscribers WHERE platform = ? AND chat_id = ?")
    .bind(platform, chatId)
    .first<{ enabled: number }>();
  return !!(r && r.enabled);
}

/** platform 传 null 表示不限平台 */
export async function listSubscribers(env: Env, platform: string | null, enabledOnly = true): Promise<Subscriber[]> {
  const conds = [platform ? "platform = ?" : "", enabledOnly ? "enabled = 1" : ""].filter(Boolean);
  const sql = `SELECT * FROM subscribers${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at DESC`;
  const stmt = platform ? env.DB.prepare(sql).bind(platform) : env.DB.prepare(sql);
  const { results } = await stmt.all<SubscriberRow>();
  return (results ?? []).map((r) => ({
    id: r.id,
    platform: r.platform,
    chatId: r.chat_id,
    title: r.title ?? "",
    enabled: !!r.enabled,
    createdAt: r.created_at,
  }));
}

export async function listSubscriberChatIds(env: Env, platform: string): Promise<string[]> {
  return (await listSubscribers(env, platform, true)).map((s) => s.chatId);
}

export async function deleteSubscriber(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(id).run();
}
