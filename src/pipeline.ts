// 核心编排：拉取 → 过滤(全年龄，trusted 源跳过) → KV 去重 → 多渠道推送 → 记录到 D1。
// scheduled 与手动 /api/run 共用。
import type { AppConfig, ChannelAdapter, Env, Illust, PushOptions, RunSummary } from "./types";
import { getConfig } from "./config";
import { getSourceAdapter } from "./sources";
import { isAllAges } from "./filter";
import { isSeen, markSeen } from "./store";
import { recordPush, recordRun, listSubscriberChatIds } from "./db";
import { telegram } from "./channels/telegram";
import { napcat } from "./channels/napcat";
import { qqbot } from "./channels/qqbot";
import { fetchRandomIllusts } from "./ondemand";
import { diag } from "./diag";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface ChannelSpec {
  adapter: ChannelAdapter;
  targets: string[];
  opts: PushOptions;
}

/** 组装启用且有目标的渠道（固定配置 ∪ 自助订阅者）。 */
export async function assembleChannels(env: Env, cfg: AppConfig): Promise<ChannelSpec[]> {
  const channels: ChannelSpec[] = [];
  if (cfg.telegram.enabled) {
    const subs = await listSubscriberChatIds(env, "telegram");
    const tgTargets = [...new Set([...cfg.telegram.chatIds, ...subs])];
    if (tgTargets.length > 0) channels.push({ adapter: telegram, targets: tgTargets, opts: { apiBase: cfg.telegram.apiBase } });
  }
  if (cfg.napcat.enabled && cfg.napcat.groupIds.length > 0) {
    channels.push({ adapter: napcat, targets: cfg.napcat.groupIds, opts: {} });
  }
  if (cfg.qqbot.enabled) {
    const subs = await listSubscriberChatIds(env, "qqbot");
    const qqTargets = [...new Set([...cfg.qqbot.targets, ...subs])];
    if (qqTargets.length > 0) channels.push({ adapter: qqbot, targets: qqTargets, opts: {} });
  }
  return channels;
}

/** 把一张图推到所有渠道的所有目标，返回成功的渠道名；错误写入 errors。 */
async function pushIllustToChannels(env: Env, it: Illust, channels: ChannelSpec[], errors: string[]): Promise<string[]> {
  const okChannels: string[] = [];
  for (const ch of channels) {
    for (const target of ch.targets) {
      try {
        await ch.adapter.push(env, it, target, ch.opts);
        if (!okChannels.includes(ch.adapter.name)) okChannels.push(ch.adapter.name);
      } catch (e) {
        errors.push(`[${ch.adapter.name}->${target}] ${it.source}:${it.id} ${errMsg(e)}`);
      }
    }
  }
  return okChannels;
}

