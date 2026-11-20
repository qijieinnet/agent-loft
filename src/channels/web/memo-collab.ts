// The revision advances only after the merged text has reached the remote file.
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Text, ChangeSet } from "@codemirror/state";
import { rebaseUpdates, type Update } from "@codemirror/collab";
import { HttpError } from "./http.js";
import { TEXT_LIMIT } from "./memo-storage.js";

type Client = { id: string; account: string; seen: number; joined: number; waiting?: () => void };
type Room = {
  doc: Text; crlf: boolean; version: string; offset: number; log: Update[];
  cost: number[]; totalCost: number; clients: Map<string, Client>;
  wake: Set<() => void>; seen: number; writing: boolean;
};
const rooms = new Map<string, Room>();
const locks = new Map<string, Promise<void>>();
const expiry = 10 * 60_000;
const expired = () => new HttpError(409, "协作版本已更新，请重新打开文件；未同步的内容可另存副本");

export async function withMemoLock<T>(key: string, task: () => Promise<T>) {
  const previous = locks.get(key);
  let release!: () => void;
  const next = new Promise<void>(r => { release = r; });
  locks.set(key, next);
  try { await previous; return await task(); }
  finally { release(); if (locks.get(key) === next) locks.delete(key); }
}

function wake(room: Room) { for (const resolve of room.wake) resolve(); }
export function invalidateMemo(key: string) {
  const room = rooms.get(key);
  rooms.delete(key);
  if (room) wake(room);
}
export function closeMemoRooms() { for (const key of rooms.keys()) invalidateMemo(key); }
const sweep = setInterval(() => {
  const cutoff = Date.now() - expiry;
  for (const [key, room] of rooms) {
    for (const [id, c] of room.clients) if (c.seen < cutoff) room.clients.delete(id);
    if (room.seen < cutoff && !room.writing) invalidateMemo(key);
  }
}, 60_000);
sweep.unref();

export function joinMemo(key: string, account: string, text: string, version: string) {
  let room = rooms.get(key);
  if (!room || room.version !== version || room.doc.sliceString(0, room.doc.length, room.crlf ? "\r\n" : "\n") !== text) {
    invalidateMemo(key);
    if (rooms.size >= 128) {
      const idle = [...rooms].filter(([,r]) => !r.writing && !r.wake.size).sort((a,b) => a[1].seen - b[1].seen)[0];
      if (!idle) throw new HttpError(503, "协作文件较多，请稍后重试");
      invalidateMemo(idle[0]);
    }
    const crlf = text.includes("\r\n") && !/[\r\n]/.test(text.replace(/\r\n/g, ""));
    room = { doc: Text.of(text.split(crlf ? "\r\n" : "\n")), crlf, version, offset: 0, log: [], cost: [],
      totalCost: 0, clients: new Map(), wake: new Set(), seen: Date.now(), writing: false };
    rooms.set(key, room);
  }
  room.seen = Date.now();
  const token = randomUUID(), clientID = randomUUID();
  const startVersion = room.offset + room.log.length;
  room.clients.set(token, { account, id: clientID, seen: room.seen, joined: startVersion });
  return { token, clientID, crlf: room.crlf, startVersion };
}

function access(key: string, token: string, account: string, since: number) {
  const room = rooms.get(key), client = room?.clients.get(token);
  if (!room || !client || client.account !== account) throw expired();
  if (!Number.isSafeInteger(since) || since < Math.max(client.joined, room.offset) || since > room.offset + room.log.length) throw expired();
  client.seen = room.seen = Date.now();
  return { room, client };
}

function packet(room: Room, since: number) {
  return { from: since, updates: room.log.slice(since - room.offset), version: room.version };
}

export async function pullMemo(key: string, token: string, account: string, since: number, res: ServerResponse) {
  const { room, client } = access(key, token, account, since);
  if (!res.destroyed && since === room.offset + room.log.length) {
    await new Promise<void>(resolve => {
      client.waiting?.();
      const done = () => {
        clearTimeout(timer);
        room.wake.delete(done);
        res.off("close", done);
        client.waiting = undefined;
        resolve();
      };
      const timer = setTimeout(done, 20_000);
      client.waiting = done;
      room.wake.add(done);
      res.once("close", done);
    });
  }
  if (res.destroyed) return;
  access(key, token, account, since);
  return packet(room, since);
}

