// Bot 自有的话题、成员和消息。这里的 id 从不交给工作台的 CLI 会话、文件或记忆接口。
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, transaction } from "./db.js";
import { clearRevokedActivities, eraseBot, handOverBot } from "./web-bot-retention.js";
import { getUser, userEvents } from "./users.js";

export class WebBotError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const BOT_CAPABILITIES = ["reminders", "followups", "delegation", "memory"] as const;
export type BotCapability = typeof BOT_CAPABILITIES[number];
export type BotView = {
  id: string; name: string; ownerId: string; isDefault: boolean;
  privateThreadId: string; sharedThreadId: string | null; hasArchives: boolean;
  members: { id: string; name: string }[]; capabilities: BotCapability[];
};
export type BotThread = { id: string; botId: string; scope: "private" | "shared"; accessId: string };
export type BotImage = { name: string; mediaType: string; data: string; sanitized?: 1 };
export type BotMessage = {
  id: number; role: "user" | "assistant"; authorId: string | null; authorName: string | null;
  text: string; createdAt: number; images: (Omit<BotImage, "data"> & { data?: string })[];
  status: "pending" | "done" | "failed"; requestId: string | null;
};

let hasStartedBotWork = false;
// 即使账号随后又被启用，旧授权下开始的回复也应当失效。
userEvents.on("changed", (accessChanged) => {
  if (hasStartedBotWork && accessChanged) recoverPendingBotTurns();
});

function activeUser(userId: string) {
  const user = getUser(userId);
  if (!user || user.disabled || sql("SELECT 1 FROM web_bot_retired_users WHERE user=?").get(userId)) throw new WebBotError(403, "这个账号暂时无法使用 Bot。");
  return user;
}
function missing(): never { throw new WebBotError(404, "找不到有权使用的 Bot 或对话。"); }
function nameOf(name: string) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 60) throw new WebBotError(400, "请输入 1 到 60 个字的名字。");
  return name.trim();
}
export function requireOwner(userId: string, botId: string) {
  activeUser(userId);
  if (!sql("SELECT 1 FROM web_bots WHERE id=? AND owner=?").get(botId, userId)) missing();
}

function addMember(botId: string, userId: string) {
  sql("INSERT OR IGNORE INTO web_bot_members (bot,user,access_id) VALUES (?,?,?)").run(botId, userId, randomUUID());
  sql("INSERT OR IGNORE INTO web_bot_threads (id,bot,private_user) VALUES (?,?,?)").run(randomUUID(), botId, userId);
}
function insertBot(userId: string, name: string, isDefault: boolean) {
  const id = randomUUID();
  sql("INSERT INTO web_bots (id,name,owner,default_bot,created) VALUES (?,?,?,?,?)")
    .run(id, name, userId, Number(isDefault), Date.now());
  addMember(id, userId);
  return id;
}

