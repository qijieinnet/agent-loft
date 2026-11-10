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
import type { AgentEvents, ContextUsage, InteractionSpec, SessionOptions, Settlement, TokenUsage, TurnResult } from "../src/core/types.js";
import type { ExpertRuntime } from "../src/core/experts.js";

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

function makeSession(opts: Partial<SessionOptions> = {}, host = async (_spec: InteractionSpec) => ({ settlement: "deny" as Settlement, answers: {} })) {
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
  const session = new CodexSession({ cwd: "/tmp", uploadsDir: "/tmp", ...opts }, events, host);
  return { session, log, events };
}

function expert(): ExpertRuntime {
  return { id: "e_test", rev: 1, name: "测试专家", prompt: "", basePrompt: "lean", access: "web", webSearch: false, webFetch: false, skills: [], mcp: { remote: { type: "http", url: "https://mcp.example.com", headers: {} } }, askMcp: ["remote"], machineMcp: [], subagents: [], codexTools: [], memory: false };
}

test("自定义专家：MCP 配置读取失败时不启动 thread，下一条消息可以重试", async () => {
  calls.length = 0;
  const { session, log } = makeSession({ expert: expert() });
  session.send({ text: "一", attachments: [] });
  await tick();
  take("config/read").reject(new Error("config unavailable"));
  await tick();
  assert.deepEqual(calls, [], "读不到机器上的 MCP 就不能启动未受限制的 thread");
  assert.ok(log.some((line) => line.includes("无法应用专家的 MCP 限制")));
  session.send({ text: "二", attachments: [] });
  await tick();
  take("config/read").resolve({ config: { mcp_servers: { machine: {}, remote: {} } } });
  await tick();
  const start = take("thread/start");
  assert.equal(start.params.config["mcp_servers.machine.enabled"], false);
  assert.equal(start.params.config["mcp_servers.remote"].default_tools_approval_mode, "prompt");
  await session.dispose();
  start.reject(new Error("disposed"));
  await tick();
});

test("自定义专家：start / resume / fork 失败不会去掉限制重试，再发消息仍带完整配置", async () => {
  for (const kind of ["start", "resume", "fork"] as const) {
    calls.length = 0;
    const { session, log } = makeSession({ expert: expert(), ...(kind === "start" ? {} : { resumeId: `expert-${kind}` }), ...(kind === "fork" ? { fork: true } : {}) });
    session.send({ text: "一", attachments: [] });
    await tick();
    const first = take(`thread/${kind}`);
    assert.equal(first.params.config["features.shell_tool"], false);
    assert.equal(first.params.config.web_search, "disabled");
    assert.equal(first.params.config["mcp_servers.machine.enabled"], false);
    first.reject(new Error("expert config rejected"));
    await tick();
    assert.deepEqual(calls, [], "不能自动退回不带专家限制的配置");
    assert.ok(log.some((line) => line.includes("expert config rejected")));
    session.send({ text: "再试", attachments: [] });
    await tick();
    const retry = take(`thread/${kind}`);
    assert.deepEqual(retry.params.config, first.params.config, "用户重试仍然带同一份完整限制");
    await session.dispose();
    retry.reject(new Error("disposed"));
    await tick();
  }
});

