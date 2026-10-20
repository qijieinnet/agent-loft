// 账号额度：Codex 的 5 小时 / 7 天用量窗口。
//
// 这块是补一个认知落差：Codex 自己的 TUI 里 `/status` 会显示剩余额度，
// 而im-agent的 `/status` 是另一条命令（同名而已），本来只报会话和目录。
// 用的人不会关心这个区别，他只知道「同样敲 /status，这边少了额度」。
// 与其解释，不如把它显示出来 —— app-server 本来就给了。
import type { QuotaInfo } from "../../core/types.js";
import { appServer } from "./app-server.js";

type UsageWindow = {
  usedPercent: number;
  /** 窗口长度（分钟）。300 = 5 小时，10080 = 7 天 */
  windowDurationMins: number;
  /** 重置时刻，Unix 秒 */
  resetsAt: number;
};

type RateLimits = {
  planType?: string | null;
  primary?: UsageWindow | null;
  secondary?: UsageWindow | null;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string } | null;
  /** 非空表示已经撞上限了 */
  rateLimitReachedType?: string | null;
};

/**
 * 额度是会变的，但 /status 也可能被连敲几次，缓存一小会儿。
 * 60 秒足够挡住手抖，又不至于让人看到明显过期的数字。
 */
const CACHE_MS = 60_000;
let cache: { at: number; value: RateLimits | null } | null = null;

export async function readRateLimits(): Promise<RateLimits | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const res = await appServer.call<{ rateLimits?: RateLimits }>(
      "account/rateLimits/read",
      {},
    );
    cache = { at: Date.now(), value: res.rateLimits ?? null };
  } catch (err) {
    // 读不到额度不该让整条 /status 失败 —— 它只是其中一行
    console.error("[额度] 读取失败:", err instanceof Error ? err.message : err);
    cache = { at: Date.now(), value: null };
  }
  return cache.value;
}

/** 300 → 「5h」，10080 → 「7d」 */
function windowShort(mins: number): string {
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/** 侧栏用的结构化额度 */
export function toQuota(limits: RateLimits | null): QuotaInfo | null {
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary]
    .filter((w): w is UsageWindow => !!w)
    .map((w) => ({
      label: windowName(w.windowDurationMins),
      short: windowShort(w.windowDurationMins),
      percent: w.usedPercent,
      resetsAt: w.resetsAt * 1000,
    }));
  if (windows.length === 0) return null;
  const credits = limits.credits;
  const extra = credits?.unlimited ? "额度包：无限" : credits?.hasCredits && credits.balance ? `额度包：余 ${credits.balance}` : undefined;
  return {
    ...(limits.planType ? { plan: limits.planType } : {}),
    windows,
    ...(extra ? { extra } : {}),
    ...(limits.rateLimitReachedType ? { reached: true } : {}),
  };
}

/** 300 → 「5 小时」，10080 → 「7 天」，45 → 「45 分钟」 */
function windowName(mins: number): string {
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)} 天`;
  if (mins % 60 === 0) return `${mins / 60} 小时`;
  return `${mins} 分钟`;
}

/** 距离重置还有多久。已经过了就说「即将重置」，不显示负数。 */
function untilReset(resetsAt: number, now = Date.now()): string {
  const seconds = resetsAt - Math.floor(now / 1000);
  if (seconds <= 0) return "即将重置";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时后重置`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分后重置`;
  return `${minutes} 分钟后重置`;
}

function line(label: string, w: UsageWindow): string {
  return `  ${label}　已用 ${w.usedPercent}%　${untilReset(w.resetsAt)}`;
}

/**
 * 渲染成 /status 里的几行。没有可显示的就返回空数组，让调用方自然略过
 * —— 与其印一行「额度：未知」，不如什么都不印。
 */
export function describeRateLimits(limits: RateLimits | null): string[] {
  if (!limits) return [];
  const rows: string[] = [];
  if (limits.primary) rows.push(line(windowName(limits.primary.windowDurationMins), limits.primary));
  if (limits.secondary) {
    rows.push(line(windowName(limits.secondary.windowDurationMins), limits.secondary));
  }
  if (rows.length === 0) return [];

  const credits = limits.credits;
  if (credits?.unlimited) rows.push("  额度包　无限");
  else if (credits?.hasCredits && credits.balance) rows.push(`  额度包　余 ${credits.balance}`);

  if (limits.rateLimitReachedType) rows.push("  ⚠️ 已达上限，等窗口重置后才能继续");

  return [`额度${limits.planType ? `（${limits.planType}）` : ""}`, ...rows];
}
