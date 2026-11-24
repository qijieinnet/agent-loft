import type { IncomingMessage, ServerResponse } from "node:http";
import { createUser, removeUser } from "../../core/users.js";
import { sql, transaction } from "../../core/db.js";
import { acceptInvite, validBotInvite, getBot, getBotThread, WebBotError } from "../../core/web-bots.js";
import { applyBotReminder, listBotReminders, hasBotAccess, type ReminderAction } from "../../core/web-bot-reminders.js";
import { failedDelegationId, getBotDelegation } from "../../core/web-bot-delegation.js";
import { botPushDevices } from "./push.js";
import { readJsonBody, HttpError, sendJson } from "./http.js";

export function botDeployment(): boolean {
  return process.env.AGENT_LOFT_WEB_MODE === "bot";
}

export function botApiAllowed(path: string): boolean {
  return (
    [
      "/api/me",
      "/api/login",
      "/api/setup",
      "/api/logout",
      "/api/bot-join",
      "/api/bots",
      "/api/bot-reminders",
      "/api/bot-inbox",
      "/api/bot-inbox/read",
      "/api/bot-inbox/test-device",
      "/api/push",
      "/api/push/subscribe",
      "/api/push/unsubscribe",
    ].includes(path) ||
    path.startsWith("/api/bots/") ||
    path.startsWith("/api/bot-reminders/")
  );
}

type InboxEntry = {
  id: number;
  userId: string;
  threadId: string;
  accessId: string;
  eventId: string;
  messageId: number | null;
  kind: string;
  createdAt: number;
  seen: number;
  botName: string;
};

export async function handleBotInbox(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  userId: string,
  sessionId: string,
): Promise<void> {
  if (url.pathname === "/api/bot-inbox/test-device" && req.method === "POST") {
    const body = await readJsonBody(req, 4096);
    if (typeof body?.threadId !== "string" || typeof body.endpoint !== "string") throw new HttpError(400, "请选择已开启通知的设备。");
    const device = botPushDevices(userId).find(d => d.sessionId === sessionId && d.endpoint === body.endpoint);
    if (!device) throw new HttpError(403, "请在这台设备重新开启通知。");
    try {
      const thread = getBotThread(userId, body.threadId);
      const now = Date.now();
      transaction(() => {
        // One scheduled test per device, even if the user taps twice or switches threads.
        const queued = sql("SELECT 1 FROM bot_notice_devices WHERE kind='test' AND endpoint=? AND sessionId=? AND expiresAt>?")
          .get(device.endpoint, sessionId, now);
        if (!queued) sql(`INSERT INTO bot_notice_devices
          (userId,threadId,accessId,eventId,kind,endpoint,sessionId,nextAt,expiresAt)
          VALUES(?,?,?,?,'test',?,?,?,?)`).run(userId, thread.id, thread.accessId, "test-" + now, device.endpoint, sessionId, now + 15_000, now + 120_000);
      });
    } catch (error) {
      if (error instanceof WebBotError) throw new HttpError(error.status, error.message);
      throw error;
    }
    return sendJson(res, 202, { scheduled: true });
  }
  if (url.pathname === "/api/bot-inbox" && req.method === "GET") {
    const page = sql(`SELECT i.*, b.name AS botName FROM bot_inbox i
      JOIN web_bot_threads t ON t.id=i.threadId JOIN web_bots b ON b.id=t.bot
      JOIN web_bot_members m ON m.bot=t.bot AND m.user=i.userId AND m.access_id=i.accessId
      WHERE i.userId=? AND i.id<? AND (t.private_user=i.userId OR b.shared_thread=t.id) ORDER BY i.id DESC LIMIT 100`);
    const visible: InboxEntry[] = [];
    let cursor = Number.MAX_SAFE_INTEGER;
    while (visible.length < 100) {
      const rows = page.all(userId, cursor) as InboxEntry[];
      visible.push(...rows.filter(hasBotAccess));
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1]!.id;
    }
    sendJson(res, 200, {
      items: visible
        .slice(0,100)
        .map(entry => {
          const delegationId = failedDelegationId(entry);
          return { threadId: entry.threadId, messageId: entry.messageId, kind: delegationId ? "delegation-failed" : entry.kind,
            delegationId, createdAt: entry.createdAt, seen: !!entry.seen, botName: entry.botName };
        }),
    });
    return;
  }
  if (url.pathname === "/api/bot-inbox/read" && req.method === "POST") {
    const body = await readJsonBody(req, 1024);
    if (typeof body?.threadId === "string" && typeof body.delegationId === "string" && /^[a-f0-9-]{36}$/.test(body.delegationId)) {
      try {
        const thread = getBotThread(userId, body.threadId);
        getBotDelegation(userId, thread.id, body.delegationId);
        sql(`UPDATE bot_inbox SET seen=1 WHERE userId=? AND threadId=? AND accessId=? AND messageId IS NULL
          AND kind IN ('reply','delegation-failed') AND eventId GLOB ?`)
          .run(userId, thread.id, thread.accessId, "delegation-failed:" + body.delegationId + ":[0-9]*");
      } catch (error) {
        if (error instanceof WebBotError) throw new HttpError(error.status, error.message);
        throw error;
      }
      return sendJson(res, 200, { ok: true });
    }
    if (typeof body?.threadId !== "string" || typeof body.through !== "number" || !Number.isSafeInteger(body.through))
      throw new HttpError(400, "消息标识无效");
    try {
      const thread = getBotThread(userId, body.threadId);
      const through = body.through;
      transaction(() => {
        sql("UPDATE bot_inbox SET seen=1 WHERE userId=? AND threadId=? AND accessId=? AND messageId<=? AND seen=0").run(
          userId,
          thread.id,
          thread.accessId,
          through,
        );
        sql(`INSERT INTO bot_device_reads(sessionId,threadId,through,updatedAt) VALUES(?,?,?,?)
          ON CONFLICT(sessionId,threadId) DO UPDATE SET through=max(through,excluded.through),updatedAt=excluded.updatedAt`).run(
          sessionId,
          thread.id,
          through,
          Date.now(),
        );
      });
    } catch (error) {
      if (error instanceof WebBotError) throw new HttpError(error.status, error.message);
      throw error;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, "找不到这条通知");
}

