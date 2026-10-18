// Codex 会话的轮次状态机：用假的 app-server，不起真进程。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_IM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-codex-"));
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const { appServer } = await import("../src/agents/codex/app-server.js");
const { CodexSession } = await import("../src/agents/codex/session.js");
import type { AgentEvents } from "../src/core/types.js";

type Call = { method: string; params: any; resolve: (v: unknown) => void; reject: (e: Error) => void };
const calls: Call[] = [];
(appServer as any).call = (method: string, params: any) =>
  new Promise((resolve, reject) => calls.push({ method, params, resolve, reject }));
const notify = (method: string, params: unknown) => {
  for (const h of (appServer as any).notificationHandlers) h(method, params);
};
const exit = (reason: string) => {
  for (const h of (appServer as any).exitHandlers) h(reason);
};
const tick = () => new Promise((r) => setTimeout(r, 10));
const take = (method: string) => {
  const i = calls.findIndex((c) => c.method === method);
  assert.ok(i >= 0, `没有发出 ${method}，实际：${calls.map((c) => c.method).join(",")}`);
  return calls.splice(i, 1)[0]!;
};

function makeSession() {
  const log: string[] = [];
  const events: AgentEvents = {
    onStep: () => {},
    onTextDelta: () => {},
    onText: (t) => log.push(`text:${t}`),
    onResult: (r) => log.push(`result:${r.text}`),
    onError: (e) => log.push(`error:${e instanceof Error ? e.message : e}`),
    onSessionId: () => {},
  };
  const session = new CodexSession({ cwd: "/tmp", uploadsDir: "/tmp" }, events, async () => ({ settlement: "deny", answers: {} }));
  return { session, log };
}

let threadN = 0;
async function startTurn(threadId?: string): Promise<{ threadId: string; turnId: string }> {
  await tick();
  const id = threadId ?? `th${++threadN}`;
  if (!threadId) take("thread/start").resolve({ thread: { id } });
  await tick();
  const turnId = `tu${Math.random().toString(36).slice(2, 8)}`;
  take("turn/start").resolve({ turn: { id: turnId } });
  await tick();
  return { threadId: id, turnId };
}

test("连续发送：上一轮没结束就排队，不并发开第二个 turn", async () => {
  calls.length = 0;
  const { session, log } = makeSession();
  session.send({ text: "一", attachments: [] });
  const t1 = await startTurn();
  session.send({ text: "二", attachments: [] });
  await tick();
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 0);
  notify("item/completed", { threadId: t1.threadId, item: { type: "agentMessage", id: "i1", text: "回一", phase: null } });
  notify("turn/completed", { threadId: t1.threadId, turn: { id: t1.turnId, status: "completed" } });
  await tick();
  const second = take("turn/start");
  assert.equal(second.params.input[0].text, "二");
  assert.deepEqual(log, ["text:回一", "result:回一"]);
});

test("第二轮启动途中点停止：拿到轮次 id 后立刻中断", async () => {
  calls.length = 0;
  const { session } = makeSession();
  session.send({ text: "一", attachments: [] });
  const t1 = await startTurn();
  notify("turn/completed", { threadId: t1.threadId, turn: { id: t1.turnId, status: "completed" } });
  await tick();
  session.send({ text: "二", attachments: [] });
  await tick();
  await session.interrupt(); // turn/start 还没回
  const start2 = take("turn/start");
  start2.resolve({ turn: { id: "tu-second" } });
  await tick();
  const interrupt = take("turn/interrupt");
  assert.equal(interrupt.params.turnId, "tu-second");
});

test("thread/start 途中被丢弃：迟到的 thread 只清理，不开轮次", async () => {
  calls.length = 0;
  const { session, log } = makeSession();
  session.send({ text: "一", attachments: [] });
  await tick();
  const pendingStart = take("thread/start");
  await session.dispose();
  pendingStart.resolve({ thread: { id: "late" } });
  await tick();
  assert.equal(calls.some((c) => c.method === "turn/start"), false);
  assert.ok(calls.some((c) => c.method === "thread/unsubscribe" && c.params.threadId === "late"));
  assert.deepEqual(log, []);
});

test("app-server 退出：在途轮次立刻报错收尾，迟到的完成通知不再收第二次尾", async () => {
  calls.length = 0;
  const { session, log } = makeSession();
  session.send({ text: "一", attachments: [] });
  const t1 = await startTurn();
  notify("turn/started", { threadId: t1.threadId, turn: { id: t1.turnId } });
  exit("codex app-server 退出");
  assert.equal(log.length, 1);
  assert.match(log[0]!, /^error:codex app-server 退出/);
  notify("turn/completed", { threadId: t1.threadId, turn: { id: t1.turnId, status: "completed" } });
  assert.equal(log.length, 1);
  // 下一条消息：thread 已标记待恢复，先 resume 再开轮次
  session.send({ text: "二", attachments: [] });
  await tick();
  assert.ok(calls.some((c) => c.method === "thread/resume"));
});

test("error 通知之后再来的 turn/completed 不重复收尾", async () => {
  calls.length = 0;
  const { session, log } = makeSession();
  session.send({ text: "一", attachments: [] });
  const t1 = await startTurn();
  notify("error", { threadId: t1.threadId, error: { message: "炸了" }, willRetry: false });
  notify("turn/completed", { threadId: t1.threadId, turn: { id: t1.turnId, status: "failed", error: { message: "炸了" } } });
  assert.deepEqual(log, ["error:炸了"]);
});
