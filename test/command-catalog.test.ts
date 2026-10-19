import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/core/command-catalog.js";
import { parseCommand } from "../src/core/commands.js";

const native = [
  { name: "compact", description: "压缩上下文" },
  { name: "model", description: "Claude 自己的 /model，会被 im-agent 拦下" },
  { name: "review", description: "审查", args: "<pr>" },
  { name: "compact", description: "重复的" },
];

test("只发一个斜杠（含全角）列出命令；其它照旧", () => {
  assert.deepEqual(parseCommand("/"), { kind: "commands" });
  assert.deepEqual(parseCommand(" ／ "), { kind: "commands" });
  assert.deepEqual(parseCommand("/compact"), { kind: "chat", text: "/compact" });
});

test("合并内置与原生命令：重名丢弃、去重、必填参数不可一键执行", () => {
  const list = buildCatalog({ allowedAgents: ["claude"], native, prefs: undefined });
  const names = list.map((c) => c.name);
  assert.equal(names.filter((n) => n === "model").length, 1);
  assert.equal(list.find((c) => c.name === "model")!.source, "im-agent");
  assert.equal(names.filter((n) => n === "compact").length, 1);
  // 单 agent：不列切换命令
  assert.ok(!names.includes("agent") && !names.includes("codex") && !names.includes("claude"));
  assert.equal(list.find((c) => c.name === "review")!.runnable, false);
  assert.equal(list.find((c) => c.name === "compact")!.runnable, true);
  assert.equal(list.find((c) => c.name === "new")!.runnable, true, "可选参数不挡一键执行");
  assert.equal(list.find((c) => c.name === "cd")!.runnable, false);
});

test("按配置排序：排过的在前，没排过的按默认顺序接在后面；隐藏只打标记", () => {
  const list = buildCatalog({
    allowedAgents: ["claude", "codex"],
    native,
    prefs: { order: ["compact", "status", "gone-skill"], hidden: ["help"] },
  });
  assert.deepEqual(
    list.slice(0, 3).map((c) => c.name),
    ["compact", "status", "new"],
  );
  assert.ok(list.some((c) => c.name === "codex"));
  assert.equal(list.find((c) => c.name === "help")!.hidden, true);
  assert.ok(!list.some((c) => c.name === "gone-skill"), "配置里有但已经不存在的命令不凭空出现");
});

const { toFeishuCommands, planSync } = await import("../src/channels/feishu/slash-sync.js");

const entry = (name: string, extra: Partial<{ args: string; description: string; hidden: boolean }> = {}) => ({
  name,
  description: extra.description ?? `说明 ${name}`,
  source: "im-agent" as const,
  runnable: true,
  hidden: extra.hidden ?? false,
  ...(extra.args ? { args: extra.args } : {}),
});

test("转成飞书指令：名字不合规的跳过、隐藏的不注册、参数并进说明、说明截到 100 字", () => {
  const { commands, skipped } = toFeishuCommands([
    entry("new", { args: "[模型]", description: "开一条新会话" }),
    entry("plugin:skill"),
    entry("Upper"),
    entry("help", { hidden: true }),
    entry("long", { description: "长".repeat(300) }),
    entry("new"),
  ]);
  assert.deepEqual(commands.map((c) => c.command), ["new", "long"]);
  assert.equal(commands[0]!.description, "[模型] 开一条新会话");
  assert.equal(Array.from(commands[1]!.description).length, 100);
  assert.deepEqual(skipped, ["plugin:skill", "Upper"]);
});

test("同步计划：顺序一致只改说明，不一致整体重建", () => {
  const desired = [
    { command: "new", description: "a" },
    { command: "status", description: "b" },
  ];
  const remote = (names: string[], desc: (n: string) => string = (n) => (n === "new" ? "a" : "b")) =>
    names.map((n, i) => ({ command_id: String(i), command: n, description: { default_value: desc(n) } }));
  assert.deepEqual(planSync(remote(["new", "status"]), desired), { action: "none" });
  assert.deepEqual(planSync(remote(["new", "status"], () => "旧"), desired), {
    action: "patch",
    updates: [
      { id: "0", description: "a" },
      { id: "1", description: "b" },
    ],
  });
  assert.deepEqual(planSync(remote(["status", "new"]), desired), { action: "rebuild" });
  assert.deepEqual(planSync(remote(["new"]), desired), { action: "rebuild" });
});

test("/autoedit 解析：不带参数是切换，认 on/off/开/关，其它当聊天", () => {
  assert.deepEqual(parseCommand("/autoedit"), { kind: "autoedit" });
  assert.deepEqual(parseCommand("/autoedit on"), { kind: "autoedit", on: true });
  assert.deepEqual(parseCommand("/autoedit 关"), { kind: "autoedit", on: false });
  assert.deepEqual(parseCommand("/autoedit maybe"), { kind: "chat", text: "/autoedit maybe" });
});
