// 配对：陌生人给机器人发消息时拿到一个短码，消息本身不被处理；
// 在 Web 设置页或终端批准之后他才能用。替代手工抄 open_id。
//
// 按渠道实例分开记（channelId = 飞书机器人 id / 以后的 Telegram 机器人 id）：
// 在 A 机器人上被批准，不等于能用 B 机器人。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";

/** 去掉 0/O/1/I，避免念错抄错 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 60 * 60 * 1000;
/** 同时最多挂 3 个待批请求，防止陌生人刷屏 */
const MAX_PENDING = 3;

export type PairRequest = {
  code: string;
  userId: string;
  chatId: string;
  name?: string;
  createdAt: number;
};

type ChannelPairs = { pending: PairRequest[]; approved: string[] };
type Store = Record<string, ChannelPairs>;

const storePath = path.join(dataDir, "pairing.json");
export const pairingEvents = new EventEmitter<{ approved: [string, PairRequest]; requested: [string, PairRequest] }>();

function read(): Store {
  return readJson<Store>(storePath, {});
}

function channel(store: Store, channelId: string, now = Date.now()): ChannelPairs {
  const entry = (store[channelId] ??= { pending: [], approved: [] });
  entry.pending = entry.pending.filter((p) => now - p.createdAt < CODE_TTL_MS);
  return entry;
}

function newCode(): string {
  return Array.from(crypto.randomBytes(CODE_LENGTH), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function isPaired(channelId: string, userId: string | undefined): boolean {
  if (!userId) return false;
  return (read()[channelId]?.approved ?? []).includes(userId.trim().toLowerCase());
}

export type PairOutcome =
  | { kind: "already_pending"; request: PairRequest }
  | { kind: "created"; request: PairRequest }
  | { kind: "rejected_full" };

export function requestPairing(channelId: string, params: { userId: string; chatId: string; name?: string }): PairOutcome {
  const store = read();
  const ch = channel(store, channelId);
  const userId = params.userId.trim().toLowerCase();
  const existing = ch.pending.find((p) => p.userId === userId);
  if (existing) return { kind: "already_pending", request: existing };
  if (ch.pending.length >= MAX_PENDING) return { kind: "rejected_full" };
  const request: PairRequest = {
    code: newCode(),
    userId,
    chatId: params.chatId,
    ...(params.name ? { name: params.name } : {}),
    createdAt: Date.now(),
  };
  ch.pending.push(request);
  writeJsonAtomic(storePath, store);
  pairingEvents.emit("requested", channelId, request);
  return { kind: "created", request };
}

/** 所有渠道的待批请求 */
export function listPending(): { channelId: string; request: PairRequest }[] {
  const store = read();
  return Object.keys(store).flatMap((id) => channel(store, id).pending.map((request) => ({ channelId: id, request })));
}

export function listApproved(channelId?: string): { channelId: string; userId: string }[] {
  const store = read();
  return Object.entries(store)
    .filter(([id]) => !channelId || id === channelId)
    .flatMap(([id, ch]) => ch.approved.map((userId) => ({ channelId: id, userId })));
}

/** 按配对码批准。码在所有渠道里找，找到哪个算哪个。 */
export function approve(code: string): { ok: true; channelId: string; request: PairRequest } | { ok: false } {
  const store = read();
  const normalized = code.trim().toUpperCase();
  for (const channelId of Object.keys(store)) {
    const ch = channel(store, channelId);
    const index = ch.pending.findIndex((p) => p.code === normalized);
    if (index === -1) continue;
    const [request] = ch.pending.splice(index, 1);
    if (!request) continue;
    if (!ch.approved.includes(request.userId)) ch.approved.push(request.userId);
    writeJsonAtomic(storePath, store);
    pairingEvents.emit("approved", channelId, request);
    return { ok: true, channelId, request };
  }
  return { ok: false };
}

export function revoke(channelId: string, userId: string): boolean {
  const store = read();
  const ch = channel(store, channelId);
  const normalized = userId.trim().toLowerCase();
  const before = ch.approved.length;
  ch.approved = ch.approved.filter((id) => id !== normalized);
  writeJsonAtomic(storePath, store);
  return ch.approved.length !== before;
}

/**
 * 终端里另一个进程批准的，本进程靠监听文件得知。
 * 回调收到的是「新出现的已批准用户」。
 */
export function watchPairing(onApproved: (channelId: string, userId: string, chatId?: string) => void): void {
  let known = new Set(listApproved().map((a) => `${a.channelId}|${a.userId}`));
  // 批准时 pending 里的那条已经被删了，chatId 得提前记下来
  const chats = new Map<string, string>();
  for (const { channelId, request } of listPending()) chats.set(`${channelId}|${request.userId}`, request.chatId);
  pairingEvents.on("requested", (channelId, request) => chats.set(`${channelId}|${request.userId}`, request.chatId));
  pairingEvents.on("approved", (channelId, request) => {
    known.add(`${channelId}|${request.userId}`);
    onApproved(channelId, request.userId, request.chatId);
  });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(storePath)) writeJsonAtomic(storePath, {});
    fs.watch(dataDir, { persistent: false }, (_event, file) => {
      if (file !== "pairing.json") return;
      const current = listApproved();
      for (const a of current) {
        const id = `${a.channelId}|${a.userId}`;
        if (!known.has(id)) onApproved(a.channelId, a.userId, chats.get(id));
      }
      known = new Set(current.map((a) => `${a.channelId}|${a.userId}`));
    });
  } catch {
    // 监听不了就只认本进程里的批准
  }
}
