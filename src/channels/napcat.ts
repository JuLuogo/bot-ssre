// QQ 推送渠道（阶段2）：通过用户自建的 NapCat OneBot HTTP 接口转发。
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

export const napcat: ChannelAdapter = {
  name: "napcat",
  async push(env: Env, illust: Illust, groupId: string): Promise<void> {
    const base = env.NAPCAT_BASE_URL;
    if (!base) throw new Error("NAPCAT_BASE_URL 未配置");
    if (!illust.imageUrl) throw new Error("imageUrl 为空");

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (env.NAPCAT_TOKEN) headers["Authorization"] = `Bearer ${env.NAPCAT_TOKEN}`;

    const res = await fetch(`${base.replace(/\/$/, "")}/send_group_msg`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        group_id: Number(groupId),
        message: [
          { type: "image", data: { file: illust.imageUrl } },
          { type: "text", data: { text: `\n${text(illust)}` } },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`NapCat HTTP ${res.status}: ${await res.text()}`);
    const j = (await res.json().catch(() => ({}))) as { retcode?: number; status?: string };
    if (typeof j.retcode === "number" && j.retcode !== 0) {
      throw new Error(`NapCat 返回失败: ${JSON.stringify(j)}`);
    }
  },
};