export function getBot(userId: string, botId: string): BotView {
  activeUser(userId);
  const row = sql(`SELECT b.id,b.name,b.owner AS ownerId,b.default_bot AS isDefault,
      b.shared_thread AS sharedThreadId,p.id AS privateThreadId,profile.capabilities,
      EXISTS(SELECT 1 FROM web_bot_archives a JOIN web_bot_threads t ON t.id=a.thread WHERE t.bot=b.id AND a.owner=m.user) AS hasArchives
    FROM web_bots b JOIN web_bot_members m ON m.bot=b.id AND m.user=?
    JOIN web_bot_threads p ON p.bot=b.id AND p.private_user=m.user
    LEFT JOIN web_bot_profiles profile ON profile.bot=b.id WHERE b.id=?`).get(userId, botId);
  if (!row) missing();
  const owner = getUser(String(row.ownerId));
  if (!owner || owner.disabled) missing();
  const members = sql("SELECT user FROM web_bot_members WHERE bot=? ORDER BY rowid").all(botId).flatMap(({ user }) => {
    const member = getUser(String(user));
    return member && !member.disabled ? [{ id: member.id, name: member.name }] : [];
  });
  return { id: String(row.id), name: String(row.name), ownerId: owner.id, isDefault: !!row.isDefault && userId === owner.id,
    capabilities: row.capabilities == null ? [...BOT_CAPABILITIES] : JSON.parse(String(row.capabilities)) as BotCapability[],
    privateThreadId: String(row.privateThreadId), hasArchives: !!row.hasArchives, sharedThreadId: row.sharedThreadId === null ? null : String(row.sharedThreadId), members };
}
type ConversationPreview = { text: string; createdAt: number };
export function listBots(userId: string): (BotView & { previews: Record<string, ConversationPreview> })[] {
  activeUser(userId);
  const ownDefault = sql("SELECT id FROM web_bots WHERE owner=? AND default_bot=1");
  if (!ownDefault.get(userId)) transaction(() => {
    activeUser(userId);
    if (!ownDefault.get(userId)) insertBot(userId, "我的助手", true);
  });
  return sql(`SELECT b.id,b.owner FROM web_bot_members m JOIN web_bots b ON b.id=m.bot WHERE m.user=?
    ORDER BY (b.owner=m.user AND b.default_bot=1) DESC,b.created,b.id`).all(userId).flatMap(row => {
    const owner = getUser(String(row.owner));
    if (!owner || owner.disabled) return [];
    const bot = getBot(userId, String(row.id));
    // Only the caller's private thread and the current shared thread may appear in their list.
    const latest = sql(`SELECT thread, substr(text,1,120) AS text, createdAt, images <> '[]' AS hasPhoto
      FROM web_bot_messages WHERE id IN (
        (SELECT id FROM web_bot_messages WHERE thread=? ORDER BY id DESC LIMIT 1),
        (SELECT id FROM web_bot_messages WHERE thread=? ORDER BY id DESC LIMIT 1))`)
      .all(bot.privateThreadId, bot.sharedThreadId);
    const previews: Record<string, ConversationPreview> = {};
    for (const item of latest) previews[String(item.thread)] = {
      text: String(item.text) || (item.hasPhoto ? "照片" : ""), createdAt: Number(item.createdAt),
    };
    return [{ ...bot, previews }];
  });
}
export function createBot(userId: string, name: string): BotView {
  activeUser(userId);
  return transaction(() => getBot(userId, insertBot(userId, nameOf(name), false)));
}
export function renameBot(userId: string, botId: string, name: string): BotView {
  return transaction(() => {
    requireOwner(userId, botId);
    sql("UPDATE web_bots SET name=? WHERE id=?").run(nameOf(name), botId);
    return getBot(userId, botId);
  });
}

