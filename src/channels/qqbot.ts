// QQ 官方机器人（QQ 开放平台 API v2）推送渠道：
// access_token（KV 缓存）→ 富媒体 URL 上传取 file_info → msg_type=7 发图。
import type { ChannelAdapter, Env, Illust } from "../types";

const API = "https://api.bot.qq.com";
const TOKEN_KEY = "qqbot:token";

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

/** 富媒体 URL 上传，换取 file_info（file_type=1 为图片） */
async function uploadMedia(token: string, scope: string, openid: string, url: string): Promise<string> {
  const res = await fetch(`${API}/v2/${scope}/${openid}/files`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ file_type: 1, url, srv_send_msg: false }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`富媒体上传失败 HTTP ${res.status}: ${txt}`);
  const j = JSON.parse(txt) as { file_info?: string };
  if (!j.file_info) throw new Error(`富媒体上传未返回 file_info: ${txt}`);
  return j.file_info;
}

/**
 * 发文本消息。带 msgId 为被动回复（不占主动消息频次）。
 * best-effort：回复失败只记日志，不抛出——避免 webhook 因回复失败返回 5xx 触发平台重推。
 */
export async function sendText(env: Env, target: string, content: string, msgId?: string): Promise<void> {
  try {
    const token = await getAccessToken(env);
    const { scope, openid } = parseTarget(target);
    const body: Record<string, unknown> = { msg_type: 0, content };
    if (msgId) body.msg_id = msgId;
    const res = await fetch(`${API}/v2/${scope}/${openid}/messages`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[qqbot] sendText 失败 HTTP ${res.status}: ${await res.text()}`);
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
    if (!illust.imageUrl) throw new Error("imageUrl 为空");
    const token = await getAccessToken(env);
    const { scope, openid } = parseTarget(target);
    const fileInfo = await uploadMedia(token, scope, openid, illust.imageUrl);

    const send = async (withContent: boolean): Promise<{ ok: boolean; txt: string }> => {
      const body: Record<string, unknown> = { msg_type: 7, media: { file_info: fileInfo } };
      if (withContent) body.content = caption(illust);
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
    if (!retry.ok) throw new Error(`QQ 官方发送失败: ${first.txt} ｜ 仅图片重试: ${retry.txt}`);
  },
};
