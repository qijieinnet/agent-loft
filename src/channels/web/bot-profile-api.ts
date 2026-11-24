import type { IncomingMessage, ServerResponse } from "node:http";
import {
  approveBotMemory,
  botEngineChoices,
  botMemoryPage,
  botModelChoices,
  getBotProfile,
  removeBotMemory,
  saveBotMemory,
  updateBotProfile,
} from "../../core/web-bot-profile.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

async function fields(req: IncomingMessage) {
  const body = await readJsonBody(req, 16 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "需要 JSON 对象。");
  return body;
}

export async function handleBotProfileApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  userId: string,
): Promise<void> {
  const profileRoute = /^\/api\/bots\/([\w-]+)\/(profile|models)$/.exec(url.pathname);
  if (profileRoute) {
    const id = profileRoute[1]!;
    if (req.method === "GET" && profileRoute[2] === "models")
      return sendJson(res, 200, { models: await botModelChoices(userId, id, url.searchParams.get("engine")) });
    if (profileRoute[2] === "profile") {
      if (req.method === "GET") return sendJson(res, 200, { profile: getBotProfile(userId, id), engines: botEngineChoices(userId) });
      if (req.method === "PATCH")
        return sendJson(res, 200, { profile: await updateBotProfile(userId, id, await fields(req)) });
    }
    throw new HttpError(405, "请求方式无效。");
  }
  const memoryRoute = /^\/api\/bots\/threads\/([\w-]+)\/memories(?:\/([\w-]+)(?:\/(approve))?)?$/.exec(url.pathname);
  if (!memoryRoute) throw new HttpError(404, "找不到这个地址。");
  const thread = memoryRoute[1]!,
    id = memoryRoute[2];
  if (!id) {
    if (req.method === "GET") return sendJson(res, 200, botMemoryPage(userId, thread));
    if (req.method === "POST") {
      const body = await fields(req);
      return sendJson(res, 201, saveBotMemory(userId, thread, body.text, body.scope));
    }
  } else if (memoryRoute[3] === "approve" && req.method === "POST") {
    if ((await fields(req)).scope !== "shared") throw new HttpError(400, "请确认所有成员都可以使用这条共享记忆。");
    return sendJson(res, 200, { memory: approveBotMemory(userId, thread, id) });
  } else if (!memoryRoute[3] && req.method === "DELETE") {
    removeBotMemory(userId, thread, id);
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(405, "请求方式无效。");
}
