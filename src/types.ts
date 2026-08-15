// 全局类型定义：环境绑定、统一插画结构、数据源/渠道适配器接口、应用配置。

export interface Env {
  KV: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  R2: R2Bucket; // 图片中转桶（QQ 拉不动慢反代时，Worker 下载后经 /img/<key> 转发）
  ENVIRONMENT: string;
  PIXIV_PROXY_HOST: string;
  // 以下为 secret（wrangler secret put）/ 可后台配的凭证，本地可用 .dev.vars
  PIXIV_API_BASE?: string; // Pixiv 榜单 API 反代 base（绕开 Cloudflare IP 被 Pixiv 封）；留空直连 www.pixiv.net
  PUBLIC_BASE_URL?: string; // bot 对外可达的基址（如 https://bot-ces.060730.xyz），用于拼中转图地址；须是 QQ 能访问到的域名
  TG_BOT_TOKEN?: string;
  NAPCAT_BASE_URL?: string;
  NAPCAT_TOKEN?: string;
  ADMIN_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  QQ_BOT_APPID?: string;
  QQ_BOT_SECRET?: string;
  NAPCAT_WEBHOOK_SECRET?: string; // OneBot HTTP 上报验签密钥（校验 X-Signature）
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
  adapter: "gelbooru" | "moebooru" | "pixiv" | "rss" | "randompic" | "randomapi";
  enabled: boolean;
  label: string; // 展示名
  site?: string; // booru base / RSSHub URL / randompic 站点根地址
  tags?: string; // booru 查询标签（不含 rating，rating 由过滤器统一处理）
  mode?: string; // pixiv 榜单模式；randompic 图片类型（如 v,h,j）
  limit: number; // 每次取前 N 条
  trusted?: boolean; // 可信来源，跳过全年龄过滤（RSS 订阅默认 true）
  sortOrder?: number;
}

/** 应用配置（默认值 + KV 覆盖） */
export interface AppConfig {
  sources: SourceConfig[];
  telegram: { enabled: boolean; chatIds: string[]; apiBase?: string };
  napcat: { enabled: boolean; groupIds: string[] }; // 个人 QQ（NapCat 中转）
  // QQ 官方机器人，target 形如 group:<openid> / user:<openid>
  // groupActivePush：是否向「群」做主动推送（定时/手动）。QQ 官方主动消息需单独申请权限，
  // 未获权限时会返回 40034105；关掉它就只在群里响应关键词触发（被动回复），不再产生无用失败。
  qqbot: { enabled: boolean; targets: string[]; groupActivePush?: boolean };
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
  /** 诊断信息（本次实际尝试的渠道与目标）；只在 API 响应里返回，不入库。 */
  notes?: string[];
}
