// 数据源适配器注册表。
import type { SourceAdapter } from "../types";
import { gelbooru } from "./gelbooru";
import { pixiv } from "./pixiv";
import { moebooru } from "./moebooru";
import { rss } from "./rss";
import { randompic } from "./randompic";
import { randomapi } from "./randomapi";

const ADAPTERS: Record<string, SourceAdapter> = { gelbooru, pixiv, moebooru, rss, randompic, randomapi };

export function getSourceAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
