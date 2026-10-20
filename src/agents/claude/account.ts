// 账号额度：Claude 订阅的 5 小时 / 7 天用量窗口，和 Codex 那边的 account.ts 对齐。
//
// 数据来自 SDK 的 usage 控制请求 —— 也就是 Claude Code 里 `/usage` 背后的那份结构化数据，
// 通过探针 query 读取（见 probe.ts）。
//
// 注意：SDK 把它标成了 EXPERIMENTAL，方法名以后会改。改了的话这里只会读失败，
// /status 少几行而已，不影响别的。
import type { QuotaInfo } from "../../core/types.js";
import { cachedProbe, withProbe } from "./probe.js";

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

type LimitRow = {
  kind: string;
  group: string;
  percent: number;
  resets_at: string | null;
  severity?: string;
  scope?: { model?: { display_name: string } | null; surface?: { display_name: string } | null } | null;
};

export type ClaudeUsage = {
  subscriptionType: string | null;
  rows: { label: string; short: string; percent: number; resetsAt: string | null; severity?: string }[];
};

function labelOf(row: LimitRow): string {
  const scope = row.scope?.model?.display_name || row.scope?.surface?.display_name;
  const base = row.kind === "session" ? "5 小时" : row.group === "weekly" ? "7 天" : row.kind;
  return scope ? `${base}（${scope}）` : base;
}

/** 侧栏紧凑显示用：5h / 7d，带范围的加上范围名 */
function shortOf(row: LimitRow): string {
  const scope = row.scope?.model?.display_name || row.scope?.surface?.display_name;
  const base = row.kind === "session" ? "5h" : row.group === "weekly" ? "7d" : row.kind;
  return scope ? `${base} ${scope}` : base;
}

function normalize(res: {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: Record<string, unknown> | null;
}): ClaudeUsage | null {
  if (!res.rate_limits_available || !res.rate_limits) return null;
  const rl = res.rate_limits;
  const limits = rl.limits as LimitRow[] | null | undefined;
  let rows: ClaudeUsage["rows"];
  if (Array.isArray(limits)) {
    // 新版服务端直接给出要显示哪些行、什么顺序，照单全收
    rows = limits.map((r) => ({
      label: labelOf(r),
      short: shortOf(r),
      percent: r.percent,
      resetsAt: r.resets_at,
      ...(r.severity ? { severity: r.severity } : {}),
    }));
  } else {
    // 老格式兜底：只认两个主窗口
    rows = [];
    for (const [key, label, short] of [
      ["five_hour", "5 小时", "5h"],
      ["seven_day", "7 天", "7d"],
    ] as const) {
      const w = rl[key] as Window;
      if (w && w.utilization != null) rows.push({ label, short, percent: w.utilization, resetsAt: w.resets_at });
    }
  }
  return { subscriptionType: res.subscription_type, rows };
}

async function fetchUsage(): Promise<ClaudeUsage | null> {
  const res = await withProbe((q) =>
    q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
  );
  return normalize(res as Parameters<typeof normalize>[0]);
}

/**
 * 同 Codex：缓存 60 秒，挡住连敲几次 /status，又不至于数字明显过期。
 * 读不到额度不该让整条 /status 失败 —— 它只是其中几行，所以失败时给 null。
 */
export const readUsage = cachedProbe(60_000, "额度", fetchUsage, null);

/** 距离重置还有多久，和 Codex 那边同一个说法 */
function untilReset(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return "";
  const seconds = Math.floor((ms - now) / 1000);
  if (seconds <= 0) return "即将重置";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时后重置`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分后重置`;
  return `${minutes} 分钟后重置`;
}

/** 侧栏用的结构化额度 */
export function toQuota(usage: ClaudeUsage | null): QuotaInfo | null {
  if (!usage || usage.rows.length === 0) return null;
  return {
    ...(usage.subscriptionType ? { plan: usage.subscriptionType } : {}),
    windows: usage.rows.map((r) => {
      const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN;
      return { label: r.label, short: r.short, percent: r.percent, ...(Number.isNaN(at) ? {} : { resetsAt: at }) };
    }),
    ...(usage.rows.some((r) => r.percent >= 100) ? { reached: true } : {}),
  };
}

/** 渲染成 /status 里的几行；没有可显示的就返回空数组（API key / Bedrock 之类没有订阅额度） */
export function describeUsage(usage: ClaudeUsage | null, now = Date.now()): string[] {
  if (!usage || usage.rows.length === 0) return [];
  const rows = usage.rows.map((r) => {
    const reset = untilReset(r.resetsAt, now);
    return `  ${r.label}　已用 ${Math.round(r.percent)}%${reset ? `　${reset}` : ""}`;
  });
  if (usage.rows.some((r) => r.percent >= 100)) rows.push("  ⚠️ 已达上限，等窗口重置后才能继续");
  return [`额度${usage.subscriptionType ? `（${usage.subscriptionType}）` : ""}`, ...rows];
}
