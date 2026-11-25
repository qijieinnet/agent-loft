import { saveClaudeSettings } from "../../core/web-bot-claude-tools.js";
import { nativeCatalog } from "../../core/web-bot-native-catalog.js";
import { botSkillSources, importBotSkill } from "../../core/web-bot-skill-files.js";
import { callImage, decideToolCall, threadCalls } from "../../core/web-bot-calls.js";
import { saveBotCodexSettings } from "../../core/web-bot-codex-tools.js";
import { discoverBotTools, listBotExtensions, removeBotExtension, saveBotExtension, saveToolGrants } from "../../core/web-bot-extensions.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { acceptInvite, createBot, createInvite, getBot, getBotMessage, getBotThread, listBots, listMessages, removeMember, deleteOwnedBot, leaveBot, transferBot, renameBot, startTurn, stopSharing, WebBotError, type BotImage } from "../../core/web-bots.js";
import { runBotTurn } from "../../core/web-bot-reply.js";
import { listBotReminders } from "../../core/web-bot-reminders.js";
import { sanitizeBotImage } from "../../core/web-bot-photo.js";
import { retryableBotMessages, retryBotTurn } from "../../core/web-bots.js";
import type { User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { delegationCredits } from "../../core/web-bot-delegation.js";
import { handleBotDelegationApi } from "./bot-delegation-api.js";
import { handleBotFollowupsApi } from "./bot-followups-api.js";
import { handleBotProfileApi } from "./bot-profile-api.js";

import { listBotArchives, readBotArchive, readArchivedPhoto, requireBotArchive } from "../../core/web-bot-archives.js";
const MAX_PHOTO = 3 * 1024 * 1024;

async function bodyOf(req: IncomingMessage, limit?: number) {
  const body = await readJsonBody(req, limit);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "消息格式无效。");
  return body;
}

async function photo(value: unknown): Promise<BotImage[]> {
  if (value == null) return [];
  if (typeof value !== "object" || !("data" in value) || typeof value.data !== "string") throw new HttpError(400, "照片格式不对，请重新选择。");
  if (value.data.length > MAX_PHOTO * 4 / 3) throw new HttpError(413, "请选择小于 3 MB 的照片。");
  if (!value.data || value.data.length % 4 !== 0 || /[^a-zA-Z0-9+/=]/.test(value.data)) throw new HttpError(400, "照片数据不完整。");
  const content = Buffer.from(value.data, "base64");
  if (content.toString("base64") !== value.data) throw new HttpError(400, "照片数据不完整。");
  return [await sanitizeBotImage({ name: "照片", mediaType: "", data: value.data })];
}

function localZone(value: unknown) {
  if (value == null || value === "") return Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof value === "string" && value.length <= 100) {
    try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; } catch { /* 客户端传入的时区有误 */ }
  }
  throw new HttpError(400, "无法识别设备时区，请刷新后重试。");
}

function positiveInteger(value: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, "消息编号无效。");
  return n;
}