test("内置 Agent：start / resume / fork 应用个人 MCP 选择与机器技能开关，支持全部关闭", async () => {
  for (const kind of ["start", "resume", "fork"] as const) {
    calls.length = 0;
    const { session } = makeSession({
      ...(kind === "start" ? {} : { resumeId: `builtin-${kind}` }), ...(kind === "fork" ? { fork: true } : {}),
      skills: { userId: "u_test", admin: true, machineSkills: false, list: [], env: {} },
      builtinMcp: { inheritMachine: false, machineMcp: ["machine"], mcp: { personal: { type: "http", url: "https://personal.example.com", headers: {} } }, askMcp: ["personal"] },
    });
    session.send({ text: "test", attachments: [] }); await tick();
    const call = take(`thread/${kind}`);
    assert.equal(call.params.config["mcp_servers.remote.enabled"], false);
    assert.equal(call.params.config["mcp_servers.machine.enabled"], true);
    assert.equal(call.params.config["mcp_servers.personal"].default_tools_approval_mode, "prompt");
    assert.equal(call.params.config["skills.include_instructions"], false);
    assert.equal(call.params.config["features.skill_search"], false);
    await session.dispose(); call.reject(new Error("disposed")); await tick();
  }
  calls.length = 0;
  const { session } = makeSession({ builtinMcp: { inheritMachine: false, machineMcp: [], mcp: {}, askMcp: [] } });
  session.send({ text: "test", attachments: [] }); await tick();
  const start = take("thread/start");
  assert.equal(start.params.config["mcp_servers.machine.enabled"], false);
  assert.equal(start.params.config["mcp_servers.remote.enabled"], false);
  await session.dispose(); start.reject(new Error("disposed")); await tick();
});

test("内置 Agent 的个人 MCP 保留调用前审批", async () => {
  const { session } = makeSession({ builtinMcp: { inheritMachine: false, machineMcp: [], mcp: { personal: { type: "http", url: "https://personal.example.com", headers: {} } }, askMcp: ["personal"] } }, async () => ({ settlement: "allow-once", answers: {} }));
  const request = { serverName: "personal", mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" } };
  assert.deepEqual(await session.handleServerRequest("mcpServer/elicitation/request", request), { action: "accept", content: null, _meta: null });
  assert.deepEqual(await session.handleServerRequest("mcpServer/elicitation/request", { ...request, serverName: "other" }), { action: "decline", content: null, _meta: null });
  await session.dispose();
});

test("MCP 调用审批：允许、拒绝、取消和超时按协议返回；每次询问不沿用命令授权", async () => {
  const seen: InteractionSpec[] = [];
  const decisions: Settlement[] = ["allow-once", "deny", "cancelled", "timeout"];
  const { session } = makeSession({ expert: expert() }, async (spec) => {
    seen.push(spec);
    return { settlement: decisions.shift()!, answers: {} };
  });
  (session as any).allowAll = true;
  const request = { serverName: "remote", mode: "form", message: "Allow remote to run lookup?", _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { symbol: "AAPL" } }, requestedSchema: { type: "object", properties: {} } };
  for (const action of ["accept", "decline", "cancel", "decline"]) {
    assert.deepEqual(await session.handleServerRequest("mcpServer/elicitation/request", request), { action, content: null, _meta: null });
  }
  assert.equal(seen.length, 4);
  assert.ok(seen.every((spec) => spec.kind === "approval" && !spec.allowSession && !spec.alwaysLabel));
  assert.equal(seen[0]!.kind, "approval");
  if (seen[0]!.kind === "approval") assert.match(seen[0]!.detail, /AAPL/);
  for (const invalid of [{ ...request, _meta: {} }, { ...request, mode: "url" }, { ...request, serverName: "not-selected" }]) {
    assert.deepEqual(await session.handleServerRequest("mcpServer/elicitation/request", invalid), { action: "decline", content: null, _meta: null });
  }
  assert.equal(seen.length, 4, "未支持的表单不应该弹工具授权卡");
  const builtin = makeSession();
  assert.deepEqual(await builtin.session.handleServerRequest("mcpServer/elicitation/request", request), { action: "decline", content: null, _meta: null });
});

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

