// Worker 入口：fetch（网页 + API）与 scheduled（定时爬取推送）。
import type { Env } from "./types";
import { runOnce } from "./pipeline";
import { handleApi } from "./api";
import { handleTelegramWebhook } from "./telegram_bot";
import { handleQQBotWebhook } from "./qqbot_webhook";
import { handleOneBotWebhook } from "./onebot_webhook";
import { alreadyExecuted } from "./store";
import { resolveEnv } from "./creds";
import { isAuthed, loginResponse } from "./auth";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // webhook 先合并 D1 凭证，使后台配置的密钥生效
    if (url.pathname === "/tg/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, await resolveEnv(env));
    }
    if (url.pathname === "/qq/webhook" && request.method === "POST") {
      return handleQQBotWebhook(request, await resolveEnv(env));
    }
    // OneBot(NapCat) 上报：传原始 env，命中命令后内部再 resolveEnv，非命令消息不触碰 D1
    if (url.pathname === "/onebot/webhook" && request.method === "POST") {
      return handleOneBotWebhook(request, env);
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    // 后台页面门禁：未登录一律显示登录页，鉴权后才下发管理 SPA
    if (!(await isAuthed(request, env))) return loginResponse();
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const execId = `${controller.cron}-${controller.scheduledTime}`;
    if (await alreadyExecuted(env, execId)) {
      controller.noRetry();
      return;
    }
    const summary = await runOnce(await resolveEnv(env));
    console.log("[scheduled]", JSON.stringify(summary));
  },
} satisfies ExportedHandler<Env>;
