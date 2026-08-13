// Telegram 推送渠道：优先让 TG 服务器拉 URL，失败则 Worker 下载后 multipart 上传。
// apiBase 可选（反代），默认官方 https://api.telegram.org。
import type { ChannelAdapter, Env, Illust, PushOptions } from "../types";

const DEFAULT_API = "https://api.telegram.org";

function caption(i: Illust): string {
  const lines = [
    i.title,
    i.author ? `作者: ${i.author}` : "",
    `来源: ${i.source}${i.rank ? ` · No.${i.rank}` : ""}`,
    i.pageUrl,
  ].filter(Boolean);
  return lines.join("\n").slice(0, 1024);
}

const apiUrl = (base: string, token: string, method: string) =>
  `${base.replace(/\/$/, "")}/bot${token}/${method}`;

export const telegram: ChannelAdapter = {
  name: "telegram",
  async push(env: Env, illust: Illust, chatId: string, opts?: PushOptions): Promise<void> {
    const token = env.TG_BOT_TOKEN;
    if (!token) throw new Error("TG_BOT_TOKEN 未配置");
    if (!illust.imageUrl) throw new Error("imageUrl 为空");
    const base = opts?.apiBase || DEFAULT_API;

    // 1) 让 Telegram 服务器直接按 URL 拉取（最省资源）
    const byUrl = await fetch(apiUrl(base, token, "sendPhoto"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: illust.imageUrl, caption: caption(illust) }),
    });
    if (byUrl.ok) return;
    const urlErr = await byUrl.text();

    // 2) 回退：Worker 下载图片后以 multipart 上传
    const img = await fetch(illust.imageUrl, { signal: AbortSignal.timeout(20000) });
    if (!img.ok) throw new Error(`sendPhoto(URL) 失败: ${urlErr}; 下载图片失败 HTTP ${img.status}`);
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", caption(illust));
    form.set("photo", await img.blob(), `${illust.source}_${illust.id}.jpg`);
    const byFile = await fetch(apiUrl(base, token, "sendPhoto"), { method: "POST", body: form });
    if (!byFile.ok) throw new Error(`sendPhoto(multipart) 失败: ${await byFile.text()}`);
  },
};
