// HTTP API：状态 / 推送记录 / 运行历史 / 手动触发 / 配置 / 数据源 / 订阅者 / 凭证 / 连通性自检。
import type { AppConfig, Env, SourceConfig } from "./types";
import { runOnce, pushRandomBatch } from "./pipeline";
import { getConfig, saveConfig } from "./config";
import {
  listRecent,
  latestRun,
  listRuns,
  listSources,
  upsertSource,
  deleteSource,
  listSubscribers,
  deleteSubscriber,
} from "./db";
import { listCredentialStatus, setCredential, deleteCredential, resolveEnv } from "./creds";
import { getAccessToken } from "./channels/qqbot";
import { isAuthed, checkPassword, buildSessionCookie, buildClearCookie } from "./auth";
import { getOnDemandConfig, setOnDemandConfig, type OnDemandConfig } from "./ondemand";
import { listProviderMeta, getProvider } from "./sources/randomapi_providers";
import { listDiag, clearDiag } from "./diag";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

interface TestResult {
  ok: boolean;
  detail: string;
}

async function testTelegram(renv: Env, apiBase?: string): Promise<TestResult> {
  const token = renv.TG_BOT_TOKEN;
  if (!token) return { ok: false, detail: "TG_BOT_TOKEN 未配置" };
  const base = (apiBase || "https://api.telegram.org").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
    const txt = await res.text();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${txt.slice(0, 180)}` };
    const j = JSON.parse(txt) as { result?: { username?: string; first_name?: string } };
    return { ok: true, detail: `Bot @${j.result?.username ?? j.result?.first_name ?? "?"} 可用（${base}）` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function testQQBot(renv: Env): Promise<TestResult> {
  try {
    const t = await getAccessToken(renv);
    return { ok: true, detail: `access_token 获取成功（${t.slice(0, 6)}…）` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function testNapcat(renv: Env): Promise<TestResult> {
  const base = renv.NAPCAT_BASE_URL;
  if (!base) return { ok: false, detail: "NAPCAT_BASE_URL 未配置" };
  const headers: Record<string, string> = {};
  if (renv.NAPCAT_TOKEN) headers["Authorization"] = `Bearer ${renv.NAPCAT_TOKEN}`;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/get_login_info`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const txt = await res.text();
    return res.ok
      ? { ok: true, detail: `NapCat 可达：${txt.slice(0, 140)}` }
      : { ok: false, detail: `HTTP ${res.status}: ${txt.slice(0, 180)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleApi(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // 登录 / 登出：本身不需要已鉴权
  if (pathname === "/api/login" && method === "POST") {
    if (!env.ADMIN_TOKEN) return json({ ok: false, error: "后台未配置 ADMIN_TOKEN，请先设置该密钥" }, 503);
    const b = (await request.json().catch(() => null)) as { password?: string } | null;
    if (!b?.password || !checkPassword(env, b.password)) return json({ ok: false, error: "口令错误" }, 401);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": await buildSessionCookie(request, env),
      },
    });
  }
  if (pathname === "/api/logout" && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": buildClearCookie(request),
      },
    });
  }

  // 其余所有 /api/*（读与写）一律需要鉴权
  if (!(await isAuthed(request, env))) return json({ ok: false, error: "unauthorized" }, 401);

  if (pathname === "/api/status" && method === "GET") {
    const renv = await resolveEnv(env);
    const [cfg, last] = await Promise.all([getConfig(env), latestRun(env)]);
    return json({
      ok: true,
      env: env.ENVIRONMENT,
      origin: url.origin,
      config: cfg,
      lastRun: last,
      telegramConfigured: !!renv.TG_BOT_TOKEN,
      tgWebhookSecretSet: !!renv.TG_WEBHOOK_SECRET,
      napcatConfigured: !!renv.NAPCAT_BASE_URL,
      qqbotConfigured: !!(renv.QQ_BOT_APPID && renv.QQ_BOT_SECRET),
      pixivProxyConfigured: !!renv.PIXIV_PROXY_HOST,
      adminTokenSet: !!env.ADMIN_TOKEN,
    });
  }

  if (pathname === "/api/recent" && method === "GET") {
    return json({ ok: true, items: await listRecent(env, 60) });
  }

  if (pathname === "/api/runs" && method === "GET") {
    return json({ ok: true, items: await listRuns(env, 20) });
  }

  if (pathname === "/api/run" && method === "POST") {
    return json({ ok: true, summary: await runOnce(await resolveEnv(env)) });
  }

  // 手动随机推送：随机取 count 张(默认5,上限20)全年龄图，不去重强制推
  if (pathname === "/api/push-random" && method === "POST") {
    const n = Math.max(1, Math.min(20, Number(url.searchParams.get("count")) || 5));
    return json({ ok: true, summary: await pushRandomBatch(await resolveEnv(env), n) });
  }

  // 提示词触发返图配置（所有平台共用）
  if (pathname === "/api/ondemand") {
    if (method === "GET") return json({ ok: true, config: await getOnDemandConfig(env) });
    if (method === "POST") {
      const b = (await request.json().catch(() => null)) as Partial<OnDemandConfig> | null;
      if (!b) return json({ ok: false, error: "invalid body" }, 400);
      const triggers = Array.isArray(b.triggers) ? b.triggers.map((s) => String(s).trim()).filter(Boolean) : [];
      const cfg: OnDemandConfig = {
        enabled: !!b.enabled,
        triggers: triggers.length ? triggers : ["涩图", "/setu"],
        count: Math.max(1, Math.min(20, Number(b.count) || 1)),
        requireAtInGroup: b.requireAtInGroup !== false,
        allowPrivate: b.allowPrivate !== false,
      };
      await setOnDemandConfig(env, cfg);
      return json({ ok: true, config: cfg });
    }
  }

  // 连通性自检
  if (pathname === "/api/test" && method === "POST") {
    const renv = await resolveEnv(env);
    const target = url.searchParams.get("target") || "";
    if (target === "telegram") {
      const cfg = await getConfig(env);
      return json({ ok: true, target, result: await testTelegram(renv, cfg.telegram.apiBase) });
    }
    if (target === "qqbot") return json({ ok: true, target, result: await testQQBot(renv) });
    if (target === "napcat") return json({ ok: true, target, result: await testNapcat(renv) });
    return json({ ok: false, error: "target 需为 telegram | qqbot | napcat" }, 400);
  }

  // 凭证：只回掩码与来源，永不返回原文
  if (pathname === "/api/credentials") {
    if (method === "GET") return json({ ok: true, items: await listCredentialStatus(env) });
    if (method === "POST") {
      const b = (await request.json().catch(() => null)) as { name?: string; value?: string } | null;
      if (!b?.name || typeof b.value !== "string") return json({ ok: false, error: "需 name 与 value" }, 400);
      if (!(await setCredential(env, b.name, b.value))) {
        return json({ ok: false, error: `不允许写入的键: ${b.name}` }, 400);
      }
      return json({ ok: true, items: await listCredentialStatus(env) });
    }
    if (method === "DELETE") {
      const name = url.searchParams.get("name") || "";
      if (!(await deleteCredential(env, name))) return json({ ok: false, error: `不允许的键: ${name}` }, 400);
      return json({ ok: true, items: await listCredentialStatus(env) });
    }
  }

  // 第三方随机图 API 注册表（后台下拉用；只读）
  if (pathname === "/api/providers" && method === "GET") {
    return json({ ok: true, items: listProviderMeta() });
  }

  // 诊断日志（KV 环形缓冲）：排查"发了触发词没反应"用
  if (pathname === "/api/diag") {
    if (method === "GET") return json({ ok: true, items: await listDiag(env) });
    if (method === "DELETE") {
      await clearDiag(env);
      return json({ ok: true, items: [] });
    }
  }

  if (pathname === "/api/sources") {
    if (method === "GET") return json({ ok: true, items: await listSources(env) });
    if (method === "POST") {
      const b = (await request.json().catch(() => null)) as Partial<SourceConfig> | null;
      if (!b || !b.adapter || !b.label) return json({ ok: false, error: "invalid source（需 adapter 和 label）" }, 400);
      // 第三方随机图 API：site 必须是注册表中的 provider slug，且需密钥的不可启用（防任意 URL / SSRF）
      if (b.adapter === "randomapi") {
        const p = getProvider((b.site || "").trim());
        if (!p) return json({ ok: false, error: "未知的随机图 API provider（只能选注册表中的源）" }, 400);
        if (p.needsKey && (b.enabled ?? true)) return json({ ok: false, error: `${p.name} 需要密钥，暂不可启用` }, 400);
      }
      const saved = await upsertSource(env, {
        id: b.id,
        adapter: b.adapter,
        enabled: b.enabled ?? true,
        label: b.label,
        site: b.site,
        tags: b.tags,
        mode: b.mode,
        limit: b.limit ?? 5,
        trusted: b.trusted ?? b.adapter === "rss",
        sortOrder: b.sortOrder ?? 0,
      });
      return json({ ok: true, source: saved });
    }
    if (method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      if (!id) return json({ ok: false, error: "missing id" }, 400);
      await deleteSource(env, id);
      return json({ ok: true });
    }
  }

  if (pathname === "/api/config") {
    if (method === "GET") return json({ ok: true, config: await getConfig(env) });
    if (method === "POST") {
      const b = (await request.json().catch(() => null)) as Partial<AppConfig> | null;
      if (!b || !b.telegram || !b.napcat) return json({ ok: false, error: "invalid config body" }, 400);
      await saveConfig(env, {
        sources: [],
        telegram: b.telegram,
        napcat: b.napcat,
        qqbot: b.qqbot ?? { enabled: false, targets: [] },
        perRunTotalCap: b.perRunTotalCap ?? 10,
        seenTtlDays: b.seenTtlDays ?? 30,
      });
      return json({ ok: true, config: await getConfig(env) });
    }
  }

  if (pathname === "/api/subscribers") {
    if (method === "GET") {
      const p = url.searchParams.get("platform");
      return json({ ok: true, items: await listSubscribers(env, p && p !== "all" ? p : null, false) });
    }
    if (method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      if (!id) return json({ ok: false, error: "missing id" }, 400);
      await deleteSubscriber(env, id);
      return json({ ok: true });
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}
