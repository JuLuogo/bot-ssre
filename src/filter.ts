// 内容分级归一化与全年龄过滤。
import type { Illust, Rating } from "./types";

/** booru/moebooru 的 rating 字符串归一化 */
export function normalizeBooruRating(r: unknown): Rating {
  const v = String(r ?? "").toLowerCase();
  if (v === "s" || v === "safe" || v === "general") return "safe";
  if (v === "q" || v === "questionable" || v === "sensitive") return "questionable";
  if (v === "e" || v === "explicit") return "explicit";
  return "unknown";
}

/** 只放行确定的全年龄内容 */
export function isAllAges(i: Illust): boolean {
  return i.rating === "safe";
}
