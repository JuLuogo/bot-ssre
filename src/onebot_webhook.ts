// OneBot（NapCat）HTTP 上报入口：实现"发命令/关键词→实时返图"，非命中给菜单。
import type { Env } from "./types";
import { resolveEnv } from "./creds";
import { getOnDemandConfig, resolveAction, fetchForAction, buildMenu, type Action } from "./ondemand";
import { sendGroupImage, sendPrivateImage, sendGroupText, sendPrivateText } from "./channels/napcat";

const okJson = (): Response => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

interface OneBotSeg {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
}
interface OneBotEvent {
  post_type?: string; // message / meta_event / notice / request
  message_type?: string; // group / private
  self_id?: number | string;
  group_id?: number | string;
  user_id?: number | string;
  raw_message?: string;
  message?: string | OneBotSeg[];
}

/** 从数组/字符串两种消息形态里取纯文本，并判断是否 @ 了机器人自己。 */
function parseMessage(ev: OneBotEvent): { text: string; atSelf: boolean } {
  const selfId = String(ev.self_id ?? "");
  let text = "";
  let atSelf = false;

  const msg = ev.message;
  if (Array.isArray(msg)) {
    for (const seg of msg) {
      if (seg.type === "text") text += String(seg.data?.text ?? "");
      else if (seg.type === "at") {
        const qq = String(seg.data?.qq ?? "");
        if (qq === selfId || qq === "all") atSelf = true;
      }
    }
  } else if (typeof msg === "string") {
    text = msg;
  } else if (typeof ev.raw_message === "string") {
    text = ev.raw_message;
  }

  // raw_message（CQ 码串）情形补测 @self
  const raw = ev.raw_message ?? (typeof msg === "string" ? msg : "");
  if (!atSelf && selfId && raw.includes(`[CQ:at,qq=${selfId}]`)) atSelf = true;

  // 去掉所有 CQ 码，得到纯文本
  text = text.replace(/\[CQ:[^\]]*\]/g, " ");
  return { text: text.trim(), atSelf };
}

/** 命中触发词时返回其后的关键词作为 tag（逻辑见 ondemand.matchTrigger）。 */
async function verifySignature(secret: string, sigHeader: string, raw: string): Promise<boolean> {
  const expected = sigHeader.replace(/^sha1=/i, "").toLowerCase();
  if (!expected) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === expected;
}

export async function handleOneBotWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  let ev: OneBotEvent;
  try {
    ev = JSON.parse(raw) as OneBotEvent;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // 1) 只处理消息事件；心跳/通知/请求/元事件直接放行（零 D1/子请求）
  if (ev.post_type !== "message") return okJson();

  const od = await getOnDemandConfig(env);
  if (!od.enabled) return okJson();

  const isGroup = ev.message_type === "group";
  const isPrivate = ev.message_type === "private";
  if (!isGroup && !isPrivate) return okJson();
  if (isPrivate && !od.allowPrivate) return okJson();

  // 2) 群聊需 @机器人；未 @ 的群消息忽略（隐私）。私聊/群@ 都会继续（命中触发→发图，否则发菜单）
  const { text, atSelf } = parseMessage(ev);
  if (isGroup && od.requireAtInGroup && !atSelf) return okJson();

  // 3) 合并 D1 凭证，若配置了 secret 则验签
  const renv = await resolveEnv(env);
  const secret = renv.NAPCAT_WEBHOOK_SECRET;
  if (secret) {
    const sig = request.headers.get("X-Signature") || "";
    if (!(await verifySignature(secret, sig, raw))) return new Response("invalid signature", { status: 401 });
  }

  const groupId = String(ev.group_id ?? "");
  const userId = String(ev.user_id ?? "");
  const action = await resolveAction(renv, text);
  // 抓图+发图可能数秒，NapCat 侧超时会重推同一事件；立刻回 200，重活交给 waitUntil。
  ctx.waitUntil(replyAction(renv, isGroup, groupId, userId, action, od.count));
  return okJson();
}

/** 后台完成「抓图 → 发图」或「发菜单」，异常只记日志（上报已回 200）。 */
async function replyAction(
  env: Env,
  isGroup: boolean,
  groupId: string,
  userId: string,
  action: Action,
  count: number,
): Promise<void> {
  const sendText = (t: string) => (isGroup ? sendGroupText(env, groupId, t) : sendPrivateText(env, userId, t));
  try {
    if (action.kind === "menu") {
      await sendText(await buildMenu(env));
      return;
    }
    const illusts = await fetchForAction(env, action, count);
    if (illusts.length === 0) {
      const tip =
        action.kind === "ranking"
          ? "榜单已推完或暂时取不到，明天再来～"
          : action.kind === "source"
            ? `「${action.source.label}」暂时没取到图捏`
            : action.tags
              ? `没找到「${action.tags}」相关的图捏`
              : "没找到图捏，稍后再试";
      await sendText(tip);
      return;
    }
    for (const illust of illusts) {
      try {
        if (isGroup) await sendGroupImage(env, groupId, illust);
        else await sendPrivateImage(env, userId, illust);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.log("[onebot] 发图失败:", m);
        if (/too many subrequests/i.test(m)) break;
      }
    }
  } catch (e) {
    console.log("[onebot] error:", e instanceof Error ? e.message : String(e));
  }
}
