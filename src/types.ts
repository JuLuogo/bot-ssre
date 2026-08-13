// 全局类型定义：环境绑定、统一插画结构、数据源/渠道适配器接口、应用配置。

export interface Env {
  KV: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  PIXIV_PROXY_HOST: string;
  // 以下为 secret（wrangler secret put），本地可用 .dev.vars
  TG_BOT_TOKEN?: string;
  NAPCAT_BASE_URL?: string;
  NAPCAT_TOKEN?: string;
  ADMIN_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  QQ_BOT_APPID?: string;
  QQ_BOT_SECRET?: string;
}

export type Rating = "safe" | "questionable" | "explicit" | "unknown";

/** 各数据源归一化后的统一插画结构 */
export interface Illust {
  source: string; // 适配器/站点标识，如 "safebooru" | "pixiv"
  id: string; // 站内作品 id（与 source 组合唯一）
  title: string;
  author: string;
  imageUrl: string; // 可被 TG/QQ 服务器直接拉取的图片地址（已做反代/优选尺寸）
  pageUrl: string; // 原始作品页链接
  rating: Rating;
  score: number;
  tags: string[];
  rank?: number; // 排行榜名次（若有）
}

export interface SourceOptions {
  limit: number; // 拉取条数上限
  tags?: string; // booru 额外查询标签
  mode?: string; // pixiv 榜单模式：daily/weekly/monthly...
  site?: string; // booru 站点 base，或 RSS/RSSHub 完整 URL
  label?: string; // 数据源展示名（RSS 用作 source 前缀）
}

/** 数据源适配器：拉取并归一化排行榜 */
export interface SourceAdapter {
  name: string;
  fetchRanking(env: Env, opts: SourceOptions): Promise<Illust[]>;
}

export interface PushOptions {
  apiBase?: string; // Telegram Bot API 反代 base，默认官方
}

/** 推送渠道适配器：把一张图发到某个目标 */
export interface ChannelAdapter {
  name: string;
  push(env: Env, illust: Illust, target: string, opts?: PushOptions): Promise<void>;
}

/** 单个数据源的运行配置 */
export interface SourceConfig {
  id?: number; // D1 主键（新增时无）
  adapter: "gelbooru" | "moebooru" | "pixiv" | "rss";
  enabled: boolean;
  label: string; // 展示名
  site?: string; // booru 站点 base url，或 RSSHub 路由完整 URL
  tags?: string; // booru 查询标签（不含 rating，rating 由过滤器统一处理）
  mode?: string; // pixiv 榜单模式
  limit: number; // 每次取前 N 条
  trusted?: boolean; // 可信来源，跳过全年龄过滤（RSS 订阅默认 true）
  sortOrder?: number;
}

/** 应用配置（默认值 + KV 覆盖） */
export interface AppConfig {
  sources: SourceConfig[];
  telegram: { enabled: boolean; chatIds: string[]; apiBase?: string };
  napcat: { enabled: boolean; groupIds: string[] }; // 个人 QQ（NapCat 中转）
  qqbot: { enabled: boolean; targets: string[] }; // QQ 官方机器人，target 形如 group:<openid> / user:<openid>
  perRunTotalCap: number; // 单次运行跨所有源的推送总上限，防刷屏
  seenTtlDays: number; // 去重标记保留天数
}

/** 最近推送记录（供网页展示） */
export interface PushRecord {
  source: string;
  id: string;
  title: string;
  author: string;
  imageUrl: string;
  pageUrl: string;
  pushedAt: number; // epoch ms
  channels: string[]; // 成功推送到的渠道
}

/** pipeline 运行结果摘要 */
export interface RunSummary {
  startedAt: number;
  finishedAt: number;
  fetched: number;
  filtered: number;
  pushed: number;
  errors: string[];
  perSource: Record<string, number>;
}