function digest(token: string) { return createHash("sha256").update(token).digest("hex"); }
function findInvite(token: string): { botId: string; ownerId: string } | undefined {
  if (typeof token !== "string" || !/^[\w-]{43}$/.test(token)) return;
  const invite = sql(`SELECT i.bot,b.owner,i.ownerRevision FROM web_bot_invites i JOIN web_bots b ON b.id=i.bot
    WHERE i.digest=? AND i.expires>? AND b.shared_thread IS NOT NULL`).get(digest(token), Date.now());
  if (!invite) return;
  const owner = getUser(String(invite.owner));
  if (owner && !owner.disabled && (owner.botAccessRevision ?? 0) === invite.ownerRevision)
    return { botId: String(invite.bot), ownerId: owner.id };
}
export function validBotInvite(token: string): boolean {
  return !!findInvite(token);
}
export function createInvite(userId: string, botId: string): { token: string; expiresAt: number } {
  return transaction(() => {
    requireOwner(userId, botId);
    if (!sql("SELECT shared_thread FROM web_bots WHERE id=?").get(botId)?.shared_thread) {
      const sharedThreadId = randomUUID();
      sql("INSERT INTO web_bot_threads (id,bot,private_user) VALUES (?,?,NULL)").run(sharedThreadId, botId);
      sql("UPDATE web_bots SET shared_thread=? WHERE id=?").run(sharedThreadId, botId);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 24 * 60 * 60_000;
    // 只有最新链接有效；数据库和备份只保存摘要。
    sql("INSERT OR REPLACE INTO web_bot_invites (digest,bot,expires,ownerRevision) VALUES (?,?,?,?)")
      .run(digest(token), botId, expiresAt, activeUser(userId).botAccessRevision ?? 0);
    return { token, expiresAt };
  });
}
export function acceptInvite(userId: string, token: string): BotView {
  activeUser(userId);
  return transaction(() => {
    const invite = findInvite(token);
    if (!invite) throw new WebBotError(404, "邀请已经失效，请让对方重新邀请。");
    const { botId, ownerId } = invite;
    if (userId === ownerId) throw new WebBotError(400, "这是你自己的邀请。");
    if (sql("SELECT 1 FROM web_bot_members WHERE bot=? AND user=?").get(botId, userId)) return getBot(userId, botId);
    sql("DELETE FROM web_bot_invites WHERE bot=?").run(botId);
    addMember(botId, userId);
    return getBot(userId, botId);
  });
}
export function removeMember(userId: string, botId: string, memberId: string): void {
  transaction(() => {
    requireOwner(userId, botId);
    if (memberId === userId) throw new WebBotError(400, "不能移除 Bot 的所有者。");
    if (!sql("DELETE FROM web_bot_members WHERE bot=? AND user=?").run(botId, memberId).changes) return;
    clearRevokedActivities(botId, userId, memberId);
    interruptTurns("thread IN (SELECT id FROM web_bot_threads WHERE bot=?) AND authorId=?", [botId, memberId]);
    sql("DELETE FROM web_bot_invites WHERE bot=?").run(botId);
  });
}
export function leaveBot(userId: string, botId: string): void {
  transaction(() => {
    const bot = getBot(userId, botId);
    if (bot.ownerId === userId) throw new WebBotError(409, "请先移交 Bot，再退出。");
    removeMember(bot.ownerId, botId, userId);
  });
}

export function transferBot(userId: string, botId: string, successor: string): BotView {
  return transaction(() => {
    requireOwner(userId, botId);
    if (successor === userId || !getBot(userId, botId).members.some(m => m.id === successor)) {
      throw new WebBotError(400, "请选择一位可用的共用成员。");
    }
    handOverBot(botId, successor);
    return getBot(userId, botId);
  });
}

export function deleteOwnedBot(userId: string, botId: string): void {
  transaction(() => {
    requireOwner(userId, botId);
    eraseBot(botId);
  });
}

export function stopSharing(userId: string, botId: string): BotView {
  return transaction(() => {
    requireOwner(userId, botId);
    clearRevokedActivities(botId, userId);
    interruptTurns("thread IN (SELECT id FROM web_bot_threads WHERE bot=? AND (private_user IS NULL OR private_user<>?))", [botId, userId]);
    sql("DELETE FROM web_bot_members WHERE bot=? AND user<>?").run(botId, userId);
    sql("DELETE FROM web_bot_invites WHERE bot=?").run(botId);
    sql(`INSERT OR IGNORE INTO web_bot_archives(thread,owner,archivedAt)
      SELECT shared_thread,owner,? FROM web_bots WHERE id=? AND shared_thread IS NOT NULL`).run(Date.now(), botId);
    // 旧共享话题封存，再次邀请时会建新的；新成员不会意外读到上一轮的历史。
    sql("UPDATE web_bots SET shared_thread=NULL WHERE id=?").run(botId);
    return getBot(userId, botId);
  });
}

export function getBotThread(userId: string, threadId: string): BotThread {
  const user = activeUser(userId);
  const row = sql(`SELECT t.id,b.id AS botId,b.owner,t.private_user,m.access_id
    FROM web_bot_threads t JOIN web_bots b ON b.id=t.bot
    JOIN web_bot_members m ON m.bot=b.id AND m.user=?
    WHERE t.id=? AND (t.private_user=m.user OR (t.private_user IS NULL AND b.shared_thread=t.id))`).get(userId, threadId);
  if (!row) missing();
  const owner = getUser(String(row.owner));
  if (!owner || owner.disabled) missing();
  const previous = String(row.access_id);
  const [membership, stamp = "0:0"] = previous.split("@");
  const [lastUser, lastOwner] = stamp.split(":");
  // 另一进程可能已观察到更新的账号权限，短时间内不能用旧 users.json 缓存把授权退回。
  const userRevision = Math.max(Number(lastUser), user.botAccessRevision ?? 0);
  const ownerRevision = Math.max(Number(lastOwner), owner.botAccessRevision ?? 0);
  const accessId = userRevision || ownerRevision ? `${membership}@${userRevision}:${ownerRevision}` : membership!;
  if (accessId !== previous) {
    // 跨进程的账号修改也能让旧授权失效。收件箱可以直接关联这里更新后的值。
    const changed = sql("UPDATE web_bot_members SET access_id=? WHERE bot=? AND user=? AND access_id=?")
      .run(accessId, String(row.botId), userId, previous).changes;
    if (!changed) return getBotThread(userId, threadId);
  }
  return { id: threadId, botId: String(row.botId), scope: row.private_user === null ? "shared" : "private", accessId };
}

const MESSAGE_FIELDS = "id,role,authorId,authorName,text,createdAt,images,status,requestId";
function message(row: Record<string, unknown>): BotMessage {
  return { id: Number(row.id), role: row.role as BotMessage["role"], authorId: row.authorId as string | null,
    authorName: row.authorName as string | null, text: String(row.text), createdAt: Number(row.createdAt),
    images: JSON.parse(String(row.images)) as BotMessage["images"], status: row.status as BotMessage["status"], requestId: row.requestId as string | null };
}
export function listMessages(userId: string, threadId: string, limit = 100, before?: number): BotMessage[] {
  getBotThread(userId, threadId);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(before ?? 0)) throw new WebBotError(400, "消息页参数无效。");
  recoverPendingBotTurns(threadId);
  return sql(`SELECT ${MESSAGE_FIELDS} FROM web_bot_messages WHERE thread=? AND id<? ORDER BY id DESC LIMIT ?`)
    .all(threadId, before ?? Number.MAX_SAFE_INTEGER, Math.min(limit, 200)).reverse().map(message);
}
export function getBotMessage(userId: string, threadId: string, messageId: number): BotMessage | undefined {
  getBotThread(userId, threadId);
  const row = sql(`SELECT ${MESSAGE_FIELDS} FROM web_bot_messages WHERE thread=? AND id=?`).get(threadId, messageId);
  if (!row) return;
  const result = message(row);
  if (result.images.length) {
    const data = sql("SELECT content FROM web_bot_images WHERE message=?").get(messageId);
    if (data) result.images = JSON.parse(String(data.content)) as BotImage[];
  }
  return result;
}
export function retryableBotMessages(userId: string, threadId: string, first: number, last: number): Set<number> {
  const { accessId } = getBotThread(userId, threadId);
  const rows = sql(`SELECT m.id FROM web_bot_messages m WHERE m.thread=? AND m.authorId=? AND m.authorAccess=?
    AND NOT EXISTS (SELECT 1 FROM web_bot_tool_attempts WHERE message=m.id)
    AND m.id BETWEEN ? AND ? AND m.role='user' AND m.status='failed'
    AND NOT EXISTS (SELECT 1 FROM web_bot_messages r WHERE r.thread=m.thread AND r.authorId=m.authorId
      AND r.role='user' AND r.requestId='retry:' || m.id)`).all(threadId, userId, accessId, first, last);
  return new Set(rows.map(row => Number(row.id)));
}

