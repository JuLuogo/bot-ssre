// QQ 推送渠道：通过用户自建的 NapCat OneBot HTTP 接口转发。
// 定时推送走 push()（群发图）；按需命令回复复用下面导出的 send* 系列。
import type { ChannelAdapter, Env, Illust } from "../types";

function text(i: Illust): string {
  return [
    i.title,
    i.author ? `作者: ${i.author}` : "",
    `来源: ${i.source}${i.rank ? ` · No.${i.rank}` : ""}`,
    i.pageUrl,
  ]
    .filter(Boolean)
    .join("\n");
}

function imageMessage(i: Illust) {
  return [
    { type: "image", data: { file: i.imageUrl } },
    { type: "text", data: { text: `\n${text(i)}` } },
  ];
}

/** 统一调用 OneBot HTTP 动作，处理鉴权、超时与 retcode 校验。 */
async function callOneBot(env: Env, action: string, params: Record<string, unknown>): Promise<void> {
  const base = env.NAPCAT_BASE_URL;
  if (!base) throw new Error("NAPCAT_BASE_URL 未配置");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.NAPCAT_TOKEN) headers["Authorization"] = `Bearer ${env.NAPCAT_TOKEN}`;

  const res = await fetch(`${base.replace(/\/$/, "")}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`NapCat HTTP ${res.status}: ${await res.text()}`);
  const j = (await res.json().catch(() => ({}))) as { retcode?: number; status?: string };
  if (typeof j.retcode === "number" && j.retcode !== 0) {
    throw new Error(`NapCat 返回失败: ${JSON.stringify(j)}`);
  }
}

export const napcat: ChannelAdapter = {
  name: "napcat",
  async push(env: Env, illust: Illust, groupId: string): Promise<void> {
    if (!illust.imageUrl) throw new Error("imageUrl 为空");
    await callOneBot(env, "send_group_msg", { group_id: Number(groupId), message: imageMessage(illust) });
  },
};

export async function sendGroupImage(env: Env, groupId: string, illust: Illust): Promise<void> {
  if (!illust.imageUrl) throw new Error("imageUrl 为空");
  await callOneBot(env, "send_group_msg", { group_id: Number(groupId), message: imageMessage(illust) });
}

export async function sendPrivateImage(env: Env, userId: string, illust: Illust): Promise<void> {
  if (!illust.imageUrl) throw new Error("imageUrl 为空");
  await callOneBot(env, "send_private_msg", { user_id: Number(userId), message: imageMessage(illust) });
}

export async function sendGroupText(env: Env, groupId: string, message: string): Promise<void> {
  await callOneBot(env, "send_group_msg", { group_id: Number(groupId), message });
}

export async function sendPrivateText(env: Env, userId: string, message: string): Promise<void> {
  await callOneBot(env, "send_private_msg", { user_id: Number(userId), message });
}
