// 配置门面：读写委托给 D1（见 db.ts）。
// sources 的增删改独立走 db.ts 与 /api/sources；saveConfig 只写 settings（telegram/napcat/global）。
import type { AppConfig, Env } from "./types";
import { loadConfig, saveSettings } from "./db";

export async function getConfig(env: Env): Promise<AppConfig> {
  return loadConfig(env);
}

export async function saveConfig(env: Env, config: AppConfig): Promise<void> {
  await saveSettings(env, config);
}
