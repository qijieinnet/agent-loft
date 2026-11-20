import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { invalidateMemo, joinMemo, pullMemo, pushMemo, withMemoLock } from "./memo-collab.js";
import { posix } from "node:path";
import { addMemoSource, memoHistoryKey, memoSources, parseMemoSource, publicSource, removeMemoSource, validMemoPath } from "../../core/memo-sources.js";
import { memoVersions, memoVersionText, rememberMemoVersion } from "../../core/memo-versions.js";
import { sniff } from "../../core/uploads.js";
import { isAdmin, type User } from "../../core/users.js";
import { HttpError, readBody, readJsonBody, SECURITY_HEADERS, sendJson } from "./http.js";
import { editable, IMAGE_LIMIT, MemoStorage, TEXT_LIMIT } from "./memo-storage.js";

export async function handleMemosApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User, current: () => User | undefined) {
  const action = url.pathname.slice("/api/memos/".length);
  const method = req.method;
  if (action === "sources" && method === "GET") return sendJson(res, 200, memoSources(user.id).map(publicSource));
  if (action === "sources" && method === "POST") {
    const body = await readJsonBody(req, 16_384);
    let source;
    try { source = parseMemoSource(body); }
    catch (err) { throw new HttpError(400, err instanceof Error ? err.message : "数据源配置无效"); }
    await new MemoStorage(source, isAdmin(user)).list("");
    addMemoSource(user.id, source);
    return sendJson(res, 201, publicSource(source));
  }
  const source = memoSources(user.id).find(s => s.id === url.searchParams.get("source"));
  if (!source) throw new HttpError(404, "笔记库不存在");
  if (action === "sources" && method === "DELETE") {
    removeMemoSource(user.id, source.id);
    return sendJson(res, 200, { ok: true });
  }
  const storage = new MemoStorage(source, isAdmin(user));
  const path = url.searchParams.get("path") ?? "";
  const listing = action === "tree" && method === "GET";
  if (!(listing && path === "") && !validMemoPath(path)) throw new HttpError(400, "笔记路径无效");
  if (listing) return sendJson(res, 200, await storage.list(path, url.searchParams.get("cursor") ?? ""));
  if (action === "folder" && method === "POST") {
    await storage.mkdir(path);
    return sendJson(res, 201, { ok: true });
  }
  if (action === "image" && method === "GET") {
    if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) throw new HttpError(415, "不支持此图片格式");
    const { bytes } = await storage.read(path, IMAGE_LIMIT);
    const type = sniff(bytes)?.mediaType;
    if (!type?.startsWith("image/")) throw new HttpError(415, "图片格式无效");
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "private, no-store" });
    res.end(bytes);
    return;
  }
  if (!editable(path)) throw new HttpError(415, "此格式暂不支持编辑");
  if (action === "history" && method === "GET") {
    const id = url.searchParams.get("id");
    if (id === null) return sendJson(res, 200, memoVersions(user.id, memoHistoryKey(source), path));
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new HttpError(400, "版本编号无效");
    const text = memoVersionText(user.id, memoHistoryKey(source), path, Number(id));
    if (text === null) throw new HttpError(404, "历史版本不存在");
    return sendJson(res, 200, { text });
  }
  if (action === "attachment" && method === "POST") {
    const bytes = await readBody(req, IMAGE_LIMIT);
    const type = sniff(bytes);
    if (!type?.mediaType.startsWith("image/")) throw new HttpError(415, "请选择 PNG、JPEG、GIF 或 WebP 图片");
    const dir = posix.join(posix.dirname(path), "assets");
    const name = `image-${randomUUID()}.${type.ext}`;
    await storage.mkdir(dir, true);
    await storage.put(posix.join(dir, name), bytes, type.mediaType, null);
    return sendJson(res, 201, { relative: "assets/" + name });
  }
  // The same storage identity and relative path identify a shared file across Loft accounts.
  // An editor token is issued only after a successful remote read or write with that account's source.
  const lockKey = storage.objectURL(path).href;
  const key = createHash("sha256").update(JSON.stringify([source.kind, lockKey, source.username, source.secret])).digest("hex");
  const account = JSON.stringify([user.id, source.id, user.role]);
  const joining = url.searchParams.get("collab") === "1";
  const checkAccess = () => {
    const active = current();
    if (active?.id !== user.id || active.role !== user.role || !memoSources(user.id).some(s => s.id === source.id)) throw new HttpError(403, "协作连接已失效");
  };
  const persist = (text: string, version: string | null, expected?: string) =>
    storage.put(path, Buffer.from(text), /\.md$/i.test(path) ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8", version, previous => {
      if (!memoSources(user.id).some(s => s.id === source.id)) throw new HttpError(404, "笔记库已断开");
      if (expected !== undefined && !previous.equals(Buffer.from(expected))) throw new HttpError(409, "远端正文已被修改");
      rememberMemoVersion(user.id, memoHistoryKey(source), path, previous);
    });
  if (action === "changes") {
    const token = String(req.headers["x-memo-client"] ?? "");
    const since = Number(url.searchParams.get("since") ?? NaN);
    if (method === "GET") {
      const result = await pullMemo(key, token, account, since, res);
      if (!result) return;
      checkAccess();
      return sendJson(res, 200, result);
    }
    if (method === "POST") {
      const body = await readJsonBody(req, TEXT_LIMIT * 8);
      const result = await withMemoLock(lockKey, () => {
        checkAccess();
        return pushMemo(key, token, account, since, body?.updates, persist);
      });
      return sendJson(res, 200, result);
    }
  }
  if (action === "file" && method === "GET") {
    const result = await withMemoLock(lockKey, async () => {
      const { bytes, version } = await storage.read(path);
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new HttpError(415, "仅支持 UTF-8 文本"); }
      if (text.includes("\0")) throw new HttpError(415, "此文件包含二进制数据");
      return { text, version, collab: joining ? joinMemo(key, account, text, version) : undefined };
    });
    return sendJson(res, 200, result);
  }
  if (action === "file" && method === "PUT") {
    const data = await readJsonBody(req, TEXT_LIMIT * 6 + 1024);
    const { text, version } = data ?? {};
    if (typeof text !== "string" || text.includes("\0") || (version !== null && typeof version !== "string")) throw new HttpError(400, "正文或版本无效");
    const bytes = Buffer.from(text);
    if (bytes.length > TEXT_LIMIT) throw new HttpError(413, "文本上限为 2 MB");
    const result = await withMemoLock(lockKey, async () => {
      const saved = await persist(text, version);
      invalidateMemo(key);
      return { version: saved, collab: joining ? joinMemo(key, account, text, saved) : undefined };
    });
    return sendJson(res, 200, result);
  }
  throw new HttpError(404, "备忘录操作不存在");
}
