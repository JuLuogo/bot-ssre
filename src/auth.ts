// 后台鉴权：整个管理界面 + 所有 /api 都需要 ADMIN_TOKEN。
// 登录用 cookie 会话（值为 ADMIN_TOKEN 的 HMAC 派生，不落原文）；也兼容 Bearer/?token=（API 工具）。
// 未设置 ADMIN_TOKEN 时一律拒绝（fail-closed）——必须先设密钥才能用后台。
import type { Env } from "./types";

const COOKIE = "admin_session";
const SESSION_LABEL = "kiro-admin-session-v1";

const enc = new TextEncoder();

async function sessionValue(token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(SESSION_LABEL));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return "";
}

/** 定长比较，避免时序侧信道。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 请求是否已鉴权：cookie 会话 或 Bearer/?token=。未设 ADMIN_TOKEN 时恒为 false。 */
export async function isAuthed(request: Request, env: Env): Promise<boolean> {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  const cookie = readCookie(request, COOKIE);
  if (cookie && safeEqual(cookie, await sessionValue(token))) return true;
  const h = request.headers.get("Authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : "";
  const provided = bearer || new URL(request.url).searchParams.get("token") || "";
  return provided.length > 0 && safeEqual(provided, token);
}

export function checkPassword(env: Env, password: string): boolean {
  return !!env.ADMIN_TOKEN && typeof password === "string" && safeEqual(password, env.ADMIN_TOKEN);
}

function isLocalHost(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
}

/** 登录成功的 Set-Cookie（HttpOnly + SameSite=Strict；非本地强制 Secure）。 */
export async function buildSessionCookie(request: Request, env: Env): Promise<string> {
  const val = await sessionValue(env.ADMIN_TOKEN as string);
  const secure = isLocalHost(request) ? "" : " Secure;";
  return `${COOKIE}=${val}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=2592000`;
}

export function buildClearCookie(request: Request): string {
  const secure = isLocalHost(request) ? "" : " Secure;";
  return `${COOKIE}=; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=0`;
}

/** 未登录时返回的登录页（服务端直接下发，后台 SPA 不会泄露给未鉴权者）。 */
export function loginResponse(): Response {
  return new Response(LOGIN_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>登录 · 管理后台</title>
<style>
  :root{--bg:#0f1115;--card:#1a1d24;--border:#2a2f3a;--fg:#e6e8ec;--mut:#9aa3b2;--acc:#7c9cff;--bad:#f87171;}
  *{box-sizing:border-box;} html,body{height:100%;}
  body{margin:0;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);
    font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
  .box{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:26px;width:min(360px,92vw);}
  h1{font-size:17px;margin:0 0 4px;} p{color:var(--mut);font-size:12px;margin:0 0 18px;line-height:1.6;}
  input{width:100%;background:#0c0e12;border:1px solid var(--border);color:var(--fg);border-radius:8px;padding:10px 12px;font:inherit;}
  button{width:100%;margin-top:12px;background:var(--acc);color:#0b0d12;border:0;border-radius:8px;padding:11px;font-weight:600;cursor:pointer;font:inherit;}
  button:disabled{opacity:.5;cursor:not-allowed;}
  .msg{margin-top:12px;font-size:13px;min-height:18px;} .bad{color:var(--bad);}
</style></head><body>
<form class="box" id="f">
  <h1>🔒 管理后台</h1>
  <p>请输入 ADMIN_TOKEN 以访问。未输入正确口令前无法查看或修改任何数据。</p>
  <input type="password" id="pw" placeholder="ADMIN_TOKEN" autocomplete="current-password" autofocus />
  <button type="submit" id="b">登录</button>
  <div class="msg" id="m"></div>
</form>
<script>
  const f=document.getElementById("f"),pw=document.getElementById("pw"),b=document.getElementById("b"),m=document.getElementById("m");
  f.addEventListener("submit",async(e)=>{
    e.preventDefault(); m.textContent=""; m.className="msg"; b.disabled=true; b.textContent="登录中…";
    try{
      const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw.value})});
      const d=await r.json().catch(()=>({}));
      if(r.ok&&d.ok){ location.href="/"; return; }
      m.textContent=d.error||"登录失败"; m.className="msg bad";
    }catch(err){ m.textContent="网络错误"; m.className="msg bad"; }
    b.disabled=false; b.textContent="登录";
  });
</script></body></html>`;
