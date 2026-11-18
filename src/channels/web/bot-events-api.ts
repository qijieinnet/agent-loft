import type { IncomingMessage, ServerResponse } from "node:http";
import { watchAvailable } from "../../bot-event-runner.js";
import { acceptResult, botEvents, createWatch, deleteWatch, getWatch, hookWatch, incidentsFor, parseBackupResult, reasons, watchesFor } from "../../core/bot-events.js";
import { sql } from "../../core/db.js";
import { hub } from "../../core/hub.js";
import { getConversation } from "../../core/store.js";
import { pushOptions } from "../../core/tasks.js";
import type { User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

export async function receiveBackup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (!hookWatch(token)) throw new HttpError(401, "监听凭据无效");
  const body = await readJsonBody(req, 4096);
  const w = hookWatch(token);
  if (!w || !watchAvailable(w)) throw new HttpError(403, "监听不可用");
  let result;
  try { result = parseBackupResult(body); }
  catch (err) { throw new HttpError(400, (err as Error).message); }
  try { sendJson(res, 200, { result: acceptResult(w, result) }); }
  catch (err) {
    if (err instanceof RangeError) throw new HttpError(429, err.message);
    throw err;
  }
}

function contact(user: User, key: unknown) {
  const c = typeof key === "string" && getConversation(key);
  if (!c || c.owner !== user.id || c.hidden || c.assistant !== "active") throw new HttpError(404, "找不到这个 bot");
  return c;
}

export async function handleBotEventsApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<void> {
  const method = req.method;
  const root = "/api/bot-events";
  if (url.pathname === root && method === "GET") {
    const id = url.searchParams.get("watch");
    const w = id ? getWatch(id) : undefined;
    const c = contact(user, id ? w?.conv : url.searchParams.get("key"));
    const watches = watchesFor(user.id, c.key).map((w) => ({
      id: w.id, name: w.name, source: w.source, destination: w.destination, analyze: !!w.analyze, lastSeen: w.last_seen, lastStatus: w.last_status,
      events: incidentsFor(w.id).map((e) => ({ id: e.id, run: e.run, reason: reasons[e.reason], at: e.at, delivery: e.delivery,
        attempts: e.attempts, error: e.error, analysis: e.analysis, analysisKey: e.analysis_key })),
    }));
    sendJson(res, 200, { key: c.key, watches, admin: user.role === "admin", unavailable: hub.assistantUnavailable(c), feishu: pushOptions(user.id).feishu });
    return;
  }
  if (url.pathname === root && method === "POST") {
    const body = await readJsonBody(req);
    const c = contact(user, body?.key);
    if (hub.assistantUnavailable(c)) throw new HttpError(409, "这个 bot 当前不可用");
    const { name, source, destination, analyze = false } = body;
    if (typeof name !== "string" || !name.trim() || name.length > 60 || typeof analyze !== "boolean") throw new HttpError(400, "请检查监听名称和分析设置");
    if (source !== "webhook" && source !== "backup") throw new HttpError(400, "事件来源无效");
    if (source === "backup" && user.role !== "admin") throw new HttpError(403, "只有管理员可监听本机数据库备份");
    if (typeof destination !== "string" || !(["inbox", "web", ...pushOptions(user.id).feishu.map((b) => "feishu:" + b.id)].includes(destination))) {
      throw new HttpError(400, "请选择自己的通知渠道");
    }
    let created;
    try { created = createWatch(user.id, c.key, name, source, destination, analyze); }
    catch (err) {
      if (err instanceof RangeError) throw new HttpError(400, err.message);
      throw err;
    }
    sendJson(res, 201, created);
    botEvents.emit("changed", user.id);
    return;
  }
  const match = /^\/api\/bot-events\/([a-f0-9-]+)(?:\/retry\/(\d+))?$/.exec(url.pathname);
  const w = match && getWatch(match[1]!);
  if (!w || w.owner !== user.id) throw new HttpError(404, "监听不存在");
  contact(user, w.conv);
  if (method === "DELETE" && !match[2]) deleteWatch(w.id);
  else if (method === "POST" && match[2]) {
    if (!watchAvailable(w)) throw new HttpError(409, "这个 bot 当前不可用");
    const changed = sql("UPDATE bot_incidents SET delivery='pending',attempts=0,next_try=0,error=NULL WHERE watch=? AND id=? AND delivery='failed'").run(w.id, Number(match[2])).changes;
    if (!changed) throw new HttpError(409, "这条记录当前无法重试");
    botEvents.emit("ready");
  } else throw new HttpError(404, "接口不存在");
  sendJson(res, 200, { ok: true });
  botEvents.emit("changed", user.id);
}