async function threads(req: IncomingMessage, res: ServerResponse, url: URL, user: User, threadId: string, imageId?: string) {
  if (req.method === "GET" && imageId) {
    const item = getBotMessage(user.id, threadId, positiveInteger(imageId))?.images[0];
    if (!item?.data) throw new HttpError(404, "找不到这张照片。");
    const safe = await sanitizeBotImage({ ...item, data: item.data });
    getBotThread(user.id, threadId);
    const file = Buffer.from(safe.data, "base64");
    res.writeHead(200, { "Content-Type": safe.mediaType, "Content-Length": file.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
    res.end(file);
    return;
  }
  if (!imageId && req.method === "GET") {
    const before = url.searchParams.get("before");
    const rows = listMessages(user.id, threadId, 61, before === null ? undefined : positiveInteger(before));
    const hasOlder = rows.length > 60;
    if (hasOlder) rows.shift();
    const credits = rows.length ? delegationCredits(user.id,threadId,rows[0]!.id,rows[rows.length-1]!.id) : new Map<number,string>();
    const retries = rows.length ? retryableBotMessages(user.id, threadId, rows[0]!.id, rows[rows.length - 1]!.id) : new Set<number>();
    const calls = rows.length ? threadCalls(user.id, threadId, rows[0]!.id, rows.at(-1)!.id) : new Map();
    const messages = rows.map(({ images, ...message }) => ({
      ...message, ...(calls.has(message.id) ? { calls: calls.get(message.id) } : {}), image: images.length > 0, canRetry: retries.has(message.id), ...(credits.has(message.id) ? { delegatedBy: credits.get(message.id) } : {}),
    }));
    sendJson(res, 200, { messages, pending: messages.some(m => m.status === "pending"), nextBefore: hasOlder ? messages[0]!.id : null, reminders: listBotReminders(user.id, threadId) });
    return;
  }
  if (!imageId && req.method === "POST") {
    getBotThread(user.id, threadId);
    const body = await bodyOf(req, MAX_PHOTO * 4 / 3 + 64 * 1024);
    const timezone = localZone(body.timezone);
    if (typeof body.requestId !== "string" || typeof (body.text ?? "") !== "string") throw new HttpError(400, "消息格式无效，请重新发送。");
    const requestId = body.requestId;
    if (requestId.startsWith("retry:")) throw new HttpError(400, "消息标识无效。");
    const { message, started } = startTurn(user.id, threadId, requestId, (body.text as string | undefined) ?? "", await photo(body.image));
    if (started) void runBotTurn(user.id, threadId, message, requestId, timezone).catch(() => console.error("[bot] 暂时无法保存回复状态"));
    sendJson(res, 202, { ok: true, messageId: message.id });
    return;
  }
  throw new HttpError(405, "请求方式无效。");
}

export async function handleBotsApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<void> {
  const p = url.pathname;
  const method = req.method;
  try {
    const generated = /^\/api\/bots\/threads\/([\w-]+)\/calls\/([\w-]+)\/image$/.exec(p);
    if (generated && method === "GET") {
      const data = callImage(user.id, generated[1]!, generated[2]!);
      const { default: sharp } = await import("sharp");
      const bytes = await sharp(data, { limitInputPixels: 60000000 }).png().toBuffer();
      getBotThread(user.id, generated[1]!);
      res.writeHead(200, { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
      res.end(bytes);
      return;
    }
    const decision = /^\/api\/bots\/threads\/([\w-]+)\/calls\/([\w-]+)\/(approve|deny)$/.exec(p);
    if (decision && method === "POST") {
      decideToolCall(user.id, decision[1]!, decision[2]!, decision[3] === "approve");
      return sendJson(res, 200, { ok: true });
    }
    const claudeTools = /^\/api\/bots\/([\w-]+)\/claude-tools$/.exec(p);
    if (claudeTools && method === "PATCH") return sendJson(res, 200, saveClaudeSettings(user.id, claudeTools[1]!, await bodyOf(req, 4096)));
    const codexTools = /^\/api\/bots\/([\w-]+)\/codex-tools$/.exec(p);
    if (codexTools) {
      const bot = codexTools[1]!;
      if (method === "GET") return sendJson(res, 200, await nativeCatalog(user.id, bot));
      if (method !== "PATCH") throw new HttpError(405, "请求方式无效。");
      const input = await bodyOf(req, 8192);
      if (Array.isArray(input.extra) && input.extra.length) {
        const { options } = await nativeCatalog(user.id, bot);
        if (input.extra.some(id => !options.some(o => o.id === id && o.available))) throw new HttpError(400, "此版本不支持所选能力。");
      }
      return sendJson(res, 200, saveBotCodexSettings(user.id, bot, input));
    }
    const bundles = /^\/api\/bots\/([\w-]+)\/skill-packages$/.exec(p);
    if (bundles) {
      if (method === "GET") return sendJson(res, 200, { sources: await botSkillSources(user.id, bundles[1]!) });
      if (method === "POST") return sendJson(res, 201, await importBotSkill(user.id, bundles[1]!, await bodyOf(req, 8 * 1024 * 1024)));
      throw new HttpError(405, "请求方式无效。");
    }
    const extensions = /^\/api\/bots\/([\w-]+)\/extensions(?:\/([\w-]+)(?:\/(discover|grants))?)?$/.exec(p);
    if (extensions) {
      const [, bot, id, action] = extensions;
      if (method === "GET" && !id) return sendJson(res, 200, listBotExtensions(user.id, bot!));
      const body = await bodyOf(req, 400 * 1024);
      if (method === "POST" && !id) return sendJson(res, 201, saveBotExtension(user.id, bot!, body));
      if (id && !action && method === "PATCH") return sendJson(res, 200, saveBotExtension(user.id, bot!, body, id));
      if (id && !action && method === "DELETE") {
        removeBotExtension(user.id, bot!, id, body.revision);
        return sendJson(res, 200, { ok: true });
      }
      if (id && action === "discover" && method === "POST") return sendJson(res, 200, await discoverBotTools(user.id, bot!, id, body.revision));
      if (id && action === "grants" && method === "PATCH") return sendJson(res, 200, saveToolGrants(user.id, bot!, id, body));
      throw new HttpError(405, "请求方式无效。");
    }
    const archive = /^\/api\/bots\/([\w-]+)\/archives(?:\/([\w-]+)(?:\/photos\/(\d+))?)?$/.exec(p);
    if (archive) {
      if (method !== "GET") throw new HttpError(405, "共享归档为只读。");
      const [, botId, threadId, messageId] = archive;
      if (!threadId) return sendJson(res, 200, { archives: listBotArchives(user.id, botId!) });
      if (messageId) {
        const photo = await sanitizeBotImage(readArchivedPhoto(user.id, botId!, threadId, positiveInteger(messageId)));
        requireBotArchive(user.id, botId!, threadId);
        const file = Buffer.from(photo.data, "base64");
        res.writeHead(200, { "Content-Type": photo.mediaType, "Content-Length": file.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
        res.end(file);
        return;
      }
      const before = url.searchParams.get("before");
      return sendJson(res, 200, readBotArchive(user.id, botId!, threadId,
        url.searchParams.get("section") || "messages", before == null ? Number.MAX_SAFE_INTEGER : positiveInteger(before)));
    }
    if (/\/(?:profile|models|memories)(?:\/|$)/.test(p)) return await handleBotProfileApi(req, res, url, user.id);
    if (/\/delegations(?:\/|$)/.test(p)) return await handleBotDelegationApi(req, res, url, user.id);
    if (/\/followups(?:\/|$)/.test(p)) return await handleBotFollowupsApi(req, res, url, user);
    if (p === "/api/bots" && method === "GET") return sendJson(res, 200, { userId: user.id, bots: listBots(user.id) });
    if (p === "/api/bots" && method === "POST") {
      const body = await bodyOf(req);
      return sendJson(res, 201, { bot: createBot(user.id, typeof body.name === "string" ? body.name : "") });
    }
    if (p === "/api/bots/join" && method === "POST") {
      const body = await bodyOf(req);
      return sendJson(res, 200, { bot: acceptInvite(user.id, typeof body.token === "string" ? body.token : "") });
    }
    const retry = /^\/api\/bots\/threads\/([\w-]+)\/messages\/(\d+)\/retry$/.exec(p);
    if (retry && method === "POST") {
      const timezone = localZone((await bodyOf(req, 1024)).timezone);
      const { message, started } = await retryBotTurn(user.id, retry[1]!, positiveInteger(retry[2]!));
      if (started) void runBotTurn(user.id, retry[1]!, message, message.requestId!, timezone).catch(() => console.error("[bot] 暂时无法保存重试状态"));
      return sendJson(res, 202, { messageId: message.id });
    }
    const thread = /^\/api\/bots\/threads\/([\w-]+)\/messages(?:\/(\d+)\/image)?$/.exec(p);
    if (thread) return await threads(req, res, url, user, thread[1]!, thread[2]);

    const route = /^\/api\/bots\/([\w-]+)(?:\/(invites|members|sharing|leave|owner)(?:\/([\w-]+))?)?$/.exec(p);
    if (!route) throw new HttpError(404, "找不到这个地址。");
    const [, id, part, member] = route;
    if (part === "invites" && !member && method === "POST") return sendJson(res, 201, createInvite(user.id, id!));
    if (part === "members" && !member && method === "GET") {
      const { ownerId, members } = getBot(user.id, id!);
      return sendJson(res, 200, { ownerId, members });
    }
    if (part === "members" && member && method === "DELETE") {
      removeMember(user.id, id!, member);
      return sendJson(res, 200, { ok: true });
    }
    if (part === "sharing" && !member && method === "DELETE") return sendJson(res, 200, { bot: stopSharing(user.id, id!) });
    if (part === "leave" && !member && method === "POST") {
      leaveBot(user.id, id!);
      return sendJson(res, 200, { ok: true });
    }
    if (part === "owner" && !member && method === "POST") {
      const body = await bodyOf(req);
      if (typeof body.userId !== "string") throw new HttpError(400, "请选择新所有者。");
      return sendJson(res, 200, { bot: transferBot(user.id, id!, body.userId) });
    }
    if (!part && method === "DELETE") {
      deleteOwnedBot(user.id, id!);
      return sendJson(res, 200, { ok: true });
    }
    if (!part && method === "PATCH") {
      const body = await bodyOf(req);
      return sendJson(res, 200, { bot: renameBot(user.id, id!, typeof body.name === "string" ? body.name : "") });
    }
    throw new HttpError(404, "找不到这个地址。");
  } catch (err) {
    if (err instanceof WebBotError) throw new HttpError(err.status, err.message);
    throw err;
  }
}
