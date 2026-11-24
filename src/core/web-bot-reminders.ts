import { randomUUID } from "node:crypto";
import { sql, transaction } from "./db.js";
import { appendBotNotice, getBotThread, WebBotError } from "./web-bots.js";
import { requireBotCapability, botReminderEnabled } from "./web-bot-profile.js";

export type ReminderAction = { kind: "create" | "update" | "cancel"; id?: string; text?: string; dueAt?: number };
type Reminder = { id: string; text: string; dueAt: number };
type Delivery = { userId: string; threadId: string; eventId: string; kind: "reply" | "reminder" | "followup" | "delegation-failed"; accessId: string };
type Pending = Reminder & Omit<Delivery, "kind" | "eventId">;

export function listBotReminders(userId: string, threadId: string): Reminder[] {
  const { accessId } = getBotThread(userId, threadId);
  return sql("SELECT id,text,dueAt FROM bot_reminders WHERE userId=? AND threadId=? AND accessId=? ORDER BY dueAt").all(
    userId,
    threadId,
    accessId,
  ) as Reminder[];
}

/** Share a thread without implicitly granting members control over each other's personal reminders. */
export function applyBotReminder(
  userId: string,
  threadId: string,
  requestId: string,
  action: ReminderAction,
  announce = false,
): string {
  if (typeof requestId !== "string" || !requestId || requestId.length > 160) throw new WebBotError(400, "请重试这次操作");
  return transaction(() => {
    const { accessId } = action.kind === "cancel" ? getBotThread(userId, threadId) : requireBotCapability(userId, threadId, "reminders");
    const prior = sql(
      "SELECT response FROM bot_reminder_actions WHERE userId=? AND threadId=? AND accessId=? AND requestId=?",
    ).get(userId, threadId, accessId, requestId);
    if (prior) return String(prior.response);
    const existing = listBotReminders(userId, threadId);
    const current = existing.find((r) => r.id === action.id);
    if (action.kind !== "create" && !current) throw new WebBotError(404, "这条提醒已结束或不属于你");
    let response: string;
    if (action.kind === "cancel") {
      sql("DELETE FROM bot_reminders WHERE id=?").run(current!.id);
      response = "已取消提醒：" + current!.text;
    } else {
      if (action.kind !== "create" && action.kind !== "update") throw new WebBotError(400, "无法识别提醒操作");
      const dueAt = action.dueAt ?? current?.dueAt;
      const text = (typeof action.text === "string" ? action.text : current?.text)?.trim();
      if (!text || text.length > 500) throw new WebBotError(400, "请用 500 字以内描述提醒内容");
      if (!dueAt || !Number.isSafeInteger(dueAt) || dueAt <= Date.now() || dueAt > Date.now() + 10 * 366 * 86400_000)
        throw new WebBotError(400, "请指定未来十年内的提醒时间");
      if (action.kind === "create") {
        const count = sql("SELECT COUNT(*) AS n FROM bot_reminders WHERE userId=?").get(userId);
        if (Number(count?.n) >= 100) {
          const pending = sql("SELECT id,userId,threadId,accessId FROM bot_reminders WHERE userId=?").all(userId) as Pending[];
          const obsolete = pending.filter(row => !hasBotAccess(row));
          if (pending.length - obsolete.length >= 100) throw new WebBotError(400, "已有 100 条待提醒事项，请先取消不需要的提醒");
          for (const row of obsolete) sql("DELETE FROM bot_reminders WHERE id=?").run(row.id);
        }
        sql("INSERT INTO bot_reminders(id,userId,threadId,accessId,text,dueAt) VALUES (?,?,?,?,?,?)").run(
          randomUUID(),
          userId,
          threadId,
          accessId,
          text,
          dueAt,
        );
      } else {
        sql("UPDATE bot_reminders SET text=?,dueAt=? WHERE id=?").run(text, dueAt, current!.id);
      }
      response = (action.kind === "create" ? "已安排提醒：" : "已更新提醒：") + text;
    }
    sql("INSERT INTO bot_reminder_actions(userId,threadId,accessId,requestId,response) VALUES (?,?,?,?,?)").run(
      userId,
      threadId,
      accessId,
      requestId,
      response,
    );
    if (announce) appendBotNotice(userId, threadId, response);
    return response;
  });
}

export function enqueueBotNotice(
  userId: string,
  threadId: string,
  eventId: string,
  kind: Delivery["kind"],
  messageId?: number,
): void {
  const { accessId } = getBotThread(userId, threadId);
  transaction(() => {
    const inputs = [userId, threadId, accessId, eventId, kind, Date.now(), messageId ?? null];
    const fresh = sql(
      "INSERT OR IGNORE INTO bot_inbox(userId,threadId,accessId,eventId,kind,createdAt,messageId) VALUES (?,?,?,?,?,?,?)",
    ).run(...inputs);
    if (fresh.changes)
      sql(
        "INSERT OR IGNORE INTO bot_notice_events(userId,threadId,accessId,eventId,kind,createdAt,messageId) VALUES (?,?,?,?,?,?,?)",
      ).run(...inputs);
  });
}

export function hasBotAccess(row: Pick<Delivery, "userId" | "threadId" | "accessId">): boolean {
  try {
    return getBotThread(row.userId, row.threadId).accessId === row.accessId;
  } catch (error) {
    if (error instanceof WebBotError) return false;
    throw error;
  }
}

export function fireDueBotReminders(now = Date.now()): void {
  transaction(() => {
    const due = sql("SELECT * FROM bot_reminders WHERE dueAt<=? ORDER BY dueAt LIMIT 64").all(now) as Pending[];
    for (const row of due) {
      sql("DELETE FROM bot_reminders WHERE id=?").run(row.id);
      if (!hasBotAccess(row) || !botReminderEnabled(row.userId, row.threadId, row.dueAt)) continue;
      const notice = appendBotNotice(row.userId, row.threadId, "⏰ 提醒：" + row.text);
      enqueueBotNotice(row.userId, row.threadId, row.id, "reminder", notice.id);
    }
  });
}
