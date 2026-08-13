// 统一的 fetch 封装：默认 UA、超时、JSON 解析。
export const UA = "Mozilla/5.0 (compatible; acg-rank-pusher/0.1)";

export async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, ...(init?.headers as Record<string, string> | undefined) },
    signal: init?.signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}
