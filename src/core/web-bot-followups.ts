// 同一话题内能跨天交接的事项。所有变化、聊天里的简报和通知在同一事务提交。
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, transaction } from "./db.js";
import { getUser } from "./users.js";
import { appendBotNotice, getBotThread, WebBotError, type BotThread } from "./web-bots.js";
import { enqueueBotNotice, hasBotAccess } from "./web-bot-reminders.js";
import { requireBotCapability } from "./web-bot-profile.js";

const DECISION_LIFETIME = 24 * 60 * 60 * 1000;
type Status = "open" | "waiting" | "closed";
type RecordRow = {
  id: string; thread: string; title: string; status: Status; creatorId: string; creatorAccess: string;
  assigneeId: string; assigneeAccess: string; latest: string; question: string | null; revision: number; updatedAt: number;
  decisionExpiresAt: number | null;
};
export type FollowupAction = {
  kind: "create" | "note" | "assign" | "ask" | "resume" | "close" | "approve" | "decline";
  id?: string; title?: string; text?: string; assigneeId?: string; revision?: number;
};
export type BotFollowup = {
  id: string; title: string; status: Status; creatorId: string; assigneeId: string; assigneeName: string;
  latest: string; revision: number; updatedAt: number; canManage: boolean; canDecide: boolean; canConnect: boolean;
  hasHook: boolean; question: string | null; needsAssignee: boolean; decisionExpired: boolean; decisionExpiresAt: number | null;
};

function invalid(message: string): never { throw new WebBotError(400, message); }
function denied(): never { throw new WebBotError(403, "请让这件事的负责人处理。"); }
function notFound(): never { throw new WebBotError(404, "找不到这件跟进事项。"); }
function textField(input: unknown, max: number, error: string): string {
  if (typeof input !== "string" || !input.trim() || input.trim().length > max) invalid(error);
  return input.trim();
}
function record(threadId: string, id: string | undefined): RecordRow {
  const row = sql("SELECT * FROM web_bot_followups WHERE thread=? AND id=?").get(threadId, id ?? "");
  return row as RecordRow | undefined ?? notFound();
}
function view(row: RecordRow, userId: string, thread: BotThread): BotFollowup {
  const creator = userId === row.creatorId && thread.accessId === row.creatorAccess;
  const assignee = userId === row.assigneeId && thread.accessId === row.assigneeAccess;
  const owner = !!sql("SELECT 1 FROM web_bots WHERE id=? AND owner=?").get(thread.botId, userId);
  // 已重新加入的成员仍可以管理自己的私聊事项。旧批准须显式重新指派。
  const manage = creator || assignee || owner || thread.scope === "private";
  const decisionExpired = row.status === "waiting" && (row.decisionExpiresAt ?? 0) <= Date.now();
  const needsAssignee = !hasBotAccess({ userId: row.assigneeId, threadId: row.thread, accessId: row.assigneeAccess });
  return {
    id: row.id, title: row.title, status: row.status, creatorId: row.creatorId,
    assigneeId: row.assigneeId, assigneeName: needsAssignee ? "待重新指派" : getUser(row.assigneeId)!.name,
    latest: row.latest, question: row.question, revision: row.revision, updatedAt: row.updatedAt, canManage: manage,
    canDecide: row.status === "waiting" && assignee && !decisionExpired,
    decisionExpired, decisionExpiresAt: row.decisionExpiresAt,
    canConnect: creator || owner || thread.scope === "private", needsAssignee,
    hasHook: !!sql("SELECT 1 FROM web_bot_followup_hooks WHERE followup=?").get(row.id),
  };
}
export function listBotFollowups(userId: string, threadId: string): BotFollowup[] {
  const thread = getBotThread(userId, threadId);
  const rows = sql("SELECT * FROM web_bot_followups WHERE thread=? ORDER BY (status='closed'),updatedAt DESC,rowid DESC LIMIT 100").all(threadId) as RecordRow[];
  return rows.map(row => view(row, userId, thread));
}
export function botFollowupDetail(userId: string, threadId: string, id: string) {
  const thread = getBotThread(userId, threadId);
  const followup = view(record(threadId, id), userId, thread);
  const events = sql("SELECT revision,at,actor,text FROM web_bot_followup_events WHERE followup=? ORDER BY revision DESC LIMIT 100").all(id).reverse();
  return { followup, events };
}

