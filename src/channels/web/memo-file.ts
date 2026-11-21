import { createHash } from "node:crypto";
import { canReadMemo, memoHistoryKey, memoSources, validMemoPath, type MemoSource } from "../../core/memo-sources.js";
import { indexSavedMemo } from "../../core/memo-index.js";
import { rememberMemoVersion } from "../../core/memo-versions.js";
import { isAdmin, type User } from "../../core/users.js";
import { HttpError } from "./http.js";
import { editable, MemoStorage, TEXT_LIMIT } from "./memo-storage.js";

export function memoFile(user: User, source: MemoSource, path: string, check: () => void, owner = user) {
  if (!validMemoPath(path) || !editable(path)) throw new HttpError(400, "请选择可编辑的文本文件");
  const storage = new MemoStorage(source, isAdmin(owner));
  const lockKey = storage.objectURL(path).href;
  const key = createHash("sha256").update(JSON.stringify([source.kind, lockKey, source.username, source.secret])).digest("hex");
  const account = JSON.stringify([user.id, source.id, user.role]);
  const persist = async (text: string, version: string | null, expected?: string) => {
    check();
    if (typeof text !== "string" || text.includes("\0") || /[\uD800-\uDFFF]/u.test(text)) throw new HttpError(400, "正文无效");
    const bytes = Buffer.from(text);
    if (bytes.length > TEXT_LIMIT) throw new HttpError(413, "文本上限为 2 MB");
    const saved = await storage.put(path, bytes, /\.md$/i.test(path) ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8", version, previous => {
      check();
      if (expected !== undefined && !previous.equals(Buffer.from(expected))) throw new HttpError(409, "远端正文已被修改");
      rememberMemoVersion(owner.id, memoHistoryKey(source), path, previous);
    });
    const active = memoSources(owner.id).find(s => s.id === source.id);
    if (active && canReadMemo(active)) indexSavedMemo(owner.id, source.id, path, text, saved);
    return saved;
  };
  return { key, lockKey, account, persist, read: () => storage.readText(path) };
}
