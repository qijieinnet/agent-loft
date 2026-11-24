import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelKey, modelRuntime, pickModel } from "../agents/pi/sdk.js";
import { config } from "./config.js";
import { sql, transaction } from "./db.js";
import { getUser } from "./users.js";
import { BOT_CAPABILITIES, getBot, getBotThread, WebBotError, type BotCapability } from "./web-bots.js";
export { BOT_CAPABILITIES, type BotCapability } from "./web-bots.js";
export type BotProfile = {
  responsibility: string;
  style: string;
  model: string;
  capabilities: BotCapability[];
  revision: number;
};
const labels: Record<BotCapability, string> = { reminders: "提醒", followups: "跟进", delegation: "协作", memory: "记忆" };

function readProfile(botId: string): BotProfile {
  const row = sql("SELECT responsibility,style,model,capabilities,revision FROM web_bot_profiles WHERE bot=?").get(botId);
  if (!row) return { responsibility: "", style: "", model: "", capabilities: [...BOT_CAPABILITIES], revision: 0 };
  return {
    responsibility: String(row.responsibility),
    style: String(row.style),
    model: String(row.model),
    capabilities: JSON.parse(String(row.capabilities)) as BotCapability[],
    revision: Number(row.revision),
  };
}

export function getBotProfile(userId: string, botId: string): BotProfile {
  getBot(userId, botId);
  return readProfile(botId);
}

export function requireBotCapability(userId: string, threadId: string, capability: BotCapability) {
  const thread = getBotThread(userId, threadId);
  if (!readProfile(thread.botId).capabilities.includes(capability)) {
    throw new WebBotError(403, "这个 Bot 的「" + labels[capability] + "」已关闭。");
  }
  return thread;
}

/** The owner can pick from credential-backed models explicitly enabled by this installation. */
async function modelChoices() {
  const settings = config().agents.pi;
  const override = process.env.AGENT_LOFT_BOT_MODEL?.trim();
  const preferred = override || settings.defaultModel || "";
  if (!settings.enabled && !override) return { models: [] as Model<Api>[], preferred };
  try {
    const rt = await modelRuntime();
    const available = await rt.getAvailable();
    const allowed = new Set([...(settings.enabled ? settings.models : []), preferred].filter(Boolean));
    if (!allowed.size) {
      // Preserve the existing automatic default. Additional models require admin opt-in.
      const fallback = await pickModel();
      if (fallback) allowed.add(modelKey(fallback));
    }
    const byKey = new Map(available.map((model) => [modelKey(model), model]));
    return { models: [...allowed].flatMap((key) => byKey.get(key) ?? []), preferred };
  } catch {
    throw new WebBotError(503, "暂时无法读取可用模型，请稍后再试。");
  }
}

export async function botModelChoices(userId: string, botId: string) {
  if (getBot(userId, botId).ownerId !== userId) throw new WebBotError(403, "只有 Bot 的所有者可以选择模型。");
  const { models } = await modelChoices();
  getBot(userId, botId);
  return models.map((model) => ({
    id: modelKey(model),
    label: model.name || model.id,
    vision: model.input.includes("image"),
  }));
}

export async function pickBotModel(userId: string, botId: string, needsVision: boolean): Promise<Model<Api>> {
  const { models, preferred } = await modelChoices();
  const profile = getBotProfile(userId, botId);
  const selected = profile.model || preferred;
  const model = selected
    ? models.find((m) => modelKey(m) === selected)
    : ((needsVision ? models.find((m) => m.input.includes("image")) : undefined) ?? models[0]);
  if (!model) {
    const message =
      getUser(userId)?.role === "admin"
        ? "模型还未连接或已从可用列表移除。请检查 pi 的已连接模型和 Bot 设置。"
        : "这个 Bot 选择的模型暂不可用，请联系管理它的人。";
    throw new WebBotError(503, message);
  }
  if (needsVision && !model.input.includes("image"))
    throw new WebBotError(400, "这个 Bot 的模型只能读文字。可以把图片里的文字发给我，或请所有者选择支持读图的模型。");
  return model;
}

function checkedText(raw: unknown, max: number, label: string) {
  if (typeof raw !== "string" || raw.trim().length > max) throw new WebBotError(400, label + "最多 " + max + " 字。");
  return raw.trim();
}