export function pendingBotDecisions(userId: string) {
  const rows = sql(`SELECT f.*, b.id AS botId, b.name AS botName FROM web_bot_followups f
    JOIN web_bot_threads t ON f.thread=t.id JOIN web_bots b ON b.id=t.bot
    JOIN web_bot_members m ON m.bot=b.id AND m.user=f.assigneeId
    WHERE f.assigneeId=? AND f.status='waiting' AND (t.private_user=? OR b.shared_thread=t.id)
    ORDER BY f.updatedAt DESC, f.id`).all(userId, userId) as (RecordRow & { botId: string; botName: string })[];
  return rows.flatMap(row => {
    try {
      const thread = requireBotCapability(userId, row.thread, "followups");
      if (thread.accessId !== row.assigneeAccess) return [];
      const item = view(row, userId, thread);
      return [{threadId: row.thread, botId: row.botId, botName: row.botName, scope: thread.scope, id: row.id,
        title: item.title, question: item.question, decisionExpired: item.decisionExpired}];
    } catch (err) {
      if (err instanceof WebBotError && (err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  });
}

function publish(row: RecordRow, userId: string, actor: string, notifyActor: boolean) {
  sql("INSERT INTO web_bot_followup_events(followup,revision,at,actor,text) VALUES (?,?,?,?,?)")
    .run(row.id, row.revision, row.updatedAt, actor, row.latest);
  const notice = appendBotNotice(userId, row.thread, "跟进「" + row.title + "」：" + row.latest);
  const recipients: [string, string][] = [[row.assigneeId, row.assigneeAccess]];
  if (row.status !== "waiting") recipients.push([row.creatorId, row.creatorAccess]);
  const notified = new Set<string>();
  for (const [recipient, accessId] of recipients) {
    if ((!notifyActor && recipient === userId) || notified.has(recipient)) continue;
    if (!hasBotAccess({ userId: recipient, threadId: row.thread, accessId })) continue;
    enqueueBotNotice(recipient, row.thread, `followup:${row.id}:${row.revision}`, "followup", notice.id);
    notified.add(recipient);
  }
  return notice.id;
}
function saveProgress(row: RecordRow) {
  row.revision++;
  row.updatedAt = Date.now();
  sql(`UPDATE web_bot_followups SET status=?,assigneeId=?,assigneeAccess=?,latest=?,question=?,revision=?,updatedAt=?,decisionExpiresAt=? WHERE id=?`)
    .run(row.status, row.assigneeId, row.assigneeAccess, row.latest, row.question, row.revision, row.updatedAt, row.decisionExpiresAt, row.id);
}
export function applyBotFollowup(userId: string, threadId: string, requestId: string, action: FollowupAction): BotFollowup & { noticeId?: number } {
  return transaction(() => {
    const thread = requireBotCapability(userId, threadId, "followups");
    textField(requestId, 160, "请重试这次操作。");
    if (!action || typeof action !== "object") invalid("无法识别这个操作。");
    if (action.id != null && typeof action.id !== "string") invalid("事项编号无效。");
    if (action.assigneeId != null && typeof action.assigneeId !== "string") invalid("成员编号无效。");
    const prior = sql("SELECT followup FROM web_bot_followup_requests WHERE user=? AND access=? AND thread=? AND request=?")
      .get(userId, thread.accessId, threadId, requestId);
    if (prior) return view(record(threadId, String(prior.followup)), userId, thread);

    const actor = getUser(userId)!.name;
    const note = action.text == null || action.text === "" ? "" : textField(action.text, 1600, "请用 1600 字以内记录进展。");
    let row: RecordRow;
    if (action.kind === "create") {
      const title = textField(action.title, 140, "请用 140 字以内描述要跟进的事。");
      const assigned = action.assigneeId ?? userId;
      const { accessId } = getBotThread(assigned, threadId);
      row = {
        id: randomUUID(), thread: threadId, title, status: "open", creatorId: userId, creatorAccess: thread.accessId,
        assigneeId: assigned, assigneeAccess: accessId, latest: actor + " 开始跟进" + (note ? "：" + note : "。"),
        question: null, revision: 1, updatedAt: Date.now(), decisionExpiresAt: null,
      };
      sql(`INSERT INTO web_bot_followups(id,thread,title,status,creatorId,creatorAccess,assigneeId,assigneeAccess,latest,revision,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, threadId, title, row.status, userId, thread.accessId, assigned, accessId, row.latest, 1, row.updatedAt);
    } else {
      row = record(threadId, action.id);
      const permissions = view(row, userId, thread);
      if (action.kind === "approve" || action.kind === "decline") {
        if (permissions.decisionExpired && userId === row.assigneeId && thread.accessId === row.assigneeAccess)
          throw new WebBotError(409, "这次确认已过期，请核对最新进展后重新发起确认。");
        if (!permissions.canDecide) denied();
      } else if (action.kind !== "note" && !permissions.canManage) denied();
      if (!Number.isSafeInteger(action.revision) || row.revision !== action.revision)
        throw new WebBotError(409, "这件事刚有新进展，请重新查看后再操作。");
      if (row.status === "closed" && action.kind !== "resume") throw new WebBotError(409, "这件事已经结束，需要时可以重新跟进。");
      if (row.status === "waiting" && (action.kind === "resume" || action.kind === "close"))
        throw new WebBotError(409, "请先请指定成员确认，或转交其他成员确认。");
      switch (action.kind) {
        case "note":
          if (!note) invalid("请输入进展或依据。");
          row.latest = actor + " 补充：" + note;
          break;
        case "assign":
        case "ask": {
          if (action.kind === "ask" && !note) invalid("请输入需要对方确认的问题。");
          const next = action.assigneeId ?? row.assigneeId;
          const { accessId } = getBotThread(next, threadId);
          if (action.kind === "assign" && !action.assigneeId) invalid("请选择接手的人。");
          row.assigneeId = next;
          row.assigneeAccess = accessId;
          if (action.kind === "ask") {
            row.status = "waiting";
            row.question = note;
          }
          if (row.status === "waiting") row.decisionExpiresAt = Date.now() + DECISION_LIFETIME;
          row.latest = actor + (action.kind === "ask" ? " 请 " : " 交给 ") + getUser(next)!.name
            + (action.kind === "ask" ? " 确认" : " 继续跟进") + (note ? "：" + note : "。");
          break;
        }
        case "approve":
        case "decline": {
          // The source can report a recovery while a person is still deciding. Resolve against the most
          // recent report on the same live connection, including after a restart or later progression note.
          const hook = sql("SELECT user,access,lastState FROM web_bot_followup_hooks WHERE followup=?").get(row.id);
          const recovered = action.kind === "approve" && hook?.lastState != null
            && JSON.parse(String(hook.lastState))[1] === true
            && hasBotAccess({ userId: String(hook.user), threadId, accessId: String(hook.access) });
          row.status = recovered ? "closed" : "open";
          row.question = null;
          row.decisionExpiresAt = null;
          row.latest = actor + (action.kind === "approve" ? " 已同意。" : " 已退回。") + note;
          if (recovered) row.latest += "状态来源已报告恢复，跟进已结束。";
          break;
        }
        case "resume":
          sql("UPDATE web_bot_followup_hooks SET lastState=NULL WHERE followup=?").run(row.id);
          row.status = "open";
          row.latest = actor + " 继续跟进。" + note;
          break;
        case "close":
          row.status = "closed";
          row.latest = actor + " 已结束跟进。" + note;
          break;
        default: invalid("无法识别这个操作。");
      }
      saveProgress(row);
    }
    const noticeId = publish(row, userId, actor, false);
    sql("INSERT INTO web_bot_followup_requests(user,access,thread,request,followup) VALUES (?,?,?,?,?)")
      .run(userId, thread.accessId, threadId, requestId, row.id);
    return { ...view(row, userId, thread), noticeId };
  });
}

function hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function setFollowupHook(userId: string, threadId: string, id: string, enable: boolean): { token: string; url: string } | null {
  return transaction(() => {
    const thread = enable ? requireBotCapability(userId, threadId, "followups") : getBotThread(userId, threadId);
    const item = view(record(threadId, id), userId, thread);
    if (!item.canConnect) denied();
    sql("DELETE FROM web_bot_followup_hooks WHERE followup=?").run(id);
    if (!enable) return null;
    const token = randomBytes(32).toString("base64url");
    sql("INSERT INTO web_bot_followup_hooks(followup,digest,user,access) VALUES (?,?,?,?)").run(id, hash(token), userId, thread.accessId);
    return { token, url: "/api/bot-events/" + id };
  });
}
function currentHook(id: string, token: string) {
  const hook = sql(`SELECT f.thread,h.user,h.access,h.lastState FROM web_bot_followup_hooks h
    JOIN web_bot_followups f ON f.id=h.followup JOIN web_bot_threads t ON t.id=f.thread
    JOIN web_bots b ON b.id=t.bot WHERE h.followup=? AND h.digest=?
    AND (t.private_user=h.user OR b.owner=h.user OR (f.creatorId=h.user AND f.creatorAccess=h.access))`).get(id, hash(token));
  if (!hook || !hasBotAccess({userId: String(hook.user), threadId: String(hook.thread), accessId: String(hook.access)}))
    throw new WebBotError(404, "状态更新地址无效。");
  return { userId: String(hook.user), thread: String(hook.thread), lastState: hook.lastState };
}
export function checkFollowupHook(id: string, token: string): void { currentHook(id, token); }
export function ingestFollowupEvent(id: string, token: string, input: Record<string, unknown>): void {
  transaction(() => {
    const hook = currentHook(id, token);
    const row = record(hook.thread, id);
    const event = textField(input.eventId, 160, "缺少有效的 eventId。");
    const state = textField(input.state, 100, "缺少有效的 state。");
    const evidence = input.evidence == null ? "" : textField(input.evidence, 1600, "evidence 最多 1600 字。");
    if (input.recovered != null && typeof input.recovered !== "boolean") invalid("recovered 必须为布尔值。");
    if (row.status === "closed") return;
    const consumed = sql("INSERT OR IGNORE INTO web_bot_followup_inputs(followup,event) VALUES (?,?)").run(id, event);
    const signature = JSON.stringify([state, input.recovered === true]);
    if (!consumed.changes || hook.lastState === signature) return;
    sql("UPDATE web_bot_followup_hooks SET lastState=? WHERE followup=?").run(signature, id);
    row.latest = "状态来源报告" + (input.recovered ? "已恢复" : "变化") + "：" + state + (evidence ? "。依据：" + evidence : "。");
    if (input.recovered && row.status !== "waiting") row.status = "closed";
    saveProgress(row);
    publish(row, hook.userId, "已连接的状态来源", true);
  });
}