export async function runOnce(env: Env): Promise<RunSummary> {
  const cfg = await getConfig(env);
  const summary: RunSummary = {
    startedAt: Date.now(),
    finishedAt: 0,
    fetched: 0,
    filtered: 0,
    pushed: 0,
    errors: [],
    perSource: {},
  };

  // 1) 拉取各启用数据源；trusted 源（如 RSS 订阅）跳过全年龄过滤
  const candidatesAll: Illust[] = [];
  for (const s of cfg.sources.filter((x) => x.enabled)) {
    const adapter = getSourceAdapter(s.adapter);
    if (!adapter) {
      summary.errors.push(`未知数据源适配器: ${s.adapter}`);
      continue;
    }
    try {
      const items = await adapter.fetchRanking(env, { limit: s.limit, tags: s.tags, mode: s.mode, site: s.site, label: s.label });
      summary.fetched += items.length;
      for (const it of items) {
        if (!s.trusted && !isAllAges(it)) continue;
        candidatesAll.push(it);
      }
    } catch (e) {
      summary.errors.push(`[${s.label}] 拉取失败: ${errMsg(e)}`);
    }
  }

  // 2) KV 去重
  const candidates: Illust[] = [];
  for (const it of candidatesAll) {
    if (await isSeen(env, it.source, it.id)) continue;
    candidates.push(it);
  }
  summary.filtered = candidates.length;
  const picked = candidates.slice(0, cfg.perRunTotalCap);

  // 3) 组装渠道
  const channels = await assembleChannels(env, cfg);
  if (channels.length === 0) {
    summary.errors.push("没有可用的推送目标（检查渠道开关、token 与目标 id）");
  }
  summary.notes = channels.map((c) => `${c.adapter.name} 目标(${c.targets.length}): ${c.targets.join(", ")}`);

  // 4) 逐图推送，成功任一渠道即标记已推送并写记录
  for (const it of picked) {
    const okChannels = await pushIllustToChannels(env, it, channels, summary.errors);
    if (okChannels.length > 0) {
      await markSeen(env, it.source, it.id, cfg.seenTtlDays);
      summary.pushed++;
      summary.perSource[it.source] = (summary.perSource[it.source] ?? 0) + 1;
      await recordPush(env, {
        source: it.source,
        id: it.id,
        title: it.title,
        author: it.author,
        imageUrl: it.imageUrl,
        pageUrl: it.pageUrl,
        pushedAt: Date.now(),
        channels: okChannels,
      });
    }
  }

  summary.finishedAt = Date.now();
  await recordRun(env, summary);
  await diag(
    env,
    "push",
    `定时/手动抓取 拉取 ${summary.fetched} 推送 ${summary.pushed}｜${(summary.notes ?? []).join(" / ") || "无可用目标"}` +
      (summary.errors.length ? `｜错误: ${summary.errors.slice(0, 4).join(" ‖ ")}` : ""),
  );
  return summary;
}

/**
 * 手动随机推送：随机取 count 张全年龄图，推到所有启用渠道。
 * 不做去重（强制推），每次内容基本不同；仍写入推送记录供网页展示。
 */
export async function pushRandomBatch(env: Env, count: number): Promise<RunSummary> {
  const cfg = await getConfig(env);
  const summary: RunSummary = {
    startedAt: Date.now(),
    finishedAt: 0,
    fetched: 0,
    filtered: 0,
    pushed: 0,
    errors: [],
    perSource: {},
  };

  const illusts = await fetchRandomIllusts(env, "", count);
  summary.fetched = illusts.length;
  summary.filtered = illusts.length;
  if (illusts.length === 0) summary.errors.push("没有取到可用的随机图片（检查 booru 数据源）");

  const channels = await assembleChannels(env, cfg);
  if (channels.length === 0) summary.errors.push("没有可用的推送目标（检查渠道开关、token 与目标 id）");
  // 诊断：把本次真正尝试的目标写出来，便于判断"群里收不到"是发送失败还是根本没在目标里
  summary.notes = channels.map((c) => `${c.adapter.name} 目标(${c.targets.length}): ${c.targets.join(", ")}`);

  for (const it of illusts) {
    const okChannels = await pushIllustToChannels(env, it, channels, summary.errors);
    if (okChannels.length > 0) {
      summary.pushed++;
      summary.perSource[it.source] = (summary.perSource[it.source] ?? 0) + 1;
      await recordPush(env, {
        source: it.source,
        id: it.id,
        title: it.title,
        author: it.author,
        imageUrl: it.imageUrl,
        pageUrl: it.pageUrl,
        pushedAt: Date.now(),
        channels: okChannels,
      });
    }
  }

  summary.finishedAt = Date.now();
  await recordRun(env, summary);
  await diag(
    env,
    "push",
    `手动随机推送 取图 ${summary.fetched} 成功 ${summary.pushed}｜${(summary.notes ?? []).join(" / ") || "无可用目标"}` +
      (summary.errors.length ? `｜错误: ${summary.errors.slice(0, 4).join(" ‖ ")}` : ""),
  );
  return summary;
}
