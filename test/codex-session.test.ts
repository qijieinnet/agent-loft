// Codex 会话的轮次状态机：用假的 app-server，不起真进程。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-codex-"));
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
    onDropped: (n) => log.push(`dropped:${n}`),
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

test("启动途中被丢弃：turn/start 迟到返回后仍补发中断", async () => {
  calls.length = 0;
  const { session } = makeSession();
  session.send({ text: "一", attachments: [] });
  await tick();
  take("thread/start").resolve({ thread: { id: "th-late" } });
  await tick();
  const start = take("turn/start"); // 已发出，还没返回
  const disposing = session.dispose();
  await tick();
  take("thread/unsubscribe").resolve({});
  await disposing;
  start.resolve({ turn: { id: "tu-late" } });
  await tick();
  const interrupt = take("turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "th-late", turnId: "tu-late" });
});

test("app-server 退出：排队的消息逐条结清，界面不会一直显示忙", async () => {
  calls.length = 0;
  const { session, log } = makeSession();
  session.send({ text: "一", attachments: [] });
  await startTurn();
  session.send({ text: "二", attachments: [] });
  session.send({ text: "三", attachments: [] });
  exit("codex app-server 退出");
  assert.ok(log.some((l) => l.startsWith("error:")));
  assert.ok(log.includes("dropped:2"));
});

test("两条会话恢复同一个 thread：回复只进当前所有者，被接管的一方下次说话再取回", async () => {
  calls.length = 0;
  const a = makeSession();
  const b = makeSession();
  // A 开 thread
  a.session.send({ text: "a1", attachments: [] });
  const ta = await startTurn();
  notify("turn/completed", { threadId: ta.threadId, turn: { id: ta.turnId, status: "completed" } });
  await tick();
  // B 恢复同一个 thread（模拟：B 的 open 返回同一个 id）
  b.session.send({ text: "b1", attachments: [] });
  await tick();
  take("thread/start").resolve({ thread: { id: ta.threadId } });
  await tick();
  const tb = take("turn/start");
  tb.resolve({ turn: { id: "tb1" } });
  await tick();
  notify("item/completed", { threadId: ta.threadId, item: { type: "agentMessage", id: "x", text: "给B", phase: null } });
  notify("turn/completed", { threadId: ta.threadId, turn: { id: "tb1", status: "completed" } });
  await tick();
  assert.ok(b.log.includes("result:给B"));
  assert.ok(!a.log.some((l) => l.includes("给B")));
  // A 再说话：先 resume 取回所有权，回复回到 A
  a.session.send({ text: "a2", attachments: [] });
  await tick();
  take("thread/resume").resolve({ thread: { id: ta.threadId } });
  await tick();
  take("turn/start").resolve({ turn: { id: "ta2" } });
  await tick();
  notify("item/completed", { threadId: ta.threadId, item: { type: "agentMessage", id: "y", text: "给A", phase: null } });
  notify("turn/completed", { threadId: ta.threadId, turn: { id: "ta2", status: "completed" } });
  assert.ok(a.log.includes("result:给A"));
  assert.ok(!b.log.some((l) => l.includes("给A")));
});

test("thread 正在别的会话里跑：不接管，明确报错", async () => {
  calls.length = 0;
  const { CodexSession: Session } = await import("../src/agents/codex/session.js");
  const a = makeSession();
  a.session.send({ text: "长任务", attachments: [] });
  const ta = await startTurn();
  // B 想恢复 A 正在跑的 thread
  const log: string[] = [];
  const b = new Session(
    { cwd: "/tmp", uploadsDir: "/tmp", resumeId: ta.threadId },
    { onStep: () => {}, onTextDelta: () => {}, onText: () => {}, onResult: () => {}, onError: (e) => log.push(String(e)), onSessionId: () => {} },
    async () => ({ settlement: "deny", answers: {} }),
  );
  b.send({ text: "抢", attachments: [] });
  await tick();
  assert.equal(calls.some((c) => c.method === "thread/resume"), false);
  assert.match(log[0] ?? "", /正在另一个聊天里运行/);
  // A 不受影响
  notify("turn/completed", { threadId: ta.threadId, turn: { id: ta.turnId, status: "completed" } });
  assert.ok(a.log.some((l) => l.startsWith("result:")));
});

test("等 resume 响应期间原所有者开了新一轮：放弃接管，路由不动", async () => {
  calls.length = 0;
  const { CodexSession: Session } = await import("../src/agents/codex/session.js");
  const a = makeSession();
  a.session.send({ text: "a1", attachments: [] });
  const ta = await startTurn();
  notify("turn/completed", { threadId: ta.threadId, turn: { id: ta.turnId, status: "completed" } });
  await tick();
  // A 空闲，B 开始恢复（响应先挂着）
  const blog: string[] = [];
  const b = new Session(
    { cwd: "/tmp", uploadsDir: "/tmp", resumeId: ta.threadId },
    { onStep: () => {}, onTextDelta: () => {}, onText: (t) => blog.push(`text:${t}`), onResult: () => {}, onError: (e) => blog.push(`error:${e}`), onSessionId: () => {} },
    async () => ({ settlement: "deny", answers: {} }),
  );
  b.send({ text: "b1", attachments: [] });
  await tick();
  const resume = take("thread/resume");
  // 这期间 A 开了新一轮
  a.session.send({ text: "a2", attachments: [] });
  await tick();
  take("turn/start").resolve({ turn: { id: "ta2" } });
  await tick();
  // B 的 resume 这才回来
  resume.resolve({ thread: { id: ta.threadId } });
  await tick();
  assert.ok(blog.some((l) => /正在另一个聊天里运行/.test(l)));
  assert.equal(calls.some((c) => c.method === "turn/start"), false);
  // A 的输出仍然回到 A
  notify("item/completed", { threadId: ta.threadId, item: { type: "agentMessage", id: "z", text: "给A2", phase: null } });
  notify("turn/completed", { threadId: ta.threadId, turn: { id: "ta2", status: "completed" } });
  assert.ok(a.log.includes("result:给A2"));
  assert.ok(!blog.some((l) => l.includes("给A2")));
});

test("已丢弃会话的迟到 resume：thread 被别人持有时不退订", async () => {
  calls.length = 0;
  const { CodexSession: Session } = await import("../src/agents/codex/session.js");
  const a = makeSession();
  a.session.send({ text: "a1", attachments: [] });
  const ta = await startTurn();
  notify("turn/completed", { threadId: ta.threadId, turn: { id: ta.turnId, status: "completed" } });
  await tick();
  const b = new Session(
    { cwd: "/tmp", uploadsDir: "/tmp", resumeId: ta.threadId },
    { onStep: () => {}, onTextDelta: () => {}, onText: () => {}, onResult: () => {}, onError: () => {}, onSessionId: () => {} },
    async () => ({ settlement: "deny", answers: {} }),
  );
  b.send({ text: "b1", attachments: [] });
  await tick();
  const resume = take("thread/resume");
  await b.dispose(); // B 在 resume 返回前被丢弃（/new）
  resume.resolve({ thread: { id: ta.threadId } });
  await tick();
  assert.equal(calls.some((c) => c.method === "thread/unsubscribe" && c.params.threadId === ta.threadId), false);
});

test("分叉失败后重试仍然分叉，不会续写原会话", async () => {
  calls.length = 0;
  const { CodexSession: Session } = await import("../src/agents/codex/session.js");
  const log: string[] = [];
  const s = new Session(
    { cwd: "/tmp", uploadsDir: "/tmp", resumeId: "orig", fork: true },
    { onStep: () => {}, onTextDelta: () => {}, onText: () => {}, onResult: () => {}, onError: (e) => log.push(String(e)), onSessionId: () => {} },
    async () => ({ settlement: "deny", answers: {} }),
  );
  s.send({ text: "1", attachments: [] });
  await tick();
  take("thread/fork").reject(new Error("超时"));
  await tick();
  assert.equal(log.length, 1);
  s.send({ text: "2", attachments: [] });
  await tick();
  assert.equal(calls.some((c) => c.method === "thread/resume"), false);
  const retry = take("thread/fork");
  assert.equal(retry.params.threadId, "orig");
  retry.resolve({ thread: { id: "forked" } });
  await tick();
  take("turn/start").resolve({ turn: { id: "t" } });
  await tick();
  notify("turn/completed", { threadId: "forked", turn: { id: "t", status: "completed" } });
  await tick();
  // 分叉成功之后再说话：接着分叉出来的新 thread，不再分叉
  s.send({ text: "3", attachments: [] });
  await tick();
  assert.equal(calls.some((c) => c.method === "thread/fork"), false);
  assert.equal(take("turn/start").params.threadId, "forked");
});