export async function updateBotProfile(userId: string, botId: string, input: Record<string, unknown>): Promise<BotProfile> {
  const owner = () => {
    if (getBot(userId, botId).ownerId !== userId) throw new WebBotError(403, "只有 Bot 的所有者可以更改设置。");
  };
  owner();
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new WebBotError(400, "请先刷新 Bot 设置。");
  if (Object.keys(input).some((key) => !["responsibility", "style", "model", "capabilities", "revision"].includes(key)))
    throw new WebBotError(400, "设置中有无法识别的选项。");
  const before = readProfile(botId);
  if (before.revision !== input.revision) throw new WebBotError(409, "设置已在别处更改，请重新打开后再保存。");
  const responsibility =
    input.responsibility === undefined ? before.responsibility : checkedText(input.responsibility, 1400, "职责");
  const style = input.style === undefined ? before.style : checkedText(input.style, 600, "回复风格");
  const model = input.model === undefined ? before.model : checkedText(input.model, 300, "模型名称");
  let capabilities = before.capabilities;
  if (input.capabilities !== undefined) {
    if (!Array.isArray(input.capabilities) || input.capabilities.some((c) => !BOT_CAPABILITIES.includes(c)))
      throw new WebBotError(400, "请选择支持的 Bot 能力。");
    capabilities = BOT_CAPABILITIES.filter((c) => (input.capabilities as unknown[]).includes(c));
  }
  if (model && model !== before.model && !(await modelChoices()).models.some((m) => modelKey(m) === model))
    throw new WebBotError(400, "请选择管理员已启用的模型。");
  return transaction(() => {
    owner();
    const current = readProfile(botId);
    if (current.revision !== input.revision) throw new WebBotError(409, "设置已在别处更改，请重新打开后再保存。");
    if (
      current.responsibility === responsibility &&
      current.style === style &&
      current.model === model &&
      JSON.stringify(current.capabilities) === JSON.stringify(capabilities)
    )
      return current;
    const revision = current.revision + 1;
    const resumed = !before.capabilities.includes("reminders") && capabilities.includes("reminders") ? Date.now() : 0;
    sql(`INSERT INTO web_bot_profiles(bot,responsibility,style,model,capabilities,revision,remindersResumedAt)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(bot) DO UPDATE SET responsibility=excluded.responsibility,
        style=excluded.style,model=excluded.model,capabilities=excluded.capabilities,revision=excluded.revision,
        remindersResumedAt=max(web_bot_profiles.remindersResumedAt,excluded.remindersResumedAt)`).run(
      botId,
      responsibility,
      style,
      model,
      JSON.stringify(capabilities),
      revision,
      resumed,
    );
    if (!capabilities.includes("followups") && before.capabilities.includes("followups")) {
      sql(`DELETE FROM web_bot_followup_hooks WHERE followup IN (SELECT f.id FROM web_bot_followups f
        JOIN web_bot_threads t ON f.thread=t.id WHERE t.bot=?)`).run(botId);
    }
    for (const [capability, kind] of [
      ["followups", "followup"],
      ["reminders", "reminder"],
    ] as const) {
      if (before.capabilities.includes(capability) && !capabilities.includes(capability)) {
        sql("DELETE FROM bot_notice_events WHERE kind=? AND threadId IN (SELECT id FROM web_bot_threads WHERE bot=?)").run(
          kind,
          botId,
        );
        sql("DELETE FROM bot_notice_devices WHERE kind=? AND threadId IN (SELECT id FROM web_bot_threads WHERE bot=?)").run(
          kind,
          botId,
        );
      }
    }
    return { responsibility, style, model, capabilities, revision };
  });
}

/** A reminder that became due during a pause is not pushed later on re-enabling. */
export function botReminderEnabled(userId: string, threadId: string, dueAt: number): boolean {
  const thread = getBotThread(userId, threadId);
  const profile = readProfile(thread.botId);
  return (
    profile.capabilities.includes("reminders") &&
    dueAt >=
      Number(sql("SELECT remindersResumedAt FROM web_bot_profiles WHERE bot=?").get(thread.botId)?.remindersResumedAt ?? 0)
  );
}

