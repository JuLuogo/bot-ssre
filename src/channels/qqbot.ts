// QQ 官方机器人（QQ 开放平台 API v2）推送渠道：
// access_token（KV 缓存）→ 富媒体 URL 上传取 file_info → msg_type=7 发图。
import type { ChannelAdapter, Env, Illust } from "../types";

const API = "https://api.bot.qq.com";
const TOKEN_KEY = "qqbot:token";
// 被动回复窗口：官方 msg_id 有效期 5 分钟，留 30s 余量
const PASSIVE_TTL = 270;
const passiveKey = (target: string) => `qqbot:lastmsg:${target}`;

interface TokenCache {
  token: string;
  exp: number;
}

/** 获取并缓存 access_token（官方有效期 7200s，这里提前 60s 刷新） */
export async function getAccessToken(env: Env): Promise<string> {
  const appId = env.QQ_BOT_APPID;
  const secret = env.QQ_BOT_SECRET;
  if (!appId || !secret) throw new Error("QQ_BOT_APPID / QQ_BOT_SECRET 未配置");

  const cached = await env.KV.get<TokenCache>(TOKEN_KEY, "json");
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const res = await fetch(`${API}/app/getAppAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`getAppAccessToken HTTP ${res.status}: ${txt}`);
  const j = JSON.parse(txt) as { access_token?: string; expires_in?: string | number };
  if (!j.access_token) throw new Error(`getAppAccessToken 无 access_token: ${txt}`);

  const ttl = Number(j.expires_in) || 7200;
  await env.KV.put(TOKEN_KEY, JSON.stringify({ token: j.access_token, exp: Date.now() + ttl * 1000 }), {
    expirationTtl: Math.max(60, ttl),
  });
  return j.access_token;
}

/** target 形如 group:<group_openid> / user:<user_openid>（裸值按群处理） */
export function parseTarget(target: string): { scope: "groups" | "users"; openid: string } {
  if (target.startsWith("group:")) return { scope: "groups", openid: target.slice(6) };
  if (target.startsWith("user:")) return { scope: "users", openid: target.slice(5) };
  return { scope: "groups", openid: target };
}

const authHeaders = (token: string) => ({
  Authorization: `QQBot ${token}`,
  "Content-Type": "application/json; charset=utf-8",
});

/**
 * 记住某个会话最近一条用户消息的 msg_id。
 * QQ 官方「主动消息」对群/单聊有报备与频次限制，而带 msg_id 的被动回复不受该限制；
 * 后台手动推送/定时推送时若窗口内（5 分钟）有可用 msg_id，就优先按被动回复发出。
 */
export async function rememberPassiveMsgId(env: Env, target: string, msgId: string): Promise<void> {
  try {
    await env.KV.put(passiveKey(target), msgId, { expirationTtl: PASSIVE_TTL });
  } catch {
    // 记不住就退化为主动消息，不影响主流程
  }
}

async function getPassiveMsgId(env: Env, target: string): Promise<string | undefined> {
  try {
    return (await env.KV.get(passiveKey(target))) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 给 QQ 返回体补一句中文提示，便于后台「运行历史」直接看懂失败原因。
 * 优先用实测确认过的 code，其余按返回 message 关键字兜底（官方码表随版本变动，不整表硬编码）。
 */
export function explainQQError(txt: string): string {
  // 实测确认：群/单聊主动消息未获权限时返回该码
  if (/40034105/.test(txt)) {
    return `主动消息无权限（40034105）：该机器人未获得主动推送权限，只能在收到用户消息后 5 分钟内被动回复。` +
      `解决：① QQ 开放平台开通/申请主动消息权限；② 或让群内先有人发言，走被动回复窗口｜原始: ${txt}`;
  }
  const lower = txt.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/无权限|not allow|permission|denied|forbidden/, "权限不足：确认机器人在该会话有对应消息权限（主动消息需单独申请）"],
    [/审核|waiting for audit|audit/, "主动消息待审核/未报备"],
    [/频率|频次|超限|freq|frequency|limit|exceed|quota/, "触发频次/额度限制：主动消息按额度计费，被动回复不占额度"],
    [/重复|duplicate|repeat/, "被判定为重复消息：同一 msg_id 多次回复需要不同的 msg_seq"],
    [/下载|download|media|file/, "富媒体处理失败：QQ 服务器可能无法下载该图片（域名不可达 / 非直链 / 格式不支持）"],
    [/token|鉴权|auth/, "鉴权失败：检查 QQ_BOT_APPID / QQ_BOT_SECRET"],
  ];
  for (const [re, hint] of rules) {
    if (re.test(lower) || re.test(txt)) return `${hint}｜原始: ${txt}`;
  }
  return txt;
}

/** 是否属于「主动消息不被允许」——用于在推送结果里给出可操作提示。 */
export function isActiveMsgDenied(msg: string): boolean {
  return /40034105/.test(msg) || /主动消息.*(无权限|失败)/.test(msg);
}

/** 富媒体 URL 上传，换取 file_info（file_type=1 为图片） */
async function uploadMedia(token: string, scope: string, openid: string, url: string): Promise<string> {
  // 预热：QQ 服务器拉图有下载超时，若图片 URL 是跨境冷回源(如 Cloudflare 反代 → pixiv，
  // 实测冷启动可达 10s+)，QQ 会超时报 40093007「富媒体文件下载失败」。
  // 先让 Worker 自己拉一次，把回源结果灌进 CDN 缓存，QQ 随后再拉就命中缓存(快)。best-effort。
  await warmImageUrl(url);
  const res = await fetch(`${API}/v2/${scope}/${openid}/files`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ file_type: 1, url, srv_send_msg: false }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`富媒体上传失败 HTTP ${res.status}: ${explainQQError(txt)}`);
  const j = JSON.parse(txt) as { file_info?: string };
  if (!j.file_info) throw new Error(`富媒体上传未返回 file_info: ${txt}`);
  return j.file_info;
}

/**
 * 预热图片 URL：把它拉一遍并读完，促使 CDN 完成回源并缓存，
 * 使 QQ 后续下载命中缓存、避免冷回源超时。
 * 跳过 direct 随机源(带 _cb= 一次性参数，内容不稳定、预热无意义)。best-effort，失败不阻断。
 */
async function warmImageUrl(url: string): Promise<void> {
  if (url.includes("_cb=")) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.ok) await res.arrayBuffer();
  } catch {
    // 预热失败就算了，QQ 仍会尝试直接拉
  }
}

/**
 * 发文本消息。带 msgId 为被动回复（不占主动消息频次）。
 * best-effort：回复失败只记日志，不抛出——避免 webhook 因回复失败返回 5xx 触发平台重推。
 */
export async function sendText(env: Env, target: string, content: string, msgId?: string, msgSeq?: number): Promise<void> {
  try {
    const token = await getAccessToken(env);
    const { scope, openid } = parseTarget(target);
    const body: Record<string, unknown> = { msg_type: 0, content };
    if (msgId) {
      body.msg_id = msgId;
      body.msg_seq = msgSeq ?? 1;
    }
    const res = await fetch(`${API}/v2/${scope}/${openid}/messages`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[qqbot] sendText 失败 HTTP ${res.status}: ${explainQQError(await res.text())}`);
  } catch (e) {
    console.warn(`[qqbot] sendText 异常: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function caption(i: Illust): string {
  return [
    i.title,
    i.author ? `作者: ${i.author}` : "",
    `来源: ${i.source}${i.rank ? ` · No.${i.rank}` : ""}`,
    i.pageUrl,
  ]
    .filter(Boolean)
    .join("\n");
}

export const qqbot: ChannelAdapter = {
  name: "qqbot",
  async push(env: Env, illust: Illust, target: string): Promise<void> {
    // 优先蹭 5 分钟内的被动回复窗口（不占主动消息额度，也不需要主动消息权限）
    const passive = await getPassiveMsgId(env, target);
    if (passive) {
      try {
        // 同一 msg_id 多次回复必须给不同 msg_seq，否则被 QQ 去重
        await sendImage(env, target, illust, passive, 1 + Math.floor(Math.random() * 100000));
        return;
      } catch {
        // 窗口可能已过期或回复次数用尽，继续尝试主动消息
      }
    }
    await sendImage(env, target, illust);
  },
};

/**
 * 发图；带 msgId 为被动回复（不占主动消息频次），用于提示词触发返图。
 * msgSeq：同一 msg_id 回复多条时必须递增/不同，否则 QQ 侧按重复消息丢弃。
 */
export async function sendImage(
  env: Env,
  target: string,
  illust: Illust,
  msgId?: string,
  msgSeq?: number,
): Promise<void> {
  if (!illust.imageUrl) throw new Error("imageUrl 为空");
  const token = await getAccessToken(env);
  const { scope, openid } = parseTarget(target);
  const fileInfo = await uploadMedia(token, scope, openid, illust.imageUrl);

  const send = async (withContent: boolean): Promise<{ ok: boolean; txt: string }> => {
    const body: Record<string, unknown> = { msg_type: 7, media: { file_info: fileInfo } };
    if (withContent) body.content = caption(illust);
    if (msgId) {
      body.msg_id = msgId;
      body.msg_seq = msgSeq ?? 1;
    }
    const res = await fetch(`${API}/v2/${scope}/${openid}/messages`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    return { ok: res.ok, txt: await res.text() };
  };

  // 优先图 + 文案；若接口不接受 content 则回退为仅图片
  const first = await send(true);
  if (first.ok) return;
  const retry = await send(false);
  if (!retry.ok) {
    throw new Error(`QQ 官方发送失败: ${explainQQError(first.txt)} ｜ 仅图片重试: ${explainQQError(retry.txt)}`);
  }
}
