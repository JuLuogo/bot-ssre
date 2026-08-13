// QQ 官方机器人 webhook：op=13 回调地址验证、事件验签、订阅命令处理。
import type { Env } from "./types";
import { subscribe, unsubscribe } from "./db";
import { sendText } from "./channels/qqbot";
import { signQQValidation, verifyQQSignature } from "./qqsign";

interface QQPayload {
  op?: number;
  t?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d?: Record<string, any>;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export async function handleQQBotWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.QQ_BOT_SECRET;
  if (!secret) return new Response("QQ_BOT_SECRET 未配置", { status: 503 });

  const raw = await request.text();
  let payload: QQPayload;
  try {
    payload = JSON.parse(raw) as QQPayload;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // op=13：回调地址验证（用 AppSecret 派生私钥签 event_ts + plain_token）
  if (payload.op === 13) {
    const d = (payload.d ?? {}) as { plain_token?: string; event_ts?: string };
    if (!d.plain_token || !d.event_ts) return new Response("bad validation payload", { status: 400 });
    return json({ plain_token: d.plain_token, signature: await signQQValidation(secret, d.event_ts, d.plain_token) });
  }

  // 事件推送：校验 Ed25519 签名
  const sigHex = request.headers.get("X-Signature-Ed25519") || "";
  const ts = request.headers.get("X-Signature-Timestamp") || "";
  if (!(await verifyQQSignature(secret, sigHex, ts, raw))) {
    return new Response("invalid signature", { status: 401 });
  }

  const t = payload.t || "";
  const d = payload.d ?? {};
  const groupOpenid = typeof d.group_openid === "string" ? d.group_openid : "";
  const userOpenid =
    typeof d.author?.user_openid === "string"
      ? d.author.user_openid
      : typeof d.user_openid === "string"
        ? d.user_openid
        : "";
  const target = groupOpenid ? `group:${groupOpenid}` : userOpenid ? `user:${userOpenid}` : "";
  if (!target) return json({});

  const title = groupOpenid ? `QQ群 ${groupOpenid.slice(0, 8)}…` : `QQ用户 ${userOpenid.slice(0, 8)}…`;

  // 机器人被加入群 / 被添加：自动订阅
  if (t === "GROUP_ADD_ROBOT" || t === "FRIEND_ADD") {
    await subscribe(env, "qqbot", target, title);
    return json({});
  }

  if (t === "C2C_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE" || t === "GROUP_MESSAGE_CREATE") {
    const content = String(d.content ?? "").trim();
    const msgId = typeof d.id === "string" ? d.id : undefined;
    const first = content.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";

    if (first === "/start" || first === "/subscribe" || content === "订阅") {
      await subscribe(env, "qqbot", target, title);
      await sendText(env, target, "✅ 已订阅插画推送。发送 /stop 可随时退订。", msgId);
    } else if (first === "/stop" || first === "/unsubscribe" || content === "退订") {
      await unsubscribe(env, "qqbot", target);
      await sendText(env, target, "已退订。发送 /start 可重新订阅。", msgId);
    } else if (first === "/status") {
      await sendText(env, target, "机器人在线。命令：/start 订阅 · /stop 退订 · /status 状态。", msgId);
    } else {
      await sendText(env, target, "可用命令：/start 订阅 · /stop 退订 · /status 状态。", msgId);
    }
  }
  return json({});
}