test("本轮 Token 累计全部模型请求，重复通知不多算，上下文仍取最后一次请求", async () => {
  calls.length = 0;
  const { session, events } = makeSession();
  const results: TurnResult[] = [];
  const usages: TokenUsage[] = [];
  const contexts: ContextUsage[] = [];
  events.onResult = (r) => results.push(r);
  events.onUsage = (u) => usages.push(u);
  events.onContext = (c) => contexts.push(c);
  session.send({ text: "查天气", attachments: [] });
  const t = await startTurn();
  notify("turn/started", { threadId: t.threadId, turn: { id: t.turnId } });
  let totalTokens = 0;
  for (const last of [
    { totalTokens: 20000, inputTokens: 19980, cachedInputTokens: 8000, outputTokens: 20, reasoningOutputTokens: 17 },
    { totalTokens: 14000, inputTokens: 13949, cachedInputTokens: 5000, outputTokens: 51 },
    { totalTokens: 25400, inputTokens: 25100, cachedInputTokens: 20700, outputTokens: 300 },
  ]) {
    totalTokens += last.totalTokens;
    const params = { threadId: t.threadId, tokenUsage: { total: { totalTokens }, last, modelContextWindow: 200000 } };
    notify("thread/tokenUsage/updated", params);
    notify("thread/tokenUsage/updated", params);
  }
  notify("turn/completed", { threadId: t.threadId, turn: { id: t.turnId, status: "completed" } });
  assert.equal(results[0]?.tokens, 59400);
  assert.equal(usages.length, 3);
  const sum = (key: keyof TokenUsage) => usages.reduce((n, u) => n + (u[key] ?? 0), 0);
  assert.equal(results[0]?.tokens, sum("input") + sum("cacheRead") + sum("cacheWrite") + sum("output"));
  assert.equal(sum("cacheRead"), 33700);
  assert.equal(sum("output"), 371, "推理已经包含在输出内，不再重复相加");
  assert.equal(contexts.at(-1)?.used, 25400, "上下文大小不能用本轮累计消耗代替");
});

test("本轮 Token 排除恢复的旧用量，排队的下一轮重新计数，没报用量不沿用上一轮", async () => {
  calls.length = 0;
  const { session, events } = makeSession();
  const results: TurnResult[] = [];
  const usages: TokenUsage[] = [];
  events.onResult = (r) => results.push(r);
  events.onUsage = (u) => usages.push(u);
  session.send({ text: "一", attachments: [] });
  const t = await startTurn();
  const usage = (totalTokens: number, inputTokens: number, cacheWriteInputTokens = 0) => notify("thread/tokenUsage/updated", {
    threadId: t.threadId,
    tokenUsage: { total: { totalTokens }, last: { totalTokens: inputTokens, inputTokens, cacheWriteInputTokens, outputTokens: 0 } },
  });
  // 恢复 thread 的历史用量，可能在本轮 turn/started 之前补报。
  usage(1000, 1000);
  notify("turn/started", { threadId: t.threadId, turn: { id: t.turnId } });
  usage(1100, 100, 30);
  session.send({ text: "二", attachments: [] });
  notify("turn/completed", { threadId: t.threadId, turn: { id: t.turnId, status: "completed" } });
  assert.equal(results[0]?.tokens, 100);
  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.cacheWrite, 30);
  const second = await startTurn(t.threadId);
  usage(1100, 100, 30); // 下一轮启动前补报上一轮的用量。
  notify("turn/started", { threadId: t.threadId, turn: { id: second.turnId } });
  usage(1140, 40);
  notify("turn/completed", { threadId: t.threadId, turn: { id: second.turnId, status: "completed" } });
  assert.equal(results[1]?.tokens, 40);
  session.send({ text: "三", attachments: [] });
  const third = await startTurn(t.threadId);
  notify("turn/started", { threadId: t.threadId, turn: { id: third.turnId } });
  notify("turn/completed", { threadId: t.threadId, turn: { id: third.turnId, status: "completed" } });
  assert.equal(results[2]?.tokens, undefined);
  assert.equal(usages.length, 2);
});

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

