// 委派草稿只属于提出者。确认后才会将这段文字交给目标 Bot，成果回原话题。
import { randomUUID } from "node:crypto";
import { sql, transaction } from "./db.js";
import { getBot, getBotThread, listBots, recoverPendingBotTurns, requireBotTurnCapacity, WebBotError } from "./web-bots.js";
import { getBotProfile, requireBotCapability } from "./web-bot-profile.js";

type Status = "proposed" | "queued" | "running" | "done" | "failed" | "cancelled";
export type DelegationJob = {
  id: string;
  actor: string;
  thread: string;
  sourceAccess: string;
  sourceRevision: number;
  target: string;
  targetThread: string;
  targetAccess: string;
  targetRevision: number;
  task: string;
  status: Status;
  attempt: number;
  worker: number | null;
  deadline: number | null;
  resultMessageId: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export function listDelegationTargets(userId: string, threadId: string, audience: "model" | "requester" = "model") {
  const thread = getBotThread(userId, threadId);
  if (!getBotProfile(userId, thread.botId).capabilities.includes("delegation")) return [];
  const readers = thread.scope === "shared" && audience === "model" ? getBot(userId, thread.botId).members : [];
  return listBots(userId)
    .filter(
      (bot) =>
        bot.id !== thread.botId &&
        readers.every((reader) => bot.members.some((member) => member.id === reader.id)) &&
        bot.capabilities.includes("delegation"),
    )
    .map(({ id, name }) => ({ id, name }));
}

export function assertDelegationAccess(job: DelegationJob) {
  const source = getBotThread(job.actor, job.thread);
  const destination = getBotThread(job.actor, job.targetThread);
  if (source.accessId !== job.sourceAccess || destination.accessId !== job.targetAccess || destination.botId !== job.target)
    throw new WebBotError(403, "这次委派的成员权限已变更，请重新交办。");
  requireBotCapability(job.actor, job.thread, "delegation");
  requireBotCapability(job.actor, job.targetThread, "delegation");
  const target = getBotProfile(job.actor, job.target);
  if (getBotProfile(job.actor, source.botId).revision !== job.sourceRevision || target.revision !== job.targetRevision)
    throw new WebBotError(409, "助手设置已变更，请重新准备委派。");
  return target;
}

function targetName(job: DelegationJob, viewer: string): string | null {
  try {
    return getBot(viewer, job.target).name;
  } catch (error) {
    if (error instanceof WebBotError) return null;
    throw error;
  }
}

function view(job: DelegationJob) {
  let allowed = true;
  try {
    if (job.status === "proposed" || job.status === "failed") assertDelegationAccess(job);
  } catch (error) {
    if (!(error instanceof WebBotError)) throw error;
    allowed = false;
  }
  const expired = Date.now() >= job.createdAt + 86_400_000;
  const name = targetName(job, job.actor);
  return {
    id: job.id,
    targetId: name ? job.target : null,
    targetName: name || "已不可用的助手",
    task: job.task,
    status: job.status,
    attempt: job.attempt,
    resultMessageId: job.resultMessageId,
    error:
      job.error ??
      (job.status === "proposed" && expired
        ? "草稿已过期，请重新交办。"
        : !allowed && job.status === "proposed"
          ? "权限或设置已变更，请重新交办。"
          : null),
    canConfirm: allowed && !expired && job.status === "proposed",
    canCancel: ["proposed", "running", "queued"].includes(job.status),
    canRetry: allowed && !expired && job.status === "failed" && job.attempt < 3,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function readJob(id: string): DelegationJob {
  const row = sql("SELECT * FROM web_bot_delegations WHERE id=?").get(id);
  if (!row) throw new WebBotError(404, "找不到这次委派。");
  return row as DelegationJob;
}

export function getBotDelegation(actor: string, threadId: string, id: string) {
  const { accessId } = getBotThread(actor, threadId);
  const job = readJob(id);
  if (job.actor !== actor || job.thread !== threadId || job.sourceAccess !== accessId)
    throw new WebBotError(404, "找不到这次委派。");
  return view(job);
}

// The first preview recorded private failure notices as replies without a message.
export function failedDelegationId(notice: {eventId: string; messageId: number | null; kind: string}) {
  if (notice.messageId !== null || !["reply", "delegation-failed"].includes(notice.kind)) return;
  return /^delegation-failed:([a-f0-9-]{36}):[1-9]\d*$/.exec(notice.eventId)?.[1];
}

export function listBotDelegations(actor: string, threadId: string) {
  const { accessId } = getBotThread(actor, threadId);
  const jobs = sql(`SELECT * FROM web_bot_delegations WHERE actor=? AND thread=? AND sourceAccess=?
    ORDER BY (status IN ('proposed','queued','running')) DESC,updatedAt DESC,rowid DESC LIMIT 30`).all(
    actor,
    threadId,
    accessId,
  ) as DelegationJob[];
  return jobs.map(view);
}

export function createBotDelegation(
  actor: string,
  threadId: string,
  requestId: string,
  proposal: { targetId: string; task: string },
) {
  if (
    typeof requestId !== "string" ||
    !requestId.trim() ||
    requestId.length > 160 ||
    typeof proposal?.targetId !== "string" ||
    typeof proposal.task !== "string" ||
    !proposal.task.trim() ||
    proposal.task.trim().length > 4000
  )
    throw new WebBotError(400, "请选择助手，并用 4000 字以内说明这次要交给它的事。");
  return transaction(() => {
    const source = getBotThread(actor, threadId);
    const task = proposal.task.trim();
    const old = sql("SELECT * FROM web_bot_delegations WHERE actor=? AND thread=? AND sourceAccess=? AND request=?").get(
      actor,
      threadId,
      source.accessId,
      requestId,
    ) as DelegationJob | undefined;
    if (old) {
      // 确认时可以改写草稿。之后相同请求重放应返回已批准的版本。
      if (old.target !== proposal.targetId || (old.attempt === 0 && old.task !== task))
        throw new WebBotError(409, "这条请求已经用于另一项委派。");
      return view(old);
    }
    const target = getBot(actor, proposal.targetId);
    if (source.botId === target.id) throw new WebBotError(400, "请选择另一位助手。");
    requireBotCapability(actor, threadId, "delegation");
    requireBotCapability(actor, target.privateThreadId, "delegation");
    const destination = getBotThread(actor, target.privateThreadId);
    const now = Date.now();
    sql(
      "UPDATE web_bot_delegations SET status='cancelled',updatedAt=?,error='草稿已过期' WHERE actor=? AND status='proposed' AND createdAt<=?",
    ).run(now, actor, now - 86_400_000);
    const open = sql("SELECT count(*) AS n FROM web_bot_delegations WHERE actor=? AND status='proposed'").get(actor);
    if (Number(open?.n) >= 12) {
      const drafts = sql("SELECT * FROM web_bot_delegations WHERE actor=? AND status='proposed'").all(actor) as DelegationJob[];
      let usable = 0;
      for (const draft of drafts) {
        try {
          assertDelegationAccess(draft);
          usable++;
        } catch (err) {
          if (!(err instanceof WebBotError)) throw err;
          sql("UPDATE web_bot_delegations SET status='cancelled',updatedAt=?,error=? WHERE id=?").run(
            now,
            "权限或设置已变更",
            draft.id,
          );
        }
      }
      if (usable >= 12) throw new WebBotError(429, "待确认的委派较多，请先处理已有草稿。");
    }
    const id = randomUUID();
    sql(`INSERT INTO web_bot_delegations(id,actor,thread,sourceAccess,target,targetThread,targetAccess,
      sourceRevision,targetRevision,task,request,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?)`).run(
      id,
      actor,
      threadId,
      source.accessId,
      target.id,
      destination.id,
      destination.accessId,
      getBotProfile(actor, source.botId).revision,
      getBotProfile(actor, target.id).revision,
      task,
      requestId,
      now,
      now,
    );
    return view(readJob(id));
  });
}

type Action = "confirm" | "retry" | "cancel";
export function changeBotDelegation(
  actor: string,
  threadId: string,
  id: string,
  action: Action,
  attempt: number,
  editedTask?: unknown,
) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new WebBotError(400, "请重新打开委派后再操作。");
  return transaction(() => {
    const { accessId } = getBotThread(actor, threadId);
    const job = readJob(id);
    if (job.actor !== actor || job.thread !== threadId || job.sourceAccess !== accessId)
      throw new WebBotError(404, "找不到这次委派。");
    if (editedTask !== undefined && action !== "confirm") throw new WebBotError(400, "只能在首次确认前修改任务。");
    // 重放已提交的确认不会再次排队，即便上一轮在重试请求到达前就失败了。
    if (attempt < job.attempt && action !== "cancel") return view(job);
    if (attempt !== job.attempt) throw new WebBotError(409, "委派状态刚有更新，请刷新后再试。");
    if (action === "cancel") {
      if (["proposed", "queued", "running"].includes(job.status))
        sql("UPDATE web_bot_delegations SET status='cancelled',deadline=NULL,worker=NULL,updatedAt=? WHERE id=?").run(
          Date.now(),
          id,
        );
      return view(readJob(id));
    }
    if (action !== "confirm" && action !== "retry") throw new WebBotError(400, "未知的委派操作。");
    if ((action === "confirm" && job.status !== "proposed") || (action === "retry" && job.status !== "failed")) return view(job);
    if (editedTask !== undefined && (typeof editedTask !== "string" || !editedTask.trim() || editedTask.trim().length > 4000))
      throw new WebBotError(400, "请用 1 至 4000 字说明要发送的任务。");
    assertDelegationAccess(job);
    if (Date.now() >= job.createdAt + 86_400_000 || job.attempt >= 3) throw new WebBotError(409, "这次委派已结束，请重新交办。");
    recoverPendingBotTurns();
    requireBotTurnCapacity(actor);
    const now = Date.now();
    sql("UPDATE web_bot_delegations SET status='queued',task=?,attempt=attempt+1,error=NULL,updatedAt=? WHERE id=?").run(
      editedTask === undefined ? job.task : editedTask.trim(),
      now,
      id,
    );
    sql("INSERT INTO web_bot_delegation_attempts (job,attempt,actor,at) VALUES(?,?,?,?)").run(id, attempt + 1, actor, now);
    return view(readJob(id));
  });
}

/** 共享记录本身使用中性署名。只给仍可使用目标 Bot 的读者展示它的名字。 */
export function delegationCredits(viewer: string, threadId: string, first: number, last: number): Map<number, string> {
  getBotThread(viewer, threadId);
  const credits = new Map<number, string>();
  const jobs = sql("SELECT * FROM web_bot_delegations WHERE thread=? AND resultMessageId BETWEEN ? AND ?").all(
    threadId,
    first,
    last,
  ) as DelegationJob[];
  for (const job of jobs) {
    const name = targetName(job, viewer);
    if (name && job.resultMessageId) credits.set(job.resultMessageId, name);
  }
  return credits;
}