function decodeChanges(raw: unknown, length: number) {
  if (!Array.isArray(raw) || raw.length > 100_000) throw new Error();
  for (const section of raw) {
    const count = Array.isArray(section) ? section[0] : section;
    if (!Number.isSafeInteger(count) || count < 0 || count > TEXT_LIMIT ||
      (Array.isArray(section) && section.slice(1).some(line => typeof line !== "string" || /[\n\0]/.test(line)))) throw new Error();
  }
  const changes = ChangeSet.fromJSON(raw);
  if (changes.length !== length || changes.newLength > TEXT_LIMIT) throw new Error();
  return changes;
}

// Called inside the same per-file lock as full-document opens and saves.
export async function pushMemo(key: string, token: string, account: string, since: number, raw: unknown,
  persist: (text: string, version: string, expected: string) => Promise<string>) {
  const { room, client } = access(key, token, account, since);
  const over = room.log.slice(since - room.offset);
  if (!Array.isArray(raw) || !raw.length || raw.length > 128) throw new HttpError(400, "协作修改批次无效");
  let length = over[0]?.changes.length ?? room.doc.length;
  let accepted: readonly Update[], doc = room.doc;
  try {
    const updates = raw.map(value => {
      const changes = decodeChanges(value, length);
      length = changes.newLength;
      return { clientID: client.id, changes };
    });
    accepted = rebaseUpdates(updates, over);
    for (const update of accepted) doc = update.changes.apply(doc);
  } catch { throw new HttpError(400, "协作修改与文档不匹配"); }
  if (!accepted.length) return packet(room, since);
  const text = doc.sliceString(0, doc.length, room.crlf ? "\r\n" : "\n");
  if (/[\uD800-\uDFFF]/u.test(text)) throw new HttpError(400, "协作修改拆开了 Unicode 字符");
  if (Buffer.byteLength(text) > TEXT_LIMIT) throw new HttpError(413, "文本上限为 2 MB");
  room.writing = true;
  try { room.version = await persist(text, room.version, room.doc.sliceString(0, room.doc.length, room.crlf ? "\r\n" : "\n")); }
  catch (err) {
    if (err instanceof HttpError && [409,404].includes(err.status)) invalidateMemo(key);
    throw err;
  } finally { room.writing = false; }
  room.doc = doc;
  for (const update of accepted) {
    room.log.push(update);
    const bytes = Buffer.byteLength(JSON.stringify(update));
    room.cost.push(bytes);
    room.totalCost += bytes;
  }
  const result = packet(room, since);
  while (room.log.length > accepted.length && (room.log.length > 1024 || room.totalCost > 4 * TEXT_LIMIT)) {
    room.log.shift();
    room.totalCost -= room.cost.shift()!;
    room.offset++;
  }
  wake(room);
  return result;
}

// Called under the file lock after reading the current remote version. Use the
// same change log as the editors so their pending keystrokes can be rebased.
export async function editMemoRange(key: string, account: string, original: string, version: string,
  start: number, end: number, insert: string, persist: (text: string, version: string, expected: string) => Promise<string>) {
  const room = rooms.get(key);
  const separator = room?.crlf ? "\r\n" : "\n";
  const matching = room && room.doc.sliceString(0, room.doc.length, separator) === original;
  // Some servers supply an ETag on GET but omit it on PUT. The same text
  // can then have two revision representations while an editor stays open.
  const crlf = matching ? room.crlf : original.includes("\r\n") && !/[\r\n]/.test(original.replaceAll("\r\n", ""));
  if (crlf) insert = insert.replace(/\r?\n/g, "\r\n");
  const text = original.slice(0, start) + insert + original.slice(end);
  if (!matching) {
    const saved = await persist(text, version, original);
    if (room) invalidateMemo(key);
    return saved;
  }
  room.version = version;
  const pos = (offset: number) => Text.of(original.slice(0, offset).split(separator)).length;
  const change = ChangeSet.of({ from: pos(start), to: pos(end), insert: Text.of(insert.split(separator)) }, room.doc.length);
  if (change.apply(room.doc).sliceString(0, change.newLength, separator) !== text) throw new HttpError(409, "修改位置与协作文档不匹配，请重新读取");
  const client = joinMemo(key, account, original, version);
  try {
    const result = await pushMemo(key, client.token, account, client.startVersion, [change.toJSON()], persist);
    return result.version;
  } finally { rooms.get(key)?.clients.delete(client.token); }
}
