// 数据源适配器注册表。
import type { SourceAdapter } from "../types";
import { gelbooru } from "./gelbooru";
import { pixiv } from "./pixiv";
import { moebooru } from "./moebooru";
import { rss } from "./rss";
import { randompic } from "./randompic";

const ADAPTERS: Record<string, SourceAdapter> = { gelbooru, pixiv, moebooru, rss, randompic };

export function getSourceAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