export async function retryBotTurn(userId: string, threadId: string, id: number) {
  const access = getBotThread(userId, threadId).accessId;
  const original = getBotMessage(userId, threadId, id);
  const owned = () => sql(`SELECT 1 FROM web_bot_messages WHERE id=? AND thread=? AND authorId=? AND authorAccess=?
    AND role='user' AND status='failed' AND NOT EXISTS (SELECT 1 FROM web_bot_tool_attempts WHERE message=web_bot_messages.id)`).get(id, threadId, userId, access);
  if (!original || !owned()) throw new WebBotError(404, "这条消息已不可重试。");
  const { sanitizeBotImage } = await import("./web-bot-photo.js");
  const images: BotImage[] = [];
  for (const image of original.images) {
    if (!image.data) throw new WebBotError(404, "原照片已不可用。");
    images.push(await sanitizeBotImage({ ...image, data: image.data }));
  }
  return transaction(() => {
    if (getBotThread(userId, threadId).accessId !== access || !owned()) throw new WebBotError(404, "这条消息已不可重试。");
    return startTurn(userId, threadId, "retry:" + id, original.text, images);
  });
}

function addReply(threadId: string, text: string, status: BotMessage["status"], requestId: string | null) {
  const row = sql(`INSERT INTO web_bot_messages (thread,role,text,createdAt,status,requestId)
     VALUES (?,'assistant',?,?,?,?) RETURNING ${MESSAGE_FIELDS}`).get(threadId, text, Date.now(), status, requestId)!;
  return message(row);
}
export function appendBotNotice(userId: string, threadId: string, text: string): BotMessage {
  getBotThread(userId, threadId);
  return addReply(threadId, text, "done", null);
}

