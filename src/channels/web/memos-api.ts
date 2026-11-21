import { memoFile } from "./memo-file.js";
import { clearMemoIndex, memoIndexStatus, refreshMemoIndex, syncMemoIndexAccess } from "../../core/memo-index.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { invalidateMemo, joinMemo, pullMemo, pushMemo, withMemoLock } from "./memo-collab.js";
import { posix } from "node:path";
import { addMemoSource, canReadMemo, parseMemoAccess, setMemoAccess, memberAccess, memoHistoryKey, memoSources, parseMemoSource, sourceSettings, removeMemoSource, setMemoSharing, validMemoPath, visibleMemoSources, type MemoAccess } from "../../core/memo-sources.js";
import { canUseExpert } from "../../core/experts.js";
import { memoVersions, memoVersionText } from "../../core/memo-versions.js";
import { sniff } from "../../core/uploads.js";
import { getUser, isAdmin, listUsers, type User } from "../../core/users.js";
import { HttpError, readBody, readJsonBody, SECURITY_HEADERS, sendJson } from "./http.js";
import { editable, IMAGE_LIMIT, MemoStorage, TEXT_LIMIT } from "./memo-storage.js";

function parseExpertAccess(value: unknown, owner: string, previous: Record<string, MemoAccess> = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "专家权限无效");
  return Object.fromEntries(Object.entries(value).map(([id, access]) => {
    if (!Object.hasOwn(previous, id) && !canUseExpert(owner, id)) throw new HttpError(400, "专家不可用，请刷新后重试");
    return [id, parseMemoAccess(access)] as const;
  }));
}

