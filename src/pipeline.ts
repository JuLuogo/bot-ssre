// 核心编排：拉取 → 过滤(全年龄，trusted 源跳过) → KV 去重 → 多渠道推送 → 记录到 D1。
// scheduled 与手动 /api/run 共用。
import type { ChannelAdapter, Env, Illust, PushOptions, PushRecord, RunSummary } from "./types";
import { getConfig } from "./config";
import { getSourceAdapter } from "./sources";
import { isAllAges } from "./filter";
import { isSeen, markSeen } from "./store";
import { recordPush, recordRun, listSubscriberChatIds } from "./db";
import { telegram } from "./channels/telegram";
import { napcat } from "./channels/napcat";
import { qqbot } from "./channels/qqbot";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  // 3) 组装启用且有目标的渠道（各带 opts）
  const channels: { adapter: ChannelAdapter; targets: string[]; opts: PushOptions }[] = [];
  if (cfg.telegram.enabled) {
    const subs = await listSubscriberChatIds(env, "telegram");
    const tgTargets = [...new Set([...cfg.telegram.chatIds, ...subs])]; // 固定配置 ∪ 自助订阅者
    if (tgTargets.length > 0) {
      channels.push({ adapter: telegram, targets: tgTargets, opts: { apiBase: cfg.telegram.apiBase } });
    }
  }
  if (cfg.napcat.enabled && cfg.napcat.groupIds.length > 0) {
    channels.push({ adapter: napcat, targets: cfg.napcat.groupIds, opts: {} });
  }
  if (cfg.qqbot.enabled) {
    const subs = await listSubscriberChatIds(env, "qqbot");
    const qqTargets = [...new Set([...cfg.qqbot.targets, ...subs])]; // 固定目标 ∪ 自助订阅者
    if (qqTargets.length > 0) {
      channels.push({ adapter: qqbot, targets: qqTargets, opts: {} });
    }
  }
  if (channels.length === 0) {
    summary.errors.push("没有可用的推送目标（检查渠道开关、token 与目标 id）");
  }

  // 4) 逐图推送，成功任一渠道即标记已推送并写记录
  for (const it of picked) {
    const okChannels: string[] = [];
    for (const ch of channels) {
      for (const target of ch.targets) {
        try {
          await ch.adapter.push(env, it, target, ch.opts);
          if (!okChannels.includes(ch.adapter.name)) okChannels.push(ch.adapter.name);
        } catch (e) {
          summary.errors.push(`[${ch.adapter.name}->${target}] ${it.source}:${it.id} ${errMsg(e)}`);
        }
      }
    }
    if (okChannels.length > 0) {
      await markSeen(env, it.source, it.id, cfg.seenTtlDays);
      summary.pushed++;
      summary.perSource[it.source] = (summary.perSource[it.source] ?? 0) + 1;
      const rec: PushRecord = {
        source: it.source,
        id: it.id,
        title: it.title,
        author: it.author,
        imageUrl: it.imageUrl,
        pageUrl: it.pageUrl,
        pushedAt: Date.now(),
        channels: okChannels,
      };
      await recordPush(env, rec);
    }
  }

  summary.finishedAt = Date.now();
  await recordRun(env, summary);
  return summary;
}
