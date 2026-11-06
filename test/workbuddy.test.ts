// WorkBuddy（CodeBuddy Code）：会话记录的读取、权限级别的映射、成员不读机器上的配置。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loft-workbuddy-"));
process.env.CODEBUDDY_CONFIG_DIR = root;

const { listSessionFiles, readHistoryFile, sessionFile, sessionTitleOf } = await import("../src/agents/workbuddy/history.js");
const { modeOf, sessionOptions } = await import("../src/agents/workbuddy/session.js");
const { modelOf } = await import("../src/agents/workbuddy/sdk.js");

const ID = "01a1b07e-c1de-72a7-9464-cbfb358835a8";
const OTHER = "01a1b07e-0000-7000-8000-000000000001";
const PROBE = "01a1b07e-0000-7000-8000-000000000002";

function write(dir: string, id: string, records: unknown[]): void {
  fs.mkdirSync(path.join(root, "projects", dir), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n{\"type\":");
}

write("home-u-proj", ID, [
  { id: "u1", timestamp: 1000, type: "message", role: "user", content: [{ type: "input_text", text: "看看这个目录" }], sessionId: ID, cwd: "/home/u/proj" },
  { timestamp: 1001, type: "file-history-snapshot", messageId: "u1", snapshot: {} },
  { id: "r1", type: "reasoning", content: [{ type: "input_text", text: "先列一下文件" }] },
  { id: "f1", type: "function_call", name: "Bash", callId: "c1", arguments: JSON.stringify({ command: "ls -la" }) },
  { id: "f1r", type: "function_call_result", callId: "c1", output: "a.txt" },
  { id: "f2", type: "function_call", name: "TodoWrite", callId: "c2", arguments: JSON.stringify({ todos: [{ content: "读代码", status: "completed" }, { content: "写测试", status: "pending" }] }) },
  { id: "a1", timestamp: 2000, type: "message", role: "assistant", content: [{ type: "output_text", text: "目录里有 a.txt" }] },
  { id: "u2", timestamp: 3000, type: "message", role: "user", content: [{ type: "input_text", text: "<system-reminder>内部提示</system-reminder>" }] },
  { id: "u3", timestamp: 4000, type: "message", role: "user", content: [{ type: "input_text", text: "谢谢" }] },
  { id: "a2", timestamp: 5000, type: "message", role: "assistant", content: [{ type: "output_text", text: "不客气" }] },
  { type: "ai-title", aiTitle: "查看目录内容" },
]);
write("tmp", OTHER, [{ id: "x", type: "message", role: "user", content: [{ type: "input_text", text: "别的目录里的会话" }], cwd: "/tmp" }]);
// 没登录时的探测：只有一句、没有用户真正发的话以外的东西也算，所以这里放一条纯系统记录
write("tmp", PROBE, [{ type: "file-history-snapshot", messageId: "m", snapshot: {} }]);

test("历史：一问一答，工具调用和思考挂成过程，任务清单跟着走，系统塞的消息不算", () => {
  const h = readHistoryFile(ID);
  assert.deepEqual(h.map((m) => [m.role, m.text]), [
    ["user", "看看这个目录"],
    ["assistant", "目录里有 a.txt"],
    ["user", "谢谢"],
    ["assistant", "不客气"],
  ]);
  assert.equal(h[0]!.anchor, "u1");
  assert.equal(h[0]!.ts, 1000);
  assert.equal(h[1]!.anchor, "a1");
  assert.deepEqual(h[1]!.steps, ["💭 先列一下文件", "🔧 Bash: ls -la", "📋 更新任务清单（1/2）"]);
  assert.deepEqual(h[1]!.todos?.map((t) => t.status), ["completed", "pending"]);
});

test("会话列表：按目录筛，标题用 CLI 生成的，没说过话的不列", () => {
  assert.deepEqual(listSessionFiles("/home/u/proj", 10).map((s) => [s.id, s.title]), [[ID, "查看目录内容"]]);
  const all = listSessionFiles(undefined, 10).map((s) => s.id).sort();
  assert.deepEqual(all, [ID, OTHER].sort());
  assert.equal(sessionTitleOf(ID), "查看目录内容");
  assert.equal(sessionTitleOf(OTHER), undefined);
});

test("会话 id 拼路径前先验形", () => {
  assert.equal(sessionFile("../../etc/passwd"), undefined);
  assert.ok(sessionFile(ID));
  assert.deepEqual(readHistoryFile("../x"), []);
});

test("权限级别 → permissionMode：计划模式优先，自动判断按自动改文件，完全允许在 canUseTool 里放行", () => {
  assert.equal(modeOf(undefined, false), "default");
  assert.equal(modeOf("ask", false), "default");
  assert.equal(modeOf("edit", false), "acceptEdits");
  assert.equal(modeOf("auto", false), "acceptEdits");
  assert.equal(modeOf("full", false), "default");
  assert.equal(modeOf("full", true), "plan");
});

test("成员的会话不读机器主人的 ~/.codebuddy 配置，管理员照常读", () => {
  const base = { cwd: "/tmp", uploadsDir: "/tmp/up" };
  const skills = (admin: boolean) => ({ userId: "u", admin, list: [{ name: "周报", description: "写周报", path: "/s/SKILL.md" }], env: {} });
  const member = sessionOptions({ ...base, skills: skills(false) });
  assert.deepEqual(member.settingSources, ["project"]);
  assert.equal(member.strictMcpConfig, true);
  const admin = sessionOptions({ ...base, skills: skills(true) });
  assert.deepEqual(admin.settingSources, ["user", "project", "local"]);
  assert.equal(admin.strictMcpConfig, undefined);
  // 技能清单进系统提示
  assert.match((admin.systemPrompt as { append: string }).append, /周报：写周报（\/s\/SKILL\.md）/);
});

test("模型：运行时的 { id, name } 和类型里的 { value, displayName } 都认", () => {
  assert.deepEqual(modelOf({ id: "hy3", name: "Hy3" }), { id: "hy3", label: "Hy3" });
  assert.deepEqual(modelOf({ value: "glm-5.3", displayName: "GLM-5.3", description: "快" }), { id: "glm-5.3", label: "GLM-5.3", description: "快" });
  assert.equal(modelOf({}), null);
});
