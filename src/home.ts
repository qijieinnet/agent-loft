// 家目录定位。单独成模块：CLI 里有些命令在配置存在之前就要跑，
// 它们只需要知道目录在哪，不该被配置校验挡住。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 配置与状态的家目录。AGENT_LOFT_HOME 可覆盖，默认 ~/.agent-loft。
 * 兼容改名前（im-agent）：旧的 IM_AGENT_HOME 也认；新目录还不存在而 ~/.im-agent 在，就继续用旧目录，
 * 不自动搬家 —— 正在跑的旧服务还在写它。
 */
export const home = (() => {
  const explicit = (process.env.AGENT_LOFT_HOME ?? process.env.IM_AGENT_HOME)?.trim();
  if (explicit) return path.resolve(explicit);
  const current = path.join(os.homedir(), ".agent-loft");
  const legacy = path.join(os.homedir(), ".im-agent");
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
})();

export const configPath = path.join(home, "config.json");
export const dataDir = path.join(home, "data");
export const logsDir = path.join(home, "logs");

export function ensureDirs(): void {
  for (const dir of [home, dataDir, logsDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 原子写：先写临时文件再 rename，进程中途被杀也不会留下半截 JSON。 */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
