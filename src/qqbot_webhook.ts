// QQ 官方机器人 webhook：op=13 回调地址验证、事件验签、订阅命令处理。
import type { Env } from "./types";
import { subscribe, unsubscribe } from "./db";
import { sendText, sendImage, rememberPassiveMsgId } from "./channels/qqbot";
import { signQQValidation, verifyQQSignature } from "./qqsign";
import { resolveEnv } from "./creds";
import { getOnDemandConfig, fetchRandomIllusts, matchTrigger } from "./ondemand";
import { diag } from "./diag";

interface QQPayload {
  op?: number;
  t?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d?: Record<string, any>;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 后台完成「抓图 → 发送」。
 * 关键：任何一步失败都要**告诉用户**并写诊断日志——以前失败只 console.warn，
 * 用户侧完全静默，看起来就像"发了触发词没反应"。
 */
async function replyIllusts(
  env: Env,
  target: string,
  tags: string,
  count: number,
  msgId?: string,
): Promise<void> {
  const t0 = Date.now();
  try {
    const illusts = await fetchRandomIllusts(env, tags, count);
    if (illusts.length === 0) {
      await diag(env, "qqbot", `取图 0 张（tags="${tags}"）→ 回文本提示`);
      await sendText(env, target, tags ? `没找到「${tags}」相关的图捏` : "没找到图捏，稍后再试", msgId);
      return;
    }
    await diag(
      env,
      "qqbot",
      `取图 ${illusts.length} 张，来源=${[...new Set(illusts.map((i) => i.source))].join(",")}，` +
        `首张=${illusts[0].imageUrl.slice(0, 80)}`,
    );

    // 同一 msg_id 回复多条必须给不同 msg_seq，否则第 2 张之后会被 QQ 当重复消息丢掉
    let seq = 1;
    let ok = 0;
    const fails: string[] = [];
    for (const il of illusts) {
      try {
        await sendImage(env, target, il, msgId, seq++);
        ok++;
      } catch (e) {
        const m = err(e);
        fails.push(m);
        // 子请求超限：本次调用额度已耗尽，继续发只会同样失败，停止
        if (/too many subrequests/i.test(m)) break;
      }
    }
    await diag(env, "qqbot", `发送结果 成功 ${ok}/${illusts.length}，耗时 ${Date.now() - t0}ms` + (fails.length ? `｜失败: ${fails.join(" ‖ ")}` : ""));
    // 一张都没发出去：明确回一句，别让用户以为机器人没收到
    if (ok === 0) {
      await sendText(env, target, `图发不出去捏：${(fails[0] ?? "未知原因").slice(0, 120)}`, msgId, seq++);
    }
  } catch (e) {
    await diag(env, "qqbot", `按需返图异常（${Date.now() - t0}ms）: ${err(e)}`);
    await sendText(env, target, `出错了捏：${err(e).slice(0, 120)}`, msgId);
  }
}

export async function handleQQBotWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  let payload: QQPayload;
  try {
    payload = JSON.parse(raw) as QQPayload;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // op=13：回调地址验证。尽量快地应答——优先用 Worker Secret(env)里的 QQ_BOT_SECRET，
  // 避免跨区域 D1 读取，把响应时间压到最低；在跨境弱网下让响应尽量先于连接被重置返回。
  if (payload.op === 13) {
    const secret = env.QQ_BOT_SECRET || (await resolveEnv(env)).QQ_BOT_SECRET;
    if (!secret) return new Response("QQ_BOT_SECRET 未配置", { status: 503 });
    const d = (payload.d ?? {}) as { plain_token?: string; event_ts?: string };
    if (!d.plain_token || !d.event_ts) return new Response("bad validation payload", { status: 400 });
    return json({ plain_token: d.plain_token, signature: await signQQValidation(secret, d.event_ts, d.plain_token) });
  }

  // 事件推送：合并 D1 凭证（发送/验签需要），再校验 Ed25519 签名
  const renv = await resolveEnv(env);
  const secret = renv.QQ_BOT_SECRET;
  if (!secret) return new Response("QQ_BOT_SECRET 未配置", { status: 503 });
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
    await subscribe(renv, "qqbot", target, title);
    return json({});
  }

  if (t === "C2C_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE" || t === "GROUP_MESSAGE_CREATE") {
    const content = String(d.content ?? "").trim();
    const msgId = typeof d.id === "string" ? d.id : undefined;

    // 记住最近一条消息的 msg_id：后台手动推送/定时推送可在 5 分钟窗口内按被动回复发出，
    // 绕开 QQ 官方对「主动消息」的报备与频次限制。
    if (msgId) ctx.waitUntil(rememberPassiveMsgId(renv, target, msgId));

    // 提示词触发返图（与其他平台共用 ondemand 配置）；群 @ 事件本身即已 @机器人
    const od = await getOnDemandConfig(renv);
    const { hit, tags } = matchTrigger(content, od.triggers);
    // 诊断：把"事件到没到 / 内容是什么 / 配的触发词 / 有没有命中"一次性记下来，
    // 线上排查"发了词没反应"时，看这一条就能区分是事件没到、没命中、还是命中后发送失败。
    ctx.waitUntil(
      diag(
        renv,
        "qqbot",
        `收到 ${t} target=${target.slice(0, 16)}… content=${JSON.stringify(content.slice(0, 40))} ` +
          `msgId=${msgId ? "有" : "无"} od.enabled=${od.enabled} triggers=${JSON.stringify(od.triggers)} ` +
          `hit=${hit}${hit ? ` tags="${tags}" count=${od.count}` : ""}`,
      ),
    );

    if (od.enabled && hit) {
      // 抓图 + 富媒体上传 + 发送耗时可达数秒，QQ 侧会先超时断开连接，
      // 连接一断 Worker 请求上下文即被取消、发送半途中止（这是"发了关键词没反应"的根因）。
      // 因此立刻回 200，把重活交给 waitUntil 在后台完成。
      ctx.waitUntil(replyIllusts(renv, target, tags, od.count, msgId));
      return json({});
    }

    const first = content.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";

    if (first === "/start" || first === "/subscribe" || content === "订阅") {
      await subscribe(renv, "qqbot", target, title);
      await sendText(renv, target, "✅ 已订阅插画推送。发送 /stop 可随时退订。", msgId);
    } else if (first === "/stop" || first === "/unsubscribe" || content === "退订") {
      await unsubscribe(renv, "qqbot", target);
      await sendText(renv, target, "已退订。发送 /start 可重新订阅。", msgId);
    } else if (first === "/status") {
      await sendText(renv, target, "机器人在线。命令：/start 订阅 · /stop 退订 · /status 状态。", msgId);
    } else {
      await sendText(renv, target, "可用命令：/start 订阅 · /stop 退订 · /status 状态。", msgId);
    }
  }
  return json({});
}