type MemoryScope = "private" | "shared";
type MemoryRow = {
  id: string;
  thread: string;
  text: string;
  author: string;
  authorAccess: string;
  createdAt: number;
  pending: number;
};
type MemoryView = {
  id: string;
  text: string;
  scope: MemoryScope;
  canDelete: boolean;
  canApprove: boolean;
  createdAt: number;
};
function memoryView(row: MemoryRow, scope: MemoryScope, userId: string, owner: string): MemoryView {
  return {
    id: row.id,
    text: row.text,
    scope,
    createdAt: row.createdAt,
    canDelete: row.author === userId || (scope === "shared" && owner === userId),
    canApprove: scope === "shared" && !!row.pending && owner === userId,
  };
}

function validProposal(row: MemoryRow) {
  try {
    return getBotThread(row.author, row.thread).accessId === row.authorAccess;
  } catch (error) {
    if (error instanceof WebBotError) return false;
    throw error;
  }
}

export function botMemoryPage(userId: string, threadId: string) {
  const thread = getBotThread(userId, threadId);
  const bot = getBot(userId, thread.botId);
  const rows = sql(`SELECT * FROM web_bot_memories WHERE thread IN (?,?) ORDER BY createdAt,id`).all(
    threadId,
    bot.sharedThreadId,
  ) as MemoryRow[];
  const memories: MemoryView[] = [],
    proposals: MemoryView[] = [];
  for (const row of rows) {
    const scope = row.thread === bot.sharedThreadId ? "shared" : "private";
    const item = memoryView(row, scope, userId, bot.ownerId);
    if (row.thread !== threadId) item.canDelete = false;
    if (!bot.capabilities.includes("memory")) item.canApprove = false;
    if (!row.pending) memories.push(item);
    else if (thread.scope === "shared" && (row.author === userId || userId === bot.ownerId) && validProposal(row))
      proposals.push(item);
  }
  return { memories, proposals };
}

/** Only approved records in the current scope enter a chat model's context. */
export function listBotMemories(userId: string, threadId: string): MemoryView[] {
  const thread = getBotThread(userId, threadId);
  if (!readProfile(thread.botId).capabilities.includes("memory")) return [];
  return botMemoryPage(userId, threadId).memories;
}

const memorySegmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const commonWords = new Set([
  "我",
  "你",
  "他",
  "她",
  "的",
  "了",
  "是",
  "吗",
  "呢",
  "在",
  "和",
  "有",
  "什么",
  "怎么",
  "哪",
  "请",
  "帮",
  "a",
  "an",
  "the",
  "is",
  "are",
  "to",
  "of",
  "for",
  "my",
  "i",
  "you",
  "what",
  "how",
  "can",
  "do",
]);

