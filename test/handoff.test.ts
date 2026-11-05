import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDriver, AgentEvents, AgentSession, SessionOptions, UserInput } from "../src/core/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-handoff-"));
process.env.AGENT_LOFT_HOME = home;
const { buildHandoffContext, handoffMessage, readHandoffGit } = await import("../src/core/handoff.js");
const { stripContext } = await import("../src/core/expert-prompt.js");
const { loadConfig, config, saveConfig } = await import("../src/core/config.js");
const { hub } = await import("../src/core/hub.js");
const { getConversation, updateAgentBinding, updateConversation } = await import("../src/core/store.js");
loadConfig();
// findRepo 只认工作区之内的仓库
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-handoff-root-")));
saveConfig({ ...config(), workspaceRoot: root });

test("交接内容：带上需求、最近对话、清单和操作摘要，不带思考过程", () => {
  const text = buildHandoffContext({
    title: "修 bug",
    from: "Claude Code",
    history: [
      { role: "user", text: "原始需求：修好登录" },
      { role: "assistant", text: "正在看", steps: ["💭 想一想", "🔧 Read a.ts"], todos: [{ content: "改 a.ts", status: "in_progress" }] },
    ],
    queued: ["顺便加个测试"],
  }).join("\n");
  assert.match(text, /从 Claude Code 交接/);
  assert.match(text, /## 原始需求\n原始需求：修好登录/);
  assert.match(text, /【助手】正在看/);
  assert.match(text, /\[进行中\] 改 a\.ts/);
  assert.match(text, /🔧 Read a\.ts/);
  assert.doesNotMatch(text, /想一想/);
  assert.match(text, /顺便加个测试/);
  // 原始需求不重复进「最近的对话」
  assert.equal(text.split("原始需求：修好登录").length, 2);
});

test("交接内容：被打断的输出已在记录里就不重复；长对话限制总量但保留开头的需求和最新的消息", () => {
  const dup = buildHandoffContext({
    title: "t",
    from: "A",
    history: [{ role: "user", text: "需求" }, { role: "assistant", text: "结论是 42" }],
    unfinished: { text: "结论是 42", steps: [] },
  }).join("\n");
  assert.doesNotMatch(dup, /被打断时/);

  const history = [
    { role: "user" as const, text: "最初的需求" },
    ...Array.from({ length: 200 }, (_, i) => ({ role: "assistant" as const, text: `第${i}条${"字".repeat(3000)}` })),
    { role: "user" as const, text: "最新的要求" },
  ];
  const long = buildHandoffContext({ title: "t", from: "A", history }).join("\n");
  assert.ok(long.length < 20_000, `长度 ${long.length}`);
  assert.match(long, /最初的需求/);
  assert.match(long, /最新的要求/);
  assert.doesNotMatch(long, /第0条/);
});

test("交接内容：仓库现状列出改动文件；不是仓库时不报错", async () => {
  const repo = fs.mkdtempSync(path.join(root, "repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  git("init", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
  git("add", ".");
  git("commit", "-m", "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
  const status = await readHandoffGit(repo);
  assert.ok(status);
  const text = buildHandoffContext({ title: "t", from: "A", history: [{ role: "user", text: "x" }], git: status }).join("\n");
  assert.match(text, /main/);
  assert.match(text, /modified a\.txt/);
  assert.match(text, /untracked b\.txt/);
  assert.equal(await readHandoffGit(fs.mkdtempSync(path.join(root, "plain-"))), undefined);
});

/** 记下收到的消息；claude 的会话能手动让它一直「在回复」 */
function fakeDriver(id: string, sent: UserInput[], history: () => { role: "user" | "assistant"; text: string }[]): AgentDriver {
  return {
    id, label: id === "claude" ? "Claude Code" : "Codex", capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {}, stop: async () => {},
    createSession: (_opts: SessionOptions, events: AgentEvents): AgentSession => ({
      sessionId: `${id}-s`,
      send: (input) => {
        sent.push(input);
        events.onSessionId(`${id}-s`);
        events.onTextDelta("写到一半");
      },
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => ({}),
      dispose: async () => {},
    }),
    listSessions: async () => [], sessionExists: async () => true, readHistory: async () => history(),
    listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
    diagnose: () => ({ kind: "test", chatMessage: "test", consoleHint: "" }),
  } as AgentDriver;
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "等待超时");
}

test("hub 交接：新对话归目标智能体并立刻开始，原对话不动；在回复时要确认停止", async () => {
  const toClaude: UserInput[] = [];
  const toCodex: UserInput[] = [];
  hub.registerDriver(fakeDriver("claude", toClaude, () => [{ role: "user", text: "做个功能" }, { role: "assistant", text: "好的" }]));
  hub.registerDriver(fakeDriver("codex", toCodex, () => []));
  saveConfig({ ...config(), agents: { ...config().agents, codex: { ...config().agents.codex, enabled: true } } });

  const cwd = fs.mkdtempSync(path.join(root, "cwd-"));
  hub.ensure({ key: "src", channel: "web", channelId: "web", defaultAgent: "claude", owner: "u1" });
  updateConversation("src", { cwd, cwdExplicit: true, title: "原对话", permission: "full" });

  // 还没内容：不能交接
  await assert.rejects(hub.handoffConversation("src", { agent: "codex", label: "Codex" }), /还没有可以交接的内容/);
  assert.equal(hub.info("src")?.canHandoff, undefined);
  // 不能交接给自己
  await assert.rejects(hub.handoffConversation("src", { agent: "claude", label: "Claude Code" }), /已经是/);

  updateAgentBinding("src", "claude", { sessionId: "claude-s" });
  assert.equal(hub.info("src")?.canHandoff, true);
  hub.send("src", { text: "继续做", attachments: [] }, { channel: "web", channelId: "web" });
  await until(() => toClaude.length === 1 && hub.isBusy("src"));
  hub.send("src", { text: "排队的消息", attachments: [] }, { channel: "web", channelId: "web" });

  // 在回复：没确认不能交接，确认了就先停
  await assert.rejects(hub.handoffConversation("src", { agent: "codex", label: "Codex" }), /还在回复/);
  await until(() => toClaude.length === 2);
  const newKey = await hub.handoffConversation("src", { agent: "codex", label: "Codex" }, { owner: "u1", stop: true });
  assert.equal(hub.isBusy("src"), false);

  await until(() => toCodex.length === 1);
  const first = toCodex[0]!.text;
  assert.equal(stripContext(first), handoffMessage("原对话", "Claude Code"));
  assert.match(first, /做个功能/);
  assert.match(first, /写到一半/);
  assert.match(first, /排队的消息/);

  const next = getConversation(newKey)!;
  assert.equal(next.agent, "codex");
  assert.equal(next.cwd, cwd);
  assert.equal(next.forkOf, "src");
  assert.equal(next.owner, "u1");
  assert.equal(next.title, "原对话 · 交接");
  // 「完全允许」不跟过去
  assert.equal(next.permission, undefined);
  assert.equal(hub.info(newKey)?.handoff, true);

  // 原对话还是 Claude，会话也还在
  const source = getConversation("src")!;
  assert.equal(source.agent, "claude");
  assert.equal(source.perAgent.claude?.sessionId, "claude-s");
  await hub.shutdown();
});
