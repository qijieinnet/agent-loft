// 定时任务的「什么时候跑」：几种常用的结构化写法 + 自定义 cron，一律按服务端所在时区解释。
//
// 存结构化的而不是一律存 cron：界面上的「每天 / 工作日 / 每周…」能原样回填，描述也好写；
// 除「一次」以外都先换成 cron 再算下次时间，只有一条计算路径。

export type TaskSchedule =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  /** days：0 = 周日 … 6 = 周六 */
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; day: number; time: string }
  /** 每 every 小时一次，在第 minute 分（从 0 点起算：every=6 就是 0、6、12、18 点） */
  | { kind: "hourly"; every: number; minute: number }
  | { kind: "cron"; expr: string };

/** 两次运行至少隔这么久：太密了会把额度跑光 */
export const MIN_GAP_MS = 15 * 60_000;
/** 「一次」最多排到多久以后 */
export const ONCE_MAX_MS = 366 * 86400_000;

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时间";
}

// ---------- cron ----------

type CronSpec = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean };

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(raw: string, [min, max]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`cron 的${name}字段写得不对：${raw}`);
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      // 「5/15」= 从 5 起每 15
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (step < 1 || lo < min || hi > max || lo > hi) throw new Error(`cron 的${name}字段超出范围：${raw}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 要写 5 段：分 时 日 月 周，比如「0 2 * * *」是每天 2 点");
  const names = ["分钟", "小时", "日期", "月份", "星期"];
  const [minute, hour, dom, month, dowRaw] = fields.map((f, i) => parseField(f, RANGES[i]!, names[i]!));
  const dow = new Set([...dowRaw!].map((d) => d % 7));
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow, domAny: fields[2] === "*", dowAny: fields[4] === "*" };
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  const dom = spec.dom.has(d.getDate());
  const dow = spec.dow.has(d.getDay());
  // 和标准 cron 一样：日期、星期都限定了的时候，满足其一就算
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dow;
  if (spec.dowAny) return dom;
  return dom || dow;
}

/** from 之后（不含）最近一次匹配的时刻；一年内都没有就是 undefined */
export function cronNext(spec: CronSpec, from: number): number | undefined {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 400 * 86400_000;
  while (d.getTime() <= limit) {
    if (!spec.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}

// ---------- 结构化写法 ----------

function parseTime(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`时间要写成 HH:MM，比如 02:00（收到的是「${time}」）`);
  return [Number(m[1]), Number(m[2])];
}

export function toCron(s: Exclude<TaskSchedule, { kind: "once" }>): string {
  switch (s.kind) {
    case "daily": {
      const [h, m] = parseTime(s.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const [h, m] = parseTime(s.time);
      return `${m} ${h} * * 1-5`;
    }
    case "weekly": {
      const [h, m] = parseTime(s.time);
      return `${m} ${h} * * ${[...new Set(s.days)].sort((a, b) => a - b).join(",")}`;
    }
    case "monthly": {
      const [h, m] = parseTime(s.time);
      return `${m} ${h} ${s.day} * *`;
    }
    case "hourly":
      return `${s.minute} ${s.every === 1 ? "*" : `*/${s.every}`} * * *`;
    case "cron":
      return s.expr.trim();
  }
}

const int = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what}要是 ${lo}-${hi} 之间的整数`);
  return n;
};

/** 校验并规整（来自网页表单或 agent 的工具调用，都不可信）。不合规直接抛出给人看的错误 */
export function normalizeSchedule(raw: unknown, now = Date.now()): TaskSchedule {
  const r = (raw ?? {}) as Record<string, unknown>;
  let s: Exclude<TaskSchedule, { kind: "once" }>;
  switch (r.kind) {
    case "once": {
      const at = Number(r.at);
      if (!Number.isFinite(at)) throw new Error("「一次」要给运行时间");
      if (at < now - 60_000) throw new Error("运行时间要在现在之后");
      if (at > now + ONCE_MAX_MS) throw new Error("最多只能排到一年以后");
      return { kind: "once", at: Math.floor(at / 60_000) * 60_000 };
    }
    case "daily":
    case "weekdays":
      s = { kind: r.kind, time: String(r.time ?? "") };
      break;
    case "weekly": {
      const days = Array.isArray(r.days) ? r.days.map((d) => int(d, 0, 7, "星期") % 7) : [];
      if (days.length === 0) throw new Error("「每周」至少选一天");
      s = { kind: "weekly", days: [...new Set(days)].sort((a, b) => a - b), time: String(r.time ?? "") };
      break;
    }
    case "monthly":
      s = { kind: "monthly", day: int(r.day, 1, 31, "日期"), time: String(r.time ?? "") };
      break;
    case "hourly":
      s = { kind: "hourly", every: int(r.every, 1, 23, "间隔小时数"), minute: int(r.minute ?? 0, 0, 59, "分钟") };
      break;
    case "cron":
      s = { kind: "cron", expr: String(r.expr ?? "").trim().replace(/\s+/g, " ") };
      break;
    default:
      throw new Error("不认识的频率");
  }
  if ("time" in s) {
    const [h, m] = parseTime(s.time);
    s.time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const spec = parseCron(toCron(s));
  // 抽查接下来的几次，相邻两次不能太近
  let prev = cronNext(spec, now);
  if (prev === undefined) throw new Error("按这个写法一年内都不会运行");
  for (let i = 0; i < 8; i++) {
    const next = cronNext(spec, prev);
    if (next === undefined) break;
    if (next - prev < MIN_GAP_MS) throw new Error(`太频繁了：两次运行至少要隔 ${MIN_GAP_MS / 60_000} 分钟`);
    prev = next;
  }
  return s;
}

/** from 之后下一次该跑的时刻；「一次」跑过了就没有 */
export function nextRun(s: TaskSchedule, from: number): number | undefined {
  if (s.kind === "once") return s.at > from ? s.at : undefined;
  try {
    return cronNext(parseCron(toCron(s)), from);
  } catch {
    return undefined;
  }
}

// ---------- 描述 ----------

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${formatClock(ms)}`;
}

/** 给人看的一句话：「每天 02:00」「工作日 09:30」「每周一、三 08:00」 */
export function describeSchedule(s: TaskSchedule): string {
  switch (s.kind) {
    case "once":
      return `一次：${formatDateTime(s.at)}`;
    case "daily":
      return `每天 ${s.time}`;
    case "weekdays":
      return `工作日 ${s.time}`;
    case "weekly":
      return s.days.length === 7 ? `每天 ${s.time}` : `每周${s.days.map((d) => WEEK[d]).join("、")} ${s.time}`;
    case "monthly":
      return `每月 ${s.day} 日 ${s.time}`;
    case "hourly":
      return s.every === 1 ? `每小时第 ${s.minute} 分` : `每 ${s.every} 小时（第 ${s.minute} 分）`;
    case "cron":
      return `cron：${s.expr}`;
  }
}

/**
 * 「2026-10-23 15:00」这类本地时间（agent 给的），也认带时区的 ISO 写法。解析不了返回 NaN。
 * 不带时区的一律按服务端时区解释 —— Date.parse 对「YYYY-MM-DDTHH:MM」本来就是按本地时间。
 */
export function parseLocalDateTime(text: string): number {
  const t = String(text ?? "").trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Date.parse(t);
}
