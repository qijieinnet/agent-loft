// dsh（DeepSeek Harness）：zstd 多 frame 记录的读取、会话列表 / 历史、权限和模型的换算、MCP 的转换。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loft-dsh-"));
process.env.DSH_HOME = root;

const { decodeLog, lastTurnUsage, listSessionFiles, readEvents, readHistoryFile, sessionFile, sessionTitleOf, splitFrames } = await import("../src/agents/dsh/history.js");
const { modeOf, modelIdOf, modelValueOf, modelsOf, runtimeOf } = await import("../src/agents/dsh/sdk.js");
const { appendPrompt, describePermission, mcpServersOf } = await import("../src/agents/dsh/session.js");
const { diagnose } = await import("../src/agents/dsh/errors.js");

const ID = "6e593ab4-dcbe-45bc-80ff-2700b139914d";
const SUB = "d39560c1-d38c-496e-b7d6-a7052e0dbb69";
const OPENAI = "session-10167cbc-d11b-4027-ad9a-7bd6d4433e85";
const EMPTY = "f818462d-21ad-4911-8665-4359257aaf70";

/** 像 dsh 那样：每批事件压成一个 frame 追加在后面；最后再追加半个 frame（还在写） */
function write(dir: string, id: string, batches: unknown[][]): void {
  const d = path.join(root, "sessions", dir, id);
  fs.mkdirSync(d, { recursive: true });
  const frames = batches.map((b) => zlib.zstdCompressSync(Buffer.from(b.map((e) => JSON.stringify(e)).join("\n") + "\n")));
  const partial = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n')).subarray(0, 9);
  fs.writeFileSync(path.join(d, "session.v4.jsonl.zstd"), Buffer.concat([...frames, partial]));
}

const user = (text: string, id: string, kind = "user") => ({ type: "user/message", time: 1000, data: { content: [{ type: "text", text }], source: { kind }, role: "user", id } });

write("--home-u-proj--", ID, [
  [
    { type: "session", version: 4, id: ID, createdAt: 1, cwd: "/home/u/proj", delegationDepth: 0 },
    { type: "model/selection", data: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "off" } },
    { type: "turn/start", data: { turn: 1 } },
    user("看看这个目录", "u1"),
    user("Current runtime context.", "rc", "runtime-context"),
    { type: "session/title", data: { title: "看看这个目录", source: { kind: "fallback" } } },
  ],
  [
    {
      type: "assistant/message",
      time: 2000,
      data: {
        message: { role: "assistant", id: "a0", content: [{ type: "reasoning", text: "先列文件" }, { type: "tool-call", id: "c1", name: "bash", arguments: JSON.stringify({ command: "ls -la" }) }] },
        usage: { inputTokens: 5000, outputTokens: 50, totalTokens: 5050 },
      },
    },
    {
      type: "assistant/message",
      time: 2100,
      data: { message: { role: "assistant", id: "a00", content: [{ type: "tool-call", id: "c2", name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "读代码", status: "completed" }, { content: "写测试", status: "pending" }] }) }] } },
    },
    { type: "assistant/message", time: 2500, data: { message: { role: "assistant", id: "a1", content: [{ type: "text", text: "目录里有 a.txt" }] }, usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 5000, totalTokens: 5240 } } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    { type: "session/title", data: { title: "查看目录内容", source: { kind: "provider" } } },
  ],
  [
    { type: "turn/start", data: { turn: 2 } },
    user("谢谢", "u2"),
    user("子 agent 的结果", "s1", "subagent-settled"),
    { type: "assistant/message", time: 4000, data: { message: { role: "assistant", id: "a2", content: [{ type: "text", text: "不客气" }] }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 } } },
    { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
  ],
]);
write("--home-u-proj--", SUB, [[{ type: "session", id: SUB, cwd: "/home/u/proj", origin: "subagent", parentSession: ID }, user("子任务", "x")]]);
write("--home-u-proj--", OPENAI, [[{ type: "session", id: OPENAI, cwd: "/home/u/proj" }, { type: "model/selection", data: { provider: "openai", model: "gpt" } }, user("用别家模型", "y")]]);
write("--tmp--", EMPTY, [[{ type: "session", id: EMPTY, cwd: "/tmp" }]]);

test("zstd：按 frame 切开逐个解，写到一半的 frame 跳过", () => {
  const file = sessionFile(ID)!;
  const buf = fs.readFileSync(file);
  assert.equal(splitFrames(buf).length, 3);
  // Node 自带的只解第一个 frame —— 这就是要自己切的原因
  assert.ok(zlib.zstdDecompressSync(splitFrames(buf)[0]!).toString().split("\n").length < decodeLog(buf).split("\n").length);
  assert.equal(readEvents(file).filter((e) => e.type === "turn/end").length, 2);
});

test("会话列表：只列根会话、说过话的、服务商认得的；标题用模型起的", () => {
  const all = listSessionFiles(undefined, 10, new Set(["deepseek-official"]));
  assert.deepEqual(
    all.map((s) => s.id),
    [ID],
  );
  assert.equal(all[0]!.title, "查看目录内容");
  assert.equal(all[0]!.cwd, "/home/u/proj");
  // 不筛服务商时别家模型的也列出来
  assert.equal(listSessionFiles("/home/u/proj", 10).length, 2);
  assert.equal(listSessionFiles("/tmp", 10).length, 0);
  assert.equal(sessionTitleOf(ID), "查看目录内容");
  assert.equal(sessionFile("../etc"), undefined);
});