export async function handleMemosApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User, current: () => User | undefined) {
  const action = url.pathname.slice("/api/memos/".length);
  const method = req.method;
  if (action === "sources" && method === "GET") return sendJson(res, 200, visibleMemoSources(user));
  if (action === "sources" && method === "POST") {
    const body = await readJsonBody(req, 16_384);
    let source;
    try {
      source = parseMemoSource(body);
      if (body.expertAccess !== undefined) source.expertAccess = parseExpertAccess(body.expertAccess, user.id);
    }
    catch (err) { throw new HttpError(400, err instanceof Error ? err.message : "数据源配置无效"); }
    await new MemoStorage(source, isAdmin(user)).list("");
    addMemoSource(user.id, source);
    if (canReadMemo(source)) void refreshMemoIndex(user.id, source);
    return sendJson(res, 201, sourceSettings(source));
  }
  const owner = getUser(url.searchParams.get("owner") ?? user.id);
  const id = url.searchParams.get("source");
  if (!owner || owner.disabled) throw new HttpError(404, "笔记库不存在");
  const mine = owner.id === user.id;
  const ownerId = owner.id;
  const ownerRole = owner.role;
  const writing = method !== "GET";
  function authorize() {
    const source = memoSources(ownerId).find(s => s.id === id);
    if (!source) throw new HttpError(404, "笔记库不存在");
    if (!mine) {
      const permission = memberAccess(source, user.id);
      if (!permission) throw new HttpError(404, "笔记库不存在或共享已撤回");
      if (!["tree", "file", "changes", "history", "image", "folder", "attachment"].includes(action)) throw new HttpError(403, "只有库主可以管理笔记库");
      if (writing && permission !== "write") throw new HttpError(403, "此笔记库共享为只读");
    }
    return source;
  }
  const source = authorize();
  const checkAccess = () => {
    const active = current(), activeOwner = getUser(owner.id);
    if (active?.id !== user.id || active.disabled || active.role !== user.role || !activeOwner || activeOwner.disabled || activeOwner.role !== ownerRole) throw new HttpError(403, "笔记库访问权限已变更");
    return authorize();
  };
  if (action === "sharing" && method === "GET") {
    const members = listUsers().filter(u => u.id !== user.id && (!u.disabled || memberAccess(source, u.id)));
    return sendJson(res, 200, members.map(u => ({ id: u.id, name: u.name, disabled: u.disabled, access: memberAccess(source, u.id) ?? "off" })));
  }
  if (action === "sharing" && method === "PUT") {
    const body = await readJsonBody(req, 65_536);
    checkAccess();
    try { setMemoSharing(owner.id, source.id, body?.changes); }
    catch (err) { throw new HttpError(400, err instanceof Error ? err.message : "共享设置无效"); }
    return sendJson(res, 200, { ok: true });
  }
  if (action === "sources" && method === "DELETE") {
    clearMemoIndex(user.id, source.id);
    removeMemoSource(user.id, source.id);
    return sendJson(res, 200, { ok: true });
  }
  if (action === "access" && method === "GET") return sendJson(res, 200, sourceSettings(source));
  if (action === "access" && method === "PUT") {
    const body = await readJsonBody(req, 65_536);
    const latest = memoSources(user.id).find(s => s.id === source.id);
    if (!latest) throw new HttpError(404, "笔记库不存在");
    let access, expertAccess;
    try {
      access = parseMemoAccess(body.access);
      // Older clients only send the library-wide setting. Their off switch revokes all grants.
      expertAccess = body.defaultOnly === true ? latest.expertAccess ?? {}
        : body.expertAccess === undefined ? (access === "off" ? {} : latest.expertAccess ?? {})
        : parseExpertAccess(body.expertAccess, user.id, latest.expertAccess);
    } catch (err) { throw new HttpError(400, err instanceof Error ? err.message : "智能体访问权限无效"); }
    const updated = setMemoAccess(user.id, source.id, access, expertAccess);
    syncMemoIndexAccess(user.id, latest, updated);
    return sendJson(res, 200, sourceSettings(updated));
  }
  if (action === "index" && (method === "GET" || method === "POST")) {
    if (method === "POST" && canReadMemo(source)) void refreshMemoIndex(user.id, source);
    return sendJson(res, 200, memoIndexStatus(user.id, source.id));
  }
  const storage = new MemoStorage(source, isAdmin(owner));
  const path = url.searchParams.get("path") ?? "";
  const listing = action === "tree" && method === "GET";
  if (!(listing && path === "") && !validMemoPath(path)) throw new HttpError(400, "笔记路径无效");
  if (listing) {
    const page = await storage.list(path, url.searchParams.get("cursor") ?? "");
    checkAccess();
    return sendJson(res, 200, page);
  }
  if (action === "folder" && method === "POST") {
    await storage.mkdir(path);
    return sendJson(res, 201, { ok: true });
  }
  if (action === "image" && method === "GET") {
    if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) throw new HttpError(415, "不支持此图片格式");
    const { bytes } = await storage.read(path, IMAGE_LIMIT);
    checkAccess();
    const type = sniff(bytes)?.mediaType;
    if (!type?.startsWith("image/")) throw new HttpError(415, "图片格式无效");
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "private, no-store" });
    res.end(bytes);
    return;
  }
  if (!editable(path)) throw new HttpError(415, "此格式暂不支持编辑");
  if (action === "history" && method === "GET") {
    const id = url.searchParams.get("id");
    if (id === null) return sendJson(res, 200, memoVersions(owner.id, memoHistoryKey(source), path));
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new HttpError(400, "版本编号无效");
    const text = memoVersionText(owner.id, memoHistoryKey(source), path, Number(id));
    if (text === null) throw new HttpError(404, "历史版本不存在");
    return sendJson(res, 200, { text });
  }
  if (action === "attachment" && method === "POST") {
    const bytes = await readBody(req, IMAGE_LIMIT);
    checkAccess();
    const type = sniff(bytes);
    if (!type?.mediaType.startsWith("image/")) throw new HttpError(415, "请选择 PNG、JPEG、GIF 或 WebP 图片");
    const dir = posix.join(posix.dirname(path), "assets");
    const name = `image-${randomUUID()}.${type.ext}`;
    await storage.mkdir(dir, true);
    checkAccess();
    await storage.put(posix.join(dir, name), bytes, type.mediaType, null);
    return sendJson(res, 201, { relative: "assets/" + name });
  }
  const joining = url.searchParams.get("collab") === "1";
  const { lockKey, key, account, persist, read } = memoFile(user, source, path, checkAccess, owner);
  if (action === "changes") {
    const token = String(req.headers["x-memo-client"] ?? "");
    const since = Number(url.searchParams.get("since") ?? NaN);
    if (method === "GET") {
      const result = await pullMemo(key, token, account, since, res);
      if (!result) return;
      const activeSource = checkAccess();
      return sendJson(res, 200, mine ? result : { ...result, permission: memberAccess(activeSource, user.id) });
    }
    if (method === "POST") {
      const body = await readJsonBody(req, TEXT_LIMIT * 8);
      const result = await withMemoLock(lockKey, () => {
        checkAccess();
        return pushMemo(key, token, account, since, body?.updates, persist);
      });
      checkAccess();
      return sendJson(res, 200, result);
    }
  }
  if (action === "file" && method === "GET") {
    const result = await withMemoLock(lockKey, async () => {
      const { text, version } = await read();
      checkAccess();
      return { text, version, collab: joining ? joinMemo(key, account, text, version) : undefined };
    });
    return sendJson(res, 200, result);
  }
  if (action === "file" && method === "PUT") {
    const data = await readJsonBody(req, TEXT_LIMIT * 6 + 1024);
    const { text, version } = data ?? {};
    if (typeof text !== "string" || text.includes("\0") || (version !== null && typeof version !== "string")) throw new HttpError(400, "正文或版本无效");
    const result = await withMemoLock(lockKey, async () => {
      const saved = await persist(text, version);
      invalidateMemo(key);
      return { version: saved, collab: joining ? joinMemo(key, account, text, saved) : undefined };
    });
    return sendJson(res, 200, result);
  }
  throw new HttpError(404, "备忘录操作不存在");
}