/** Bound model input independently of the full list shown in the memory sheet. */
export function selectBotChatMemories(
  userId: string,
  threadId: string,
  query: string,
): Pick<MemoryView, "scope" | "text">[] {
  const memories = listBotMemories(userId, threadId);
  const ranked = memories.map((memory) => ({ memory, normalized: memory.text.normalize("NFKC").toLowerCase(), score: 0 }));
  const terms = new Set<string>();
  for (const part of memorySegmenter.segment(query.slice(0, 2000).normalize("NFKC").toLowerCase())) {
    if (part.isWordLike && !commonWords.has(part.segment)) terms.add(part.segment);
    if (terms.size >= 64) break;
  }
  for (const term of terms) {
    const matches = ranked.filter((item) => item.normalized.includes(term));
    // A rare subject (a place, name, or activity) is more informative than a word common to every note.
    const weight = Math.log1p(ranked.length / (1 + matches.length));
    for (const item of matches) item.score += weight;
  }
  ranked.sort(
    (a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt || b.memory.id.localeCompare(a.memory.id),
  );
  const selected: Pick<MemoryView, "scope" | "text">[] = [];
  let remaining = 5000;
  for (const { memory } of ranked) {
    if (memory.text.length > remaining) continue;
    selected.push({ text: memory.text, scope: memory.scope });
    remaining -= memory.text.length;
  }
  return selected;
}

export function saveBotMemory(userId: string, threadId: string, raw: unknown, scope: unknown) {
  return transaction(() => {
    const thread = requireBotCapability(userId, threadId, "memory");
    if (scope !== thread.scope) throw new WebBotError(400, "请在对应的私聊或共享对话内确认保存。");
    const text = checkedText(raw, 420, "每条记忆");
    if (!text) throw new WebBotError(400, "请输入要记住的内容。");
    const { ownerId } = getBot(userId, thread.botId);
    const pending = Number(scope === "shared" && ownerId !== userId);
    const rows = sql("SELECT * FROM web_bot_memories WHERE thread=?").all(threadId) as MemoryRow[];
    let validCount = 0,
      proposals = 0,
      myProposals = 0;
    for (const row of rows) {
      if (row.pending && !validProposal(row)) {
        sql("DELETE FROM web_bot_memories WHERE id=?").run(row.id);
        continue;
      }
      if (row.pending) {
        proposals++;
        if (row.author === userId) myProposals++;
      } else validCount++;
      if (row.text === text && (!row.pending || (pending && row.author === userId)))
        return { memory: memoryView(row, thread.scope, userId, ownerId), pending: !!row.pending };
    }
    if (pending ? myProposals >= 8 || proposals >= 64 : validCount >= 32)
      throw new WebBotError(
        400,
        pending ? "待审核的建议已满，请先处理已有建议。" : "这里已有 32 条记忆，请先整理已有内容。",
      );
    const id = randomUUID();
    const row: MemoryRow = {
      id,
      thread: threadId,
      text,
      author: userId,
      authorAccess: thread.accessId,
      createdAt: Date.now(),
      pending,
    };
    sql("INSERT INTO web_bot_memories(id,thread,text,author,authorAccess,createdAt,pending) VALUES(?,?,?,?,?,?,?)").run(
      id,
      threadId,
      text,
      userId,
      row.authorAccess,
      row.createdAt,
      pending,
    );
    return { memory: memoryView(row, thread.scope, userId, ownerId), pending: !!pending };
  });
}

export function approveBotMemory(userId: string, threadId: string, id: string) {
  return transaction(() => {
    const thread = requireBotCapability(userId, threadId, "memory");
    const { ownerId } = getBot(userId, thread.botId);
    if (thread.scope !== "shared" || userId !== ownerId) throw new WebBotError(403, "只有所有者能将建议加入共享记忆。");
    const row = sql("SELECT * FROM web_bot_memories WHERE thread=? AND id=?").get(threadId, id) as MemoryRow | undefined;
    if (!row || (row.pending && !validProposal(row))) throw new WebBotError(404, "这条建议已失效。");
    if (row.pending) {
      const duplicate = sql("SELECT * FROM web_bot_memories WHERE thread=? AND text=? AND pending=0").get(
        threadId,
        row.text,
      ) as MemoryRow | undefined;
      if (duplicate) {
        sql("DELETE FROM web_bot_memories WHERE id=?").run(id);
        return memoryView(duplicate, "shared", userId, ownerId);
      }
      if (Number(sql("SELECT count(*) AS n FROM web_bot_memories WHERE thread=? AND pending=0").get(threadId)?.n) >= 32)
        throw new WebBotError(400, "共享记忆已有 32 条，请先整理已有内容。");
      sql("UPDATE web_bot_memories SET pending=0 WHERE id=?").run(id);
    }
    return memoryView({ ...row, pending: 0 }, "shared", userId, ownerId);
  });
}

export function removeBotMemory(userId: string, threadId: string, id: string) {
  transaction(() => {
    const thread = getBotThread(userId, threadId);
    const row = sql("SELECT * FROM web_bot_memories WHERE thread=? AND id=?").get(threadId, id) as MemoryRow | undefined;
    if (!row) throw new WebBotError(404, "找不到这条记忆。");
    if (row.author !== userId && (thread.scope !== "shared" || getBot(userId, thread.botId).ownerId !== userId)) {
      if (row.pending) throw new WebBotError(404, "找不到这条记忆。");
      throw new WebBotError(403, "你无权删除这条记忆。");
    }
    sql("DELETE FROM web_bot_memories WHERE id=?").run(id);
  });
}
