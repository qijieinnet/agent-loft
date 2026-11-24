import type { IncomingMessage, ServerResponse } from "node:http";
import {
  changeBotDelegation,
  createBotDelegation,
  getBotDelegation,
  listBotDelegations,
  listDelegationTargets,
} from "../../core/web-bot-delegation.js";
import { cancelLocalDelegation, wakeDelegations } from "../../core/web-bot-delegation-worker.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

export async function handleBotDelegationApi(req: IncomingMessage, res: ServerResponse, url: URL, actor: string): Promise<void> {
  const route = /^\/api\/bots\/threads\/([\w-]+)\/delegations(?:\/([\w-]+)(?:\/(confirm|cancel|retry))?)?$/.exec(url.pathname);
  if (!route) throw new HttpError(404, "找不到这个地址。");
  const thread = route[1]!,
    id = route[2];
  if (!id && req.method === "GET") {
    sendJson(res, 200, {
      delegations: listBotDelegations(actor, thread),
      targets: listDelegationTargets(actor, thread, "requester"),
    });
    return;
  }
  if (id && !route[3] && req.method === "GET") return sendJson(res, 200, { delegation: getBotDelegation(actor, thread, id) });
  if ((id && !route[3]) || req.method !== "POST") throw new HttpError(405, "请求方式无效。");
  const body = await readJsonBody(req, 24 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "请重新提交委派。");
  if (!id) {
    if (typeof body.requestId !== "string" || typeof body.task !== "string" || typeof body.targetId !== "string")
      throw new HttpError(400, "请指定任务和接收的助手。");
    sendJson(res, 201, {
      delegation: createBotDelegation(actor, thread, body.requestId, { targetId: body.targetId, task: body.task }),
    });
    return;
  }
  const action = route[3] as "confirm" | "cancel" | "retry";
  if (typeof body.attempt !== "number") throw new HttpError(400, "请刷新委派后再试。");
  const delegation = changeBotDelegation(actor, thread, id, action, body.attempt, body.task);
  if (delegation.status === "cancelled") cancelLocalDelegation(id);
  else if (delegation.status === "queued") wakeDelegations();
  sendJson(res, 200, { delegation });
}