test("撤销指定排队输入，不中断当前轮次；记录用户消息对应的轮次位置", async () => {
  calls.length = 0;
  const { session, events } = makeSession();
  const anchors: string[] = [];
  events.onUserAnchor = (input, anchor) => anchors.push(`${input.text}:${anchor}`);
  const first = { text: "第一条", attachments: [] };
  const withdrawn = { text: "撤销这条", attachments: [] };
  const last = { text: "最后一条", attachments: [] };
  session.send(first);
  const t1 = await startTurn();
  session.send(withdrawn); session.send(last);
  assert.equal(session.cancelQueued(first), false);
  assert.equal(session.cancelQueued(withdrawn), true);
  assert.equal(session.cancelQueued(withdrawn), false);
  assert.equal(calls.some((call) => call.method === "turn/interrupt"), false);
  notify("turn/completed", { threadId: t1.threadId, turn: { id: t1.turnId, status: "completed" } });
  await tick();
  const next = take("turn/start");
  assert.equal(next.params.input[0].text, "最后一条");
  next.resolve({ turn: { id: "after-withdrawal" } });
  await tick();
  assert.deepEqual(anchors, [`第一条:${t1.turnId}`, "最后一条:after-withdrawal"]);
  notify("turn/completed", { threadId: t1.threadId, turn: { id: "after-withdrawal", status: "completed" } });
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

test("request_user_input_async 弹不阻塞的提问卡，不当正文；答了才发下一条消息", async () => {
  calls.length = 0;
  const specs: InteractionSpec[] = [];
  let answer!: (o: { settlement: Settlement; answers: Record<string, string[]> }) => void;
  const { session, log, events } = makeSession({}, (spec: InteractionSpec) => {
    specs.push(spec);
    return new Promise((r) => (answer = r));
  });
  const followUps: string[] = [];
  events.onFollowUp = (t) => followUps.push(t);
  session.send({ text: "记一笔", attachments: [] });
  const { threadId, turnId } = await startTurn();
  const item = {
    type: "agentMessage", id: "call_1", text: "确认吗？\n- 确认登记\n- 暂不登记", phase: "final_answer", delivery: "async",
    questions: [{ title: "确认吗？", options: ["确认登记", "暂不登记"] }],
  };
  notify("item/completed", { threadId, item });
  notify("item/completed", { threadId, item: { type: "agentMessage", id: "m2", text: "选一下", phase: "final_answer" } });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", durationMs: 1 } });
  await tick();

  assert.equal(specs.length, 1);
  const spec = specs[0]!;
  assert.ok(spec.kind === "question" && spec.detached);
  assert.deepEqual(spec.questions[0]!.options.map((o) => o.label), ["确认登记", "暂不登记"]);
  // 一轮不等提问卡，正文里也没有那份列表
  assert.deepEqual(log, ["text:选一下", "result:选一下"]);
  assert.deepEqual(followUps, []);

  answer({ settlement: "answered", answers: { q0: ["确认登记"] } });
  await tick();
  assert.deepEqual(followUps, ["确认登记"]);
  void session.dispose();
});

test("async 提问跳过 / 超时不发消息；没有问题的 async 消息仍是普通正文", async () => {
  calls.length = 0;
  let answer!: (o: { settlement: Settlement; answers: Record<string, string[]> }) => void;
  const { session, log, events } = makeSession({}, () => new Promise((r) => (answer = r)));
  const followUps: string[] = [];
  events.onFollowUp = (t) => followUps.push(t);
  session.send({ text: "问", attachments: [] });
  const { threadId } = await startTurn();
  notify("item/completed", { threadId, item: { type: "agentMessage", id: "a", text: "顺便说一句", phase: "final_answer", delivery: "async", questions: null } });
  notify("item/completed", { threadId, item: { type: "agentMessage", id: "b", text: "问题", phase: "final_answer", delivery: "async", questions: [{ title: "问题", options: null }] } });
  await tick();
  assert.deepEqual(log, ["text:顺便说一句"]);
  answer({ settlement: "skipped", answers: {} });
  await tick();
  assert.deepEqual(followUps, []);
  void session.dispose();
});

/** dispose 会依次等 turn/interrupt、thread/unsubscribe：假的 app-server 不回就一直挂着 */
async function disposeRunning(session: InstanceType<typeof CodexSession>) {
  let finished = false;
  const done = session.dispose().finally(() => { finished = true; });
  while (!finished) {
    await tick();
    for (const c of calls.splice(0)) c.resolve({});
  }
  await done;
}

test("权限级别：沙箱按级别走，专家封顶；同一条 thread 下一轮就换", async () => {
  const expects: [Partial<SessionOptions>, string, unknown][] = [
    [{ permission: "ask" }, "read-only", { type: "readOnly", networkAccess: false }],
    [{ permission: "edit" }, "workspace-write", "workspaceWrite"],
    [{ permission: "full" }, "danger-full-access", { type: "dangerFullAccess" }],
    [{}, "workspace-write", "workspaceWrite"],
    [{ permission: "full", expert: { ...expert(), access: "edit" } }, "workspace-write", "workspaceWrite"],
    [{ permission: "full", expert: { ...expert(), access: "read" } }, "read-only", { type: "readOnly", networkAccess: false }],
  ];
  (appServer as any).call = (method: string, params: any) => {
    if (method === "config/read") return Promise.resolve({ config: {} });
    return new Promise((resolve, reject) => calls.push({ method, params, resolve, reject }));
  };
  for (const [opts, sandbox, policy] of expects) {
    const { session } = makeSession(opts);
    session.send({ text: "hi", attachments: [] });
    await tick();
    const start = take("thread/start");
    assert.equal(start.params.sandbox, sandbox);
    assert.equal(start.params.approvalPolicy, "on-request", "不能用 never：MCP 审批要走这条路");
    start.resolve({ thread: { id: `perm-${Math.random()}` } });
    await tick();
    const turn = take("turn/start");
    if (typeof policy === "string") assert.equal(turn.params.sandboxPolicy.type, policy);
    else assert.deepEqual(turn.params.sandboxPolicy, policy);
    turn.resolve({ turn: { id: `t-${Math.random()}` } });
    await tick();
    await disposeRunning(session);
  }

  const { session } = makeSession({ permission: "full" });
  const threadId = `perm-${Math.random()}`;
  session.send({ text: "1", attachments: [] });
  await tick();
  take("thread/start").resolve({ thread: { id: threadId } });
  await tick();
  const first = take("turn/start");
  assert.equal(first.params.sandboxPolicy.type, "dangerFullAccess");
  first.resolve({ turn: { id: "t1" } });
  await tick();
  await session.setPermission!("ask");
  // 排队的下一条：这一轮收尾后开，要带上新沙箱
  session.send({ text: "2", attachments: [] });
  await tick();
  notify("turn/completed", { threadId, turn: { id: "t1", status: "completed" } });
  await tick();
  const second = take("turn/start");
  assert.deepEqual(second.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  second.resolve({ turn: { id: "t2" } });
  await tick();
  await disposeRunning(session);
});

test("全部放行只批这一次：acceptForSession 记在 thread 上，调低后收不回来", async () => {
  const seen: InteractionSpec[] = [];
  const { session } = makeSession({ permission: "full" }, async (spec) => {
    seen.push(spec);
    return { settlement: "deny", answers: {} };
  });
  const command = { threadId: "t", turnId: "u", itemId: "i", command: "ls", cwd: "/tmp" };
  const file = { threadId: "t", turnId: "u", itemId: "i", changes: [] };
  const permissions = { threadId: "t", turnId: "u", itemId: "i", permissions: { network: {} } };
  assert.deepEqual(await session.handleServerRequest("item/commandExecution/requestApproval", command), { decision: "accept" });
  assert.deepEqual(await session.handleServerRequest("item/fileChange/requestApproval", file), { decision: "accept" });
  assert.deepEqual(await session.handleServerRequest("item/permissions/requestApproval", permissions), { permissions: { network: {} }, scope: "turn" });
  assert.equal(seen.length, 0);

  await session.setPermission!("ask");
  assert.deepEqual(await session.handleServerRequest("item/commandExecution/requestApproval", command), { decision: "decline" });
  assert.equal(seen.length, 1, "调低后马上恢复询问");
  await session.dispose();
});

test("成员的对话不给「本会话全部允许」按钮", async () => {
  const seen: InteractionSpec[] = [];
  const { session } = makeSession({ noSessionGrant: true }, async (spec) => {
    seen.push(spec);
    return { settlement: "deny", answers: {} };
  });
  await session.handleServerRequest("item/commandExecution/requestApproval", { threadId: "t", turnId: "u", itemId: "i", command: "ls", cwd: "/tmp" });
  assert.ok(seen[0]!.kind === "approval" && !seen[0]!.allowSession);
  await session.dispose();
});

test("计划模式：这一轮带 collaborationMode=plan，方案当回复；问开不开始做，批准就关掉、切回 default 一次、替用户发「开始执行」", async () => {
  calls.length = 0;
  const asked: InteractionSpec[] = [];
  const { session, log, events } = makeSession({ plan: true, permission: "edit" }, async (spec) => {
    asked.push(spec);
    return { settlement: "allow-once", answers: {} };
  });
  const planModes: boolean[] = [];
  const followUps: string[] = [];
  events.onPlanMode = (on) => planModes.push(on);
  events.onFollowUp = (text) => followUps.push(text);
  session.send({ text: "加个按钮", attachments: [] });
  await tick();
  take("thread/start").resolve({ thread: { id: "th-plan", model: "gpt-test", reasoningEffort: "high" } });
  await tick();
  const start = take("turn/start");
  assert.deepEqual(start.params.collaborationMode, { mode: "plan", settings: { model: "gpt-test", reasoning_effort: "high", developer_instructions: null } });
  start.resolve({ turn: { id: "tu-plan" } });
  await tick();
  notify("item/completed", { threadId: "th-plan", item: { type: "plan", id: "p1", text: "1. 改 a.ts" } });
  notify("turn/completed", { threadId: "th-plan", turn: { id: "tu-plan", status: "completed" } });
  await tick();
  assert.ok(log.includes("result:1. 改 a.ts"), "方案就是这一轮的回复");
  assert.equal(asked.length, 1);
  const spec = asked[0]!;
  assert.ok(spec.kind === "approval" && spec.detached && spec.allowLabel === "开始执行");
  assert.deepEqual(planModes, [false]);
  assert.deepEqual(followUps, ["按这个方案开始执行。"]);

  session.send({ text: "按这个方案开始执行。", attachments: [] });
  await tick();
  const next = take("turn/start");
  assert.equal(next.params.collaborationMode.mode, "default", "模式留在 thread 上，要显式切回");
  next.resolve({ turn: { id: "tu-go" } });
  await tick();
  notify("turn/completed", { threadId: "th-plan", turn: { id: "tu-go", status: "completed" } });
  await tick();
  session.send({ text: "再来", attachments: [] });
  await tick();
  const third = take("turn/start");
  assert.equal(third.params.collaborationMode, undefined, "切回过一次就不再带");
  assert.equal(asked.length, 1, "不是计划模式的轮次不问");
  third.resolve({ turn: { id: "tu-3" } });
  await tick();
  notify("turn/completed", { threadId: "th-plan", turn: { id: "tu-3", status: "completed" } });
  await tick();
  void session.dispose();
});

test("生图：存下来的图片写进回复里（网页只显示回复里写过的路径），额度用完给个提示", async () => {
  calls.length = 0;
  const { session, log } = makeSession();
  session.send({ text: "画只猫", attachments: [] });
  const t = await startTurn();
  notify("item/started", { threadId: t.threadId, item: { type: "imageGeneration", id: "g1", status: "in_progress", revisedPrompt: null, failure: null, result: "" } });
  notify("item/completed", { threadId: t.threadId, item: { type: "imageGeneration", id: "g1", status: "completed", revisedPrompt: "一只 [橘] 猫", failure: null, result: "", savedPath: "/home/u/.codex/generated_images/t 1/ig_1.png" } });
  notify("item/completed", { threadId: t.threadId, item: { type: "imageGeneration", id: "g2", status: "failed", revisedPrompt: null, failure: { type: "usageLimitExceeded", limitId: "x", resetsAt: null }, result: "" } });
  notify("turn/completed", { threadId: t.threadId, turn: { id: t.turnId, status: "completed" } });
  await tick();
  const md = "![一只  橘  猫](</home/u/.codex/generated_images/t 1/ig_1.png>)";
  assert.ok(log.includes(`text:${md}`), log.join("\n"));
  assert.ok(log.includes(`result:${md}`));
});

test("语音对话：先同步权限再用 v3 + WebRTC 开通话，answer 从通知回来；转交出来的一轮当成一条消息接住", async () => {
  calls.length = 0;
  const { session, log, events } = makeSession({ permission: "ask", memory: { userId: "u1", prompt: "记得用户叫小明" } });
  const realtime: string[] = [];
  const external: string[] = [];
  events.onRealtime = (ev) => realtime.push(ev.type === "transcript" ? `${ev.role}:${ev.delta}` : ev.type);
  events.onExternalTurn = (text, anchor) => external.push(`${text}@${anchor}`);
  events.onTurnStart = () => log.push("turn_start");
  const answer = session.startRealtime("OFFER");
  await tick();
  take("thread/start").resolve({ thread: { id: "rt1" } });
  await tick();
  const settings = take("thread/settings/update");
  assert.equal(settings.params.sandboxPolicy.type, "readOnly", "按对话现在的权限给沙箱");
  assert.equal(settings.params.approvalPolicy, "on-request");
  settings.resolve({});
  await tick();
  const start = take("thread/realtime/start");
  assert.deepEqual([start.params.version, start.params.outputModality, start.params.transport], ["v3", "audio", { type: "webrtc", sdp: "OFFER" }]);
  assert.equal(start.params.includeStartupContext, false, "没有管理员身份不给机器上的启动背景");
  assert.match(start.params.realtimeStartInstructions, /小明/, "语音先开口也带上记忆");
  start.resolve({});
  notify("thread/realtime/sdp", { threadId: "rt1", sdp: "ANSWER" });
  assert.equal(await answer, "ANSWER");
  notify("thread/realtime/transcript/delta", { threadId: "rt1", role: "user", delta: "列一下" });

  // 空闲时冒出来的一轮：语音模型转交的
  notify("turn/started", { threadId: "rt1", turn: { id: "vt1" } });
  notify("item/completed", { threadId: "rt1", turnId: "vt1", item: { type: "userMessage", id: "u", content: [{ type: "text", text: "<realtime_delegation>\n  <input>列一下 &lt;文件&gt;</input>\n  <transcript_delta>user: 列一下</transcript_delta>\n</realtime_delegation>" }] } });
  assert.deepEqual(external, ["🎙️ 列一下 <文件>@vt1"]);
  // 语音那一轮还在跑：打字发的排队
  session.send({ text: "打字的", attachments: [] });
  await tick();
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 0);
  notify("item/completed", { threadId: "rt1", turnId: "vt1", item: { type: "agentMessage", id: "m", text: "有 a.txt", phase: "final_answer" } });
  notify("turn/completed", { threadId: "rt1", turn: { id: "vt1", status: "completed" } });
  await tick();
  assert.deepEqual(log.slice(0, 3), ["turn_start", "text:有 a.txt", "result:有 a.txt"]);
  assert.equal(take("turn/start").params.input[0].text.startsWith("打字的"), true, "语音那一轮结束后接着发排队的");

  notify("thread/realtime/error", { threadId: "rt1", message: '{"error":{"message":"坏了"}}' });
  notify("thread/realtime/closed", { threadId: "rt1", reason: "requested" });
  assert.deepEqual(realtime, ["user:列一下", "error", "closed"]);
});

test("语音对话：开通话时出错（对端报错）就失败，并让 app-server 收掉", async () => {
  calls.length = 0;
  const { session } = makeSession();
  const answer = session.startRealtime("OFFER");
  await tick();
  take("thread/start").resolve({ thread: { id: "rt2" } });
  await tick();
  take("thread/settings/update").resolve({});
  await tick();
  take("thread/realtime/start").resolve({});
  notify("thread/realtime/error", { threadId: "rt2", message: '{"error":{"message":"Offer did not have an audio media section."}}' });
  await assert.rejects(answer, /audio media section/);
  take("thread/realtime/stop").resolve({});
});