test("历史：一问一答，工具调用和任务清单挂在过程里，塞进来的上下文不算用户消息", () => {
  const h = readHistoryFile(ID);
  assert.deepEqual(
    h.map((m) => [m.role, m.text]),
    [
      ["user", "看看这个目录"],
      ["assistant", "目录里有 a.txt"],
      ["user", "谢谢"],
      ["assistant", "不客气"],
    ],
  );
  assert.equal(h[0]!.anchor, "u1");
  assert.equal(h[1]!.anchor, "a1");
  assert.deepEqual(h[1]!.steps?.[0], "💭 先列文件");
  assert.match(h[1]!.steps![1]!, /bash: ls -la/);
  assert.deepEqual(h[1]!.todos?.map((t) => t.status), ["completed", "pending"]);
});

test("用量：只算最后一轮", () => {
  assert.deepEqual(lastTurnUsage(readEvents(sessionFile(ID)!)), { input: 10, cacheRead: 100, cacheWrite: 0, output: 5 });
});

test("权限级别 → dsh 沙箱档位；计划模式只读", () => {
  assert.equal(modeOf("ask"), "read-only");
  assert.equal(modeOf("edit"), "workspace-write");
  assert.equal(modeOf("auto"), "workspace-write");
  assert.equal(modeOf(undefined), "workspace-write");
  assert.equal(modeOf("full"), "danger-full-access");
  assert.equal(modeOf("full", true), "read-only");
});

test("模型 id：ACP 的 JSON 数组 ↔ 服务商/模型", () => {
  const v = '["deepseek-official","deepseek-v4-pro"]';
  assert.equal(modelIdOf(v), "deepseek-official/deepseek-v4-pro");
  assert.equal(modelValueOf("deepseek-official/deepseek-v4-pro"), v);
  assert.equal(modelValueOf("deepseek-v4-pro"), v);
  assert.equal(modelIdOf("oops"), undefined);
  const opts = [
    {
      id: "model",
      currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [{ group: "deepseek-official", options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" }, { value: v, name: "DeepSeek-V4-Pro", description: "更强" }] }],
    },
    { id: "reasoning_effort", currentValue: "high", options: [{ value: "off" }, { value: "high" }] },
  ];
  const models = modelsOf(opts);
  assert.deepEqual(
    models.map((m) => [m.id, m.label, !!m.isDefault]),
    [
      ["deepseek-official/deepseek-v4-flash", "deepseek-v4-flash", true],
      ["deepseek-official/deepseek-v4-pro", "DeepSeek-V4-Pro", false],
    ],
  );
  assert.deepEqual(models[0]!.efforts, ["off", "high"]);
  assert.deepEqual(runtimeOf(opts), { model: "deepseek-official/deepseek-v4-flash", effort: "high" });
});

test("MCP：记忆 / 任务 / 技能挂上，命令换成绝对路径，调用前询问和 SSE 的不挂", () => {
  const base = { cwd: "/tmp", uploadsDir: "/tmp/u" };
  const { servers, skipped } = mcpServersOf({
    ...base,
    memory: { userId: "u1", prompt: "记忆" },
    tasks: { userId: "u1", convKey: "web:1" },
    builtinMcp: {
      inheritMachine: false,
      machineMcp: [],
      askMcp: ["careful"],
      mcp: {
        search: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
        local: { type: "stdio", command: "node", args: ["a.js"], env: { K: "v" } },
        careful: { type: "stdio", command: "node", args: [], env: {} },
        old: { type: "sse", url: "https://example.com/sse", headers: {} },
        missing: { type: "stdio", command: "no-such-command-xyz", args: [], env: {} },
      },
    },
  } as never);
  const names = servers.map((s) => s.name);
  assert.deepEqual(names.slice(0, 3), ["agent_loft_memory", "agent_loft_tasks", "agent_loft_skills"]);
  assert.ok(names.includes("search") && names.includes("local"));
  assert.deepEqual(skipped.sort(), ["careful", "missing", "old"]);
  const local = servers.find((s) => s.name === "local") as { command: string; env: { name: string; value: string }[] };
  assert.ok(path.isAbsolute(local.command));
  assert.deepEqual(local.env, [{ name: "K", value: "v" }]);
  const search = servers.find((s) => s.name === "search") as { type: string; headers: unknown };
  assert.equal(search.type, "http");
  assert.deepEqual(search.headers, [{ name: "Authorization", value: "x" }]);
});

test("追加的系统提示：记忆、计划模式", () => {
  const p = appendPrompt({ cwd: "/tmp", uploadsDir: "/tmp/u", memory: { userId: "u", prompt: "用户叫小明" }, plan: true });
  assert.match(p, /用户叫小明/);
  assert.match(p, /计划模式/);
  assert.doesNotMatch(appendPrompt({ cwd: "/tmp", uploadsDir: "/tmp/u" }), /计划模式/);
});

test("授权卡：命令和 dsh 给的理由", () => {
  const d = describePermission("bash", { command: "npm i -g x", justification: "要装到全局" });
  assert.match(d, /要装到全局/);
  assert.match(d, /```bash\nnpm i -g x\n```/);
  assert.match(describePermission("write", { file_path: "/etc/x", content: "secret" }), /\/etc\/x/);
});

test("报错翻译", () => {
  assert.equal(diagnose(new Error("interrupted")).kind, "turn_aborted");
  assert.equal(diagnose(Object.assign(new Error("spawn dsh ENOENT"), { code: "ENOENT" })).kind, "cli_missing");
  assert.equal(diagnose(new Error("Invalid params: session is not resumable: x")).kind, "session_missing");
});
