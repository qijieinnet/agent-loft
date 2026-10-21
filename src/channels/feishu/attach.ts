// 飞书聊天「挂到」Web 会话上：挂上之后，这个飞书聊天说的话、发的命令都送进那条 Web 会话，
// 那条会话的回复、授权、提问也画到这个飞书聊天里。发 /detach 回到聊天自己的会话。
//
// 只是一层路由，会话本身（agent 进程、历史、审批）一点不动。按飞书会话键记：
//   feishu:<机器人id>:<chatId>[:<话题id>] → web:<…>
// 一条 Web 会话可以同时被好几个飞书聊天挂着。要落盘：重启之后飞书那边还接着它聊。
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../../home.js";

type Shape = Record<string, { target: string; at: number }>;

const storePath = path.join(dataDir, "feishu-attach.json");
let cache: Shape | null = null;

function load(): Shape {
  cache ??= readJson<Shape>(storePath, {});
  return cache;
}

function save(): void {
  writeJsonAtomic(storePath, cache ?? {});
}

/** 这个飞书会话挂着的 Web 会话键 */
export function attachedTarget(feishuKey: string): string | undefined {
  return load()[feishuKey]?.target;
}

export function attach(feishuKey: string, target: string): void {
  load()[feishuKey] = { target, at: Date.now() };
  save();
}

/** 返回原来挂着的目标（没挂着返回 undefined） */
export function detach(feishuKey: string): string | undefined {
  const prev = load()[feishuKey]?.target;
  if (prev === undefined) return undefined;
  delete load()[feishuKey];
  save();
  return prev;
}

/** 挂在 target 上的所有飞书会话键（可选只要某个前缀的，也就是某个机器人的） */
export function watchersOf(target: string, prefix = ""): string[] {
  return Object.entries(load())
    .filter(([k, v]) => v.target === target && k.startsWith(prefix))
    .map(([k]) => k);
}
