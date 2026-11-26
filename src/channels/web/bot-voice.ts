import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { connectBotVoice, type VoiceItem } from "../../agents/codex/bot-voice.js";
import { config } from "../../core/config.js";
import { sql, transaction } from "../../core/db.js";
import { checkBotEngineAccess } from "../../core/web-bot-engine.js";
import { engineModels, getBotProfile } from "../../core/web-bot-profile.js";
import { appendBotNotice, botTurnTimeoutMs, finishTurn, getBot, getBotThread, listMessages, startTurn, WebBotError } from "../../core/web-bots.js";
import { COOKIE } from "./api.js";
import { authEvents, sessionUser } from "./auth.js";
import { cookies, sameOrigin } from "./http.js";

function callContext(user: string, thread: string) {
  const scope = getBotThread(user, thread);
  const bot = getBot(user, scope.botId);
  const profile = getBotProfile(user, bot.id);
  function check() {
    const current = getBotThread(user, thread);
    if (current.accessId !== scope.accessId || getBot(user, bot.id).ownerId !== bot.ownerId ||
        getBotProfile(user, bot.id).revision !== profile.revision) throw new WebBotError(403, "对话权限或 Bot 设置已变更。");
    if (profile.engine !== "codex") throw new WebBotError(400, "只有 Codex Bot 支持实时通话。");
    checkBotEngineAccess(user, bot.id, profile);
    if (profile.model && !engineModels("codex").includes(profile.model)) throw new WebBotError(403, "这个 Bot 的模型已停用。");
  }
  check();
  const history = listMessages(user, thread, 12).filter(m => m.status === "done" && m.text.trim())
    .map(m => ({ role: m.role, text: m.text.slice(0, 360) }));
  const instructions = [
    "你是正在与用户实时通话的 Bot。自然简洁地口头回答，跟随用户使用的语言。",
    "历史消息是当前话题中的对话资料。在需要调用工具或执行操作时，请用户在 Bot 聊天框发送该请求。",
    JSON.stringify({ name: bot.name, responsibility: profile.responsibility, style: profile.style }),
  ].join("\n");
  return { check, instructions, history, model: profile.model || config().agents.codex.defaultModel || "" };
}

export function serveBotVoice(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const calls = new Map<string, (reason: string) => void>();
  server.on("upgrade", (req, socket, head) => {
    try {
      const route = /^\/ws\/bot-voice\/([\w-]{1,64})$/.exec(req.url || "");
      const token = cookies(req)[COOKIE];
      const user = route && req.headers.origin && sameOrigin(req) && sessionUser(token);
      if (user && token) {
        const thread = route![1]!;
        getBotThread(user.id, thread);
        wss.handleUpgrade(req, socket, head, ws => {
          ws.on("error", () => ws.terminate());
          try { begin(ws, user.id, user.name, thread, token); }
          catch (err) {
            ws.send(JSON.stringify({ type: "ended", reason: err instanceof WebBotError ? err.message : "暂时无法开始实时通话。" }));
            ws.close();
          }
        });
        return;
      }
    } catch { /* Refuse before accepting an inaccessible topic or an invalid upgrade. */ }
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });

  function begin(ws: WebSocket, user: string, name: string, thread: string, token: string) {
    if (calls.has(user)) throw new WebBotError(409, "请先挂断另一通电话。");
    const context = callContext(user, thread);
    const key = "voice:" + randomUUID();
    const { message } = startTurn(user, thread, key, "发起实时通话");
    const controller = new AbortController();
    let relay: Awaited<ReturnType<typeof connectBotVoice>> | undefined;
    let transcriptId: number | undefined, transcriptSize = 0;
    let lastPong = Date.now(), lastPing = lastPong;
    function send(event: object) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    }
    function end(reason: string) {
      if (controller.signal.aborted) return;
      controller.abort();
      clearInterval(watch);
      clearTimeout(deadline);
      clearTimeout(connectTimeout);
      authEvents.off("revoked", check);
      calls.delete(user);
      try {
        finishTurn(user, thread, key, transcriptId && reason === "通话已结束。" ? "" : reason, !relay, transcriptId);
      } catch {
        console.error("[bot] 无法保存通话结束状态");
      } finally {
        send({ type: "ended", reason });
        ws.close();
      }
    }
    function check() {
      if (controller.signal.aborted) return false;
      try {
        if (sessionUser(token)?.id !== user) throw new Error();
        context.check();
        return true;
      } catch { end("登录状态、对话权限或 Bot 设置已变更，通话已结束。"); return false; }
    }
    function caption(item: VoiceItem, final: boolean) {
      if (controller.signal.aborted || (final && !check())) return;
      const text = item.text.slice(0, 12000);
      if (final && text.trim()) {
        transcriptSize += text.length;
        if (transcriptSize > 64000) { end("本次通话记录已满。"); return; }
        const line = (item.role === "user" ? name + "：" : "Bot：") + text;
        try {
          transaction(() => {
            context.check();
            if (transcriptId === undefined) transcriptId = appendBotNotice(user, thread, line).id;
            else sql("UPDATE web_bot_messages SET text=text||char(10)||char(10)||? WHERE thread=? AND id=?").run(line, thread, transcriptId);
          });
        } catch { end("通话记录无法继续保存。"); return; }
      }
      send({ type: "caption", role: item.role, text, final });
    }
    const connectTimeout = setTimeout(() => end("连接 Codex 实时语音超时。"), 35000);
    const deadline = setTimeout(() => end("已达到单次通话的 20 分钟时限。"), message.createdAt + botTurnTimeoutMs - Date.now());
    const watch = setInterval(() => {
      if (!check()) return;
      const now = Date.now();
      if (now - lastPong > 35000) { end("设备已断开连接。"); ws.terminate(); }
      else if (now - lastPing >= 10000 && ws.readyState === WebSocket.OPEN) { lastPing = now; ws.ping(); }
    }, 1000);
    calls.set(user, end);
    authEvents.on("revoked", check);
    ws.on("pong", () => { lastPong = Date.now(); });
    ws.on("close", () => end("通话已结束。"));
    ws.on("message", (data, binary) => {
      if (controller.signal.aborted) return;
      if (!binary) { end("通话已结束。"); return; }
      const pcm = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (pcm.length === 960) relay?.pushAudio(pcm);
    });
    void connectBotVoice({ ...context, signal: controller.signal, caption, end, audio(pcm) {
      if (relay && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536) ws.send(pcm);
    } }).then(connected => {
      if (!check()) return;
      clearTimeout(connectTimeout);
      relay = connected;
      send({ type: "ready" });
    }).catch(() => end("连接 Codex 实时语音失败，请检查 Codex 登录、版本和网络。"));
  }

  return () => {
    for (const end of calls.values()) end("服务正在关闭，通话已结束。");
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