export function toolAttemptNotice(messageId: number) {
  return sql("SELECT 1 FROM web_bot_tool_attempts WHERE message=?").get(messageId)
    ? "外部工具已收到或可能已收到请求，请先核对执行结果。" : "";
}

export function recordToolAttempt(messageId: number, fingerprint: string) {
  const saved = sql(`INSERT OR IGNORE INTO web_bot_tool_attempts(message,fingerprint)
    SELECT id,? FROM web_bot_messages WHERE id=? AND status='pending' AND worker=?`)
    .run(fingerprint, messageId, process.pid);
  if (!saved.changes) throw new WebBotError(409, "该工具调用已处理或本轮已结束。");
}
function failPending(row: Record<string, unknown>) {
  const changed = sql("UPDATE web_bot_messages SET status='failed',worker=NULL WHERE id=? AND status='pending'").run(Number(row.id)).changes;
  if (changed) addReply(String(row.thread), "这次回复已中断。" + (toolAttemptNotice(Number(row.id)) || "可以重新发送。"), "failed", String(row.requestId));
}
function interruptTurns(where: string, parameters: string[]) {
  // where 是调用处编写的固定查询；参数独立绑定。
  const rows = sql(`SELECT id,thread,requestId FROM web_bot_messages WHERE status='pending' AND ${where}`).all(...parameters);
  for (const row of rows) failPending(row);
}
function stillRunning(pid: number, created: number): boolean {
  if (Date.now() - created >= 20 * 60_000) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export function recoverPendingBotTurns(threadId?: string): void {
  const query = "SELECT id,thread,authorId,authorAccess,requestId,worker,createdAt FROM web_bot_messages WHERE status='pending'";
  const rows = threadId ? sql(query + " AND thread=?").all(threadId) : sql(query).all();
  for (const row of rows) {
    if (stillRunning(Number(row.worker), Number(row.createdAt))) {
      try { if (getBotThread(String(row.authorId), String(row.thread)).accessId === row.authorAccess) continue; }
      catch (e) { if (!(e instanceof WebBotError)) throw e; }
    }
    transaction(() => failPending(row));
  }
}
/** 调用者持有写事务；普通轮次和委派尝试共用每人额度与并发配额。 */
export function requireBotTurnCapacity(userId: string, createdAt = Date.now()): void {
  const pending = sql("SELECT count(*) AS total, count(*) FILTER (WHERE actor=?) AS mine FROM (SELECT authorId AS actor FROM web_bot_messages WHERE status='pending' UNION ALL SELECT actor FROM web_bot_delegations WHERE status IN ('queued','running'))").get(userId)!;
  if (Number(pending.total) >= 8 || Number(pending.mine) >= 2) throw new WebBotError(429, "正在处理的消息较多，请稍后再发。");
  // 额度跟着发起人，不能靠换 Bot、话题、设备时区或并发请求绕开。重复 requestId 已在上面返回。
  const rawLimit = process.env.AGENT_LOFT_BOT_DAILY_TURNS?.trim();
  const configuredLimit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  const limit = Number.isSafeInteger(configuredLimit) ? configuredLimit : 100;
  if (limit > 0) {
    const midnight = new Date(createdAt).setHours(0, 0, 0, 0);
    const used = sql("SELECT ((SELECT count(*) FROM web_bot_messages WHERE authorId=? AND role='user' AND createdAt>=?) + (SELECT count(*) FROM web_bot_delegation_attempts WHERE actor=? AND at>=?) + (SELECT count(*) FROM web_bot_deleted_turns WHERE user=? AND at>=?)) AS n").get(userId, midnight, userId, midnight, userId, midnight);
    if (Number(used?.n) >= limit) throw new WebBotError(429, "你今天的 Bot 消息额度已用完，请明天再试。");
  }
}
export function startTurn(userId: string, threadId: string, requestId: string, text: string, images: BotImage[] = []): { message: BotMessage; started: boolean } {
  return transaction(() => {
    const { accessId } = getBotThread(userId, threadId);
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 128) throw new WebBotError(400, "消息标识无效，请重试。");
    if (typeof text !== "string" || text.length > 12_000 || (!text.trim() && !images.length)) throw new WebBotError(400, "请输入不超过 12000 字的消息或选择图片。");
    if (images.length > 1 || images.some(i => typeof i.data !== "string" || i.data.length > 4 * 1024 * 1024)) throw new WebBotError(413, "每次可发送一张不超过 3 MB 的图片。");
    recoverPendingBotTurns();
    const existing = sql(`SELECT ${MESSAGE_FIELDS} FROM web_bot_messages WHERE thread=? AND authorId=? AND requestId=? AND role='user'`).get(threadId, userId, requestId);
    if (existing) return { message: message(existing), started: false };
    if (sql("SELECT 1 FROM web_bot_messages WHERE thread=? AND status='pending'").get(threadId)) throw new WebBotError(409, "上一条还在回复，请稍后再发。");
    const createdAt = Date.now();
    requireBotTurnCapacity(userId, createdAt);
    const meta = images.map(({ name, mediaType }) => ({ name, mediaType }));
    const row = sql(`INSERT INTO web_bot_messages (thread,role,authorId,authorAccess,authorName,text,createdAt,images,status,requestId,worker)
      VALUES (?,'user',?,?,?,?,?,?,'pending',?,?) RETURNING ${MESSAGE_FIELDS}`)
      .get(threadId, userId, accessId, activeUser(userId).name, text, createdAt, JSON.stringify(meta), requestId, process.pid)!;
    hasStartedBotWork = true;
    if (images.length) sql("INSERT INTO web_bot_images (message,content) VALUES (?,?)").run(Number(row.id), JSON.stringify(images));
    return { message: message(row), started: true };
  });
}
export function finishTurn(userId: string, threadId: string, requestId: string, text: string, failed = false, existingAssistantId?: number): BotMessage | undefined {
  return transaction(() => {
    let accessId: string;
    try { accessId = getBotThread(userId, threadId).accessId; }
    catch (e) {
      if (!(e instanceof WebBotError)) throw e;
      interruptTurns("thread=? AND authorId=? AND requestId=?", [threadId, userId, requestId]);
      return;
    }
    const status = failed ? "failed" : "done";
    const result = sql(`UPDATE web_bot_messages SET status=?,worker=NULL WHERE thread=? AND authorId=? AND authorAccess=? AND requestId=? AND status='pending'`)
      .run(status, threadId, userId, accessId, requestId);
    if (!result.changes) return;
    if (existingAssistantId === undefined) return addReply(threadId, text, status, requestId);
    // 跟进操作已在同一事务中产生带推送深链的消息。将它作为本轮答复，保留推送使用的消息 id。
    const notice = sql(`UPDATE web_bot_messages SET requestId=?,status=?,
       text=CASE WHEN ?='' OR text=? THEN text ELSE ? || char(10,10) || text END
       WHERE id=? AND thread=? AND role='assistant' AND requestId IS NULL RETURNING ${MESSAGE_FIELDS}`)
      .get(requestId, status, text.trim(), text.trim(), text.trim(), existingAssistantId, threadId);
    if (!notice) throw new Error("跟进消息与本次会话不匹配");
    return message(notice);
  });
}