export function joinAsNewBotUser(token: unknown, name: unknown, password: unknown) {
  if (typeof token !== "string" || typeof name !== "string" || typeof password !== "string" || password.length > 512)
    throw new HttpError(400, "请填写邀请、用户名和密码");
  return transaction(() => {
    if (!validBotInvite(token)) throw new HttpError(404, "邀请已失效，请让对方重新邀请你");
    let user;
    try {
      user = createUser({ name, password, botOnly: true });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "创建账号失败");
    }
    try {
      return { user, bot: acceptInvite(user.id, token) };
    } catch (error) {
      removeUser(user.id);
      throw error;
    }
  });
}

export async function handleReminderApi(req: IncomingMessage, res: ServerResponse, url: URL, userId: string): Promise<void> {
  try {
    if (url.pathname === "/api/bot-reminders" && req.method === "GET") {
      sendJson(res, 200, { reminders: listBotReminders(userId, url.searchParams.get("thread") ?? "") });
      return;
    }
    const match = /^\/api\/bot-reminders\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    const create = url.pathname === "/api/bot-reminders";
    if ((match || create) && req.method === "POST") {
      const body = await readJsonBody<ReminderAction & { requestId: string; threadId: string }>(req, 8192);
      if (
        !body ||
        typeof body.threadId !== "string" ||
        typeof body.requestId !== "string" ||
        !body.requestId.trim() ||
        (create ? body.kind !== "create" : !["update", "cancel"].includes(body.kind))
      )
        throw new HttpError(400, "请选择要修改的提醒");
      if (Object.keys(body).some(key => !["kind", "threadId", "requestId", "text", "dueAt"].includes(key)))
        throw new HttpError(400, "只能修改一次性提醒的内容和时间。");
      // A reminder created from the private form must never post its content into a shared conversation.
      const thread = getBotThread(userId, body.threadId);
      const destination = create && thread.scope === "shared" ? getBot(userId, thread.botId).privateThreadId : thread.id;
      const text = applyBotReminder(
        userId,
        destination,
        (create ? "form:" : "ui:") + body.requestId,
        { kind: body.kind, id: match?.[1], text: body.text, dueAt: body.dueAt },
        true,
      );
      sendJson(res, 200, { text, threadId: destination });
      return;
    }
    throw new HttpError(404, "找不到提醒");
  } catch (error) {
    if (error instanceof WebBotError) throw new HttpError(error.status, error.message);
    throw error;
  }
}
