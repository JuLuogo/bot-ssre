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
import { qqbot, isActiveMsgDenied } from "./channels/qqbot";
import { fetchRandomIllusts } from "./ondemand";
import { diag } from "./diag";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Workers 单次调用子请求超限（免费版 50/次）。命中后应停止本次剩余发送，而不是继续刷同样的错。 */
class SubrequestLimit extends Error {}
const isSubrequestLimit = (m: string) => /too many subrequests/i.test(m);
const SUBREQUEST_HINT = (sent: number) =>
  `已达单次子请求上限（免费版 50 次/调用）：QQ 每张图需 2 次请求（上传+发送），本次发出约 ${sent} 张后停止。` +
  `请把「张数」调小到 10 张左右；要一次推更多需升级 Workers 付费版（1000 次/调用）。`;

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
    let qqTargets = [...new Set([...cfg.qqbot.targets, ...subs])];
    // QQ 官方主动消息需单独申请权限（无权限时报 40034105）。关掉「群主动推送」后，
    // 群只保留关键词触发（被动回复），不再对群发起注定失败的主动消息。
    if (cfg.qqbot.groupActivePush === false) {
      qqTargets = qqTargets.filter((t) => !t.startsWith("group:"));
    }
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
        const m = errMsg(e);
        errors.push(`[${ch.adapter.name}->${target}] ${it.source}:${it.id} ${m}`);
        // 子请求超限：本次调用的额度已耗尽，继续发只会全是同样的错，直接中止本轮
        if (isSubrequestLimit(m)) throw new SubrequestLimit();
      }
    }
  }
  return okChannels;
}

/** 诊断说明：本次实际尝试的目标 + 针对已知失败的可操作提示。 */
function buildNotes(cfg: AppConfig, channels: ChannelSpec[], errors: string[]): string[] {
  const notes = channels.map((c) => `${c.adapter.name} 目标(${c.targets.length}): ${c.targets.join(", ")}`);
  if (cfg.qqbot.enabled && cfg.qqbot.groupActivePush === false) {
    notes.push("QQ群主动推送已关闭：群里只响应关键词触发（被动回复），定时/手动推送不发群。");
  }
  if (errors.some(isActiveMsgDenied)) {
    notes.push(
      "QQ 返回「主动消息无权限(40034105)」：需在 QQ 开放平台为该机器人申请主动消息权限；" +
        "若暂时开不了，可在下方渠道配置里关掉「向 QQ 群主动推送」，群里改用关键词触发。",
    );
  }
  return notes;
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
  // randompic / randomapi 是「随机图源」，不是榜单源：它们只服务提示词返图和「推送随机新图」。
  // 定时抓取不带它们，否则每次运行会对十几个第三方 API 各发一次请求（子请求上限风险），
  // 且随机图 id 每次都不同，会把去重库和每日榜单推送冲淡。
  const rankingSources = cfg.sources.filter(
    (x) => x.enabled && x.adapter !== "randompic" && x.adapter !== "randomapi",
  );
  const candidatesAll: Illust[] = [];
  for (const s of rankingSources) {
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
  try {
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
  } catch (e) {
    if (!(e instanceof SubrequestLimit)) throw e;
    summary.errors.push(SUBREQUEST_HINT(summary.pushed));
  }

  summary.notes = buildNotes(cfg, channels, summary.errors);
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

  try {
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
  } catch (e) {
    if (!(e instanceof SubrequestLimit)) throw e;
    summary.errors.push(SUBREQUEST_HINT(summary.pushed));
  }

  summary.notes = buildNotes(cfg, channels, summary.errors);
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
