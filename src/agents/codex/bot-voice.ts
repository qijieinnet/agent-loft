// Bot calls use a disposable Codex thread. No workbench session or local project context enters the call.
import os from "node:os";
import { appServer } from "./app-server.js";
import { botChatConfig } from "./session.js";
import { RealtimeRelay } from "../../core/realtime-relay.js";

export type VoiceItem = { role: "user" | "assistant"; text: string };
type Options = {
  signal: AbortSignal; instructions: string; history: VoiceItem[]; model: string;
  audio: (data: Buffer) => void; caption: (item: VoiceItem, final: boolean) => void; end: (reason: string) => void;
};

export async function connectBotVoice(opts: Options) {
  const { signal } = opts;
  const cwd = os.tmpdir();
  const config = await botChatConfig(cwd);
  signal.throwIfAborted();
  const { thread } = await appServer.call<{ thread: { id: string } }>("thread/start", {
    cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", ...(opts.model ? { model: opts.model } : {}),
    config: { ...config, "features.memories": false, "memories.use_memories": false, "memories.generate_memories": false },
    baseInstructions: opts.instructions,
  });
  const threadId = thread.id;
  let relay: RealtimeRelay | undefined;
  let stopped = false, started = false, exited = false;
  let acceptSdp!: (value: string) => void;
  let cancelSdp!: (reason: Error) => void;
  const answer = new Promise<string>((resolve, reject) => { acceptSdp = resolve; cancelSdp = reject; });
  void answer.catch(() => {});
  const offExit = appServer.onExit(() => { exited = true; opts.end("Codex 已断开连接。"); });
  const offNotify = appServer.onNotification((method, params) => {
    const p = params as { threadId?: string; sdp?: string; role?: string; text?: string; delta?: string };
    if (p.threadId !== threadId || signal.aborted) return;
    if (method === "thread/realtime/sdp" && p.sdp) acceptSdp(p.sdp);
    else if (method === "thread/realtime/error") opts.end("Codex 实时语音不可用，请检查账号权限和服务连接。");
    else if (method === "thread/realtime/closed") opts.end("Codex 已结束通话。");
    else if (p.role === "user" || p.role === "assistant") {
      const final = method === "thread/realtime/transcript/done";
      const text = final ? p.text : method === "thread/realtime/transcript/delta" ? p.delta : undefined;
      if (text) opts.caption({ role: p.role, text }, final);
    }
  });
  function close() {
    if (stopped) return;
    stopped = true;
    offNotify();
    offExit();
    signal.removeEventListener("abort", close);
    relay?.close();
    cancelSdp(new Error("通话已结束"));
    if (!exited) {
      const stop = started ? appServer.call("thread/realtime/stop", { threadId }).catch(() => {}) : Promise.resolve();
      void stop.then(() => appServer.call("thread/unsubscribe", { threadId })).catch(() => {});
    }
  }
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    const local = await RealtimeRelay.create();
    relay = local.relay;
    if (signal.aborted) { relay.close(); signal.throwIfAborted(); }
    relay.onAudio = opts.audio;
    relay.onFailed = opts.end;
    started = true;
    await appServer.call("thread/realtime/start", {
      threadId, outputModality: "audio", version: "v3", transport: { type: "webrtc", sdp: local.offer },
      includeStartupContext: false, realtimeStartInstructions: opts.instructions,
      initialItems: [{ role: "developer", text: opts.instructions }, ...opts.history],
    });
    await relay.accept(await answer);
    signal.throwIfAborted();
    return relay;
  } catch (err) {
    close();
    throw err;
  }
}
