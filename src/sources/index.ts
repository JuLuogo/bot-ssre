// 数据源适配器注册表。
import type { SourceAdapter } from "../types";
import { gelbooru } from "./gelbooru";
import { pixiv } from "./pixiv";
import { moebooru } from "./moebooru";
import { rss } from "./rss";

const ADAPTERS: Record<string, SourceAdapter> = { gelbooru, pixiv, moebooru, rss };

export function getSourceAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
