// 定时发送：额度用完了、要等刷新才能接着干活时，先把下一条消息排好，到点由服务端替用户发出去。
//
// 放在服务端而不是页面里：到点时浏览器可能早关了。落盘在 data/scheduled.json，重启后接着等；
// 服务停着的那段时间里到点的，启动后立刻补发。只支持纯文字（附件是临时上传的，放不了那么久）。
import crypto from "node:crypto";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";

export type ScheduledMessage = {
  id: string;
  key: string;
  text: string;
  /** 什么时候发（毫秒时间戳） */
  at: number;
  createdAt: number;
};

/** 每条对话最多排几条 */
export const SCHEDULED_MAX = 20;

const storePath = path.join(dataDir, "scheduled.json");
let cache: ScheduledMessage[] | null = null;
let timer: NodeJS.Timeout | null = null;
let fire: ((m: ScheduledMessage) => void) | null = null;

function load(): ScheduledMessage[] {
  cache ??= readJson<ScheduledMessage[]>(storePath, []).filter((m) => m && typeof m.text === "string" && Number.isFinite(m.at));
  return cache;
}

function save(): void {
  writeJsonAtomic(storePath, load());
}

export function listScheduled(key: string): ScheduledMessage[] {
  return load()
    .filter((m) => m.key === key)
    .sort((a, b) => a.at - b.at);
}

export function addScheduled(key: string, text: string, at: number): ScheduledMessage {
  if (!text.trim()) throw new Error("定时发送的内容不能为空");
  if (!Number.isFinite(at)) throw new Error("时间不对");
  if (listScheduled(key).length >= SCHEDULED_MAX) throw new Error(`这条对话最多排 ${SCHEDULED_MAX} 条定时消息`);
  const item: ScheduledMessage = { id: crypto.randomBytes(6).toString("hex"), key, text, at, createdAt: Date.now() };
  load().push(item);
  save();
  arm();
  return item;
}

export function removeScheduled(key: string, id: string): boolean {
  const list = load();
  const i = list.findIndex((m) => m.id === id && m.key === key);
  if (i < 0) return false;
  list.splice(i, 1);
  save();
  arm();
  return true;
}

/** 对话被删 / 换了主人之类：把它排着的全清掉 */
export function clearScheduled(key: string): void {
  const list = load();
  const kept = list.filter((m) => m.key !== key);
  if (kept.length === list.length) return;
  cache = kept;
  save();
  arm();
}

/** 定时器只挂最近的那一条；setTimeout 最长约 24.8 天，更远的先睡到上限再重新算 */
function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!fire) return;
  const next = load().reduce<number | null>((min, m) => (min === null || m.at < min ? m.at : min), null);
  if (next === null) return;
  const delay = Math.min(Math.max(next - Date.now(), 0), 2 ** 31 - 1);
  timer = setTimeout(tick, delay);
  timer.unref();
}

function tick(): void {
  timer = null;
  const now = Date.now();
  const list = load();
  const due = list.filter((m) => m.at <= now).sort((a, b) => a.at - b.at);
  if (due.length) {
    cache = list.filter((m) => m.at > now);
    save();
    for (const m of due) {
      try {
        fire?.(m);
      } catch (err) {
        console.error(`[定时发送] ${m.key} 发送失败:`, err instanceof Error ? err.message : err);
      }
    }
  }
  arm();
}

/** 启动调度。onFire 负责真正把消息发出去（由 main.ts 接到 hub 上，这里不依赖 hub） */
export function startScheduler(onFire: (m: ScheduledMessage) => void): void {
  fire = onFire;
  arm();
}

export function stopScheduler(): void {
  fire = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
