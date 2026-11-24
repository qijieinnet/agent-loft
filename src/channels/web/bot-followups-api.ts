import type { IncomingMessage, ServerResponse } from "node:http";
import { applyBotFollowup, botFollowupDetail, checkFollowupHook, ingestFollowupEvent, listBotFollowups, pendingBotDecisions, setFollowupHook, type FollowupAction } from "../../core/web-bot-followups.js";
import { WebBotError } from "../../core/web-bots.js";
import type { User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

async function fields(req: IncomingMessage) {
  const body = await readJsonBody(req, 12 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "需要 JSON 对象。");
  return body;
}
export async function handleBotFollowupsApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<void> {
  if (url.pathname === "/api/bots/followups/pending" && req.method === "GET")
    return sendJson(res, 200, { items: pendingBotDecisions(user.id) });
  const match = /^\/api\/bots\/threads\/([\w-]+)\/followups(?:\/([\w-]+)(?:\/(actions|hook))?)?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, "找不到这个地址。");
  const thread = match[1]!, id = match[2], part = match[3];
  if (req.method === "GET" && !part) {
    const result = id ? botFollowupDetail(user.id, thread, id) : {followups:listBotFollowups(user.id, thread)};
    return sendJson(res, 200, result);
  }
  if (id && part === "hook" && (req.method === "POST" || req.method === "DELETE"))
    return sendJson(res, 200, setFollowupHook(user.id, thread, id, req.method === "POST") ?? {ok:true});
  if (req.method !== "POST" || (id && part !== "actions")) throw new HttpError(405, "请求方式无效。");
  const body = await fields(req);
  const action = { ...body, id, kind: id ? body.kind : "create" } as FollowupAction;
  // 创建只走集合端点，不能把针对旧事项的动作改为新建。
  if (id && action.kind === "create") throw new HttpError(400, "操作无效。");
  const item = applyBotFollowup(user.id, thread, typeof body.requestId === "string" ? body.requestId : "", action);
  sendJson(res, id ? 200 : 201, {followup:item});
}

export async function handleBotEvent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const match = /^\/api\/bot-events\/([\w-]+)$/.exec(url.pathname);
  if (!match || req.method !== "POST") throw new HttpError(404, "找不到这个地址。");
  const bearer = /^Bearer ([\w-]{43})$/i.exec(req.headers.authorization ?? "");
  if (!bearer) throw new HttpError(404, "状态更新地址无效。");
  const id = match[1]!, token = bearer[1]!;
  try {
    checkFollowupHook(id, token);
    ingestFollowupEvent(id, token, await fields(req));
    sendJson(res, 200, {ok:true});
  } catch (error) {
    if (error instanceof WebBotError) throw new HttpError(error.status, error.message);
    throw error;
  }
}
