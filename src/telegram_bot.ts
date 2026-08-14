// Telegram webhook：处理用户命令 /start(订阅) /stop(退订) /status。
import type { Env } from "./types";
import { getConfig } from "./config";
import { subscribe, unsubscribe } from "./db";
import { getOnDemandConfig, fetchRandomIllusts, matchTrigger } from "./ondemand";
import { telegram } from "./channels/telegram";

const DEFAULT_API = "https://api.telegram.org";

interface TgChat { id: number | string; type?: string; title?: string; first_name?: string; last_name?: string; username?: string }
interface TgMessage { chat?: TgChat; text?: string }
interface TgUpdate { message?: TgMessage; channel_post?: TgMessage }

async function sendMessage(env: Env, apiBase: string, chatId: string, text: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return;
  await fetch(`${apiBase.replace(/\/$/, "")}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // 校验 setWebhook 时设置的 secret_token
  if (env.TG_WEBHOOK_SECRET) {
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }
  const update = (await request.json().catch(() => null)) as TgUpdate | null;
  const msg = update?.message || update?.channel_post;
  if (!msg || !msg.chat) return new Response("ok");

  const chat = msg.chat;
  const chatId = String(chat.id);
  const title =
    chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || chatId;
  const cmd = (msg.text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  const cfg = await getConfig(env);
  const apiBase = cfg.telegram.apiBase || DEFAULT_API;

  // 提示词触发返图（与其他平台共用 ondemand 配置）
  const od = await getOnDemandConfig(env);
  if (od.enabled) {
    const trimmed = (msg.text || "").trim();
    const { hit, tags } = matchTrigger(trimmed, od.triggers);
    const isGroup = (chat.type || "").includes("group");
    // 群里靠 Telegram 隐私模式过滤（只有 @机器人/命令/回复才会收到）；私聊需 allowPrivate
    if (hit && (isGroup || od.allowPrivate)) {
      const illusts = await fetchRandomIllusts(env, tags, od.count);
      if (illusts.length === 0) {
        await sendMessage(env, apiBase, chatId, tags ? `没找到「${tags}」相关的图` : "没找到图，稍后再试");
      } else {
        for (const il of illusts) {
          try {
            await telegram.push(env, il, chatId, { apiBase });
          } catch (e) {
            console.warn("[tg] 发图失败:", e instanceof Error ? e.message : String(e));
          }
        }
      }
      return new Response("ok");
    }
  }

  if (cmd === "/start" || cmd === "/subscribe") {
    await subscribe(env, "telegram", chatId, title);
    await sendMessage(env, apiBase, chatId, "✅ 已订阅插画推送。发送 /stop 可随时退订。");
  } else if (cmd === "/stop" || cmd === "/unsubscribe") {
    await unsubscribe(env, "telegram", chatId);
    await sendMessage(env, apiBase, chatId, "已退订。发送 /start 可重新订阅。");
  } else if (cmd === "/status") {
    await sendMessage(env, apiBase, chatId, "机器人在线。命令：/start 订阅 · /stop 退订 · /status 状态。");
  } else {
    await sendMessage(env, apiBase, chatId, "可用命令：/start 订阅 · /stop 退订 · /status 状态。");
  }
  return new Response("ok");
}
