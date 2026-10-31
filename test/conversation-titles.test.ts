import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDriver, HistoryMessage } from "../src/core/types.js";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-conversation-titles-"));
const { loadConfig } = await import("../src/core/config.js");
const { hub } = await import("../src/core/hub.js");
const { updateConversation, updateAgentBinding, deleteConversation } = await import("../src/core/store.js");
loadConfig();
const histories = new Map<string, HistoryMessage[]>();
const reads: string[] = [];
let readHook: ((id: string) => Promise<HistoryMessage[]>) | undefined;
let sequence = 0;
const driver: AgentDriver = {
  id: "claude", label: "Fake", capabilities: { effort: false, fork: false, cost: false, streaming: false },
  start: async () => {}, stop: async () => {},
  createSession: (_options, events) => {
    const id = `session-${++sequence}`;
    return {
      sessionId: id,
      send: (input) => {
        events.onSessionId(id);
        histories.set(id, [{ role: "user", text: input.text }]);
        events.onResult({ text: "done", durationMs: 1 });
      },
      interrupt: async () => {}, setModel: async () => {}, dispose: async () => {}, describeRuntime: async () => ({}),
    };
  },
  readHistory: async (id) => { reads.push(id); return readHook ? readHook(id) : histories.get(id) ?? []; },
  sessionTitle: async () => "整理项目资料",
  listSessions: async () => [], sessionExists: async () => true, listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
  diagnose: () => ({ kind: "test", chatMessage: "test", consoleHint: "" }),
};
hub.registerDriver(driver);
const ensure = (id: string, channel = "feishu") => {
  const key = `${channel}:bot:${id}`;
  hub.ensure({ key, channel, channelId: "bot", defaultAgent: "claude" });
  return key;
};

test("飞书和 Web 均用首条消息命名，之后同步 agent 标题，手动名称不被覆盖", async () => {
  const feishu = ensure("new");
  const web = ensure("new", "web");
  for (const key of [feishu, web]) {
    hub.send(key, { text: " 帮我整理\n 项目资料 ", attachments: [] }, { channel: "feishu", channelId: "bot" });
    assert.equal(hub.info(key)?.title, "帮我整理 项目资料");
    assert.equal(hub.conversation(key)?.titleAuto, true);
  }
  updateConversation(web, { title: "我起的名字", titleAuto: false });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(hub.info(feishu)?.title, "整理项目资料");
  assert.equal(hub.info(web)?.title, "我起的名字");
  hub.send(feishu, { text: "接下来做别的事", attachments: [] }, { channel: "feishu", channelId: "bot" });
  assert.equal(hub.info(feishu)?.title, "整理项目资料");
});

test("旧飞书会话从首条非空用户消息补标题并持久保存；保留手动名，空会话不编名字", async () => {
  const old = ensure("old");
  updateAgentBinding(old, "claude", { sessionId: "old" });
  histories.set("old", [{ role: "assistant", text: "欢迎" }, { role: "user", text: "  " }, { role: "user", text: " 检查\n NAS 的存储空间 " }]);
  const manual = ensure("manual");
  updateConversation(manual, { title: "我的 NAS", titleAuto: false });
  updateAgentBinding(manual, "claude", { sessionId: "manual" });
  const empty = ensure("empty");
  const results = await hub.backfillFeishuTitles([old, manual, empty].map((key) => hub.info(key)!));
  assert.deepEqual(results.map((c) => c.title), ["检查 NAS 的存储空间", "我的 NAS", undefined]);
  assert.equal(hub.conversation(old)?.title, "检查 NAS 的存储空间");
  const count = reads.length;
  await hub.backfillFeishuTitles([hub.info(old)!]);
  assert.equal(reads.length, count, "已命名的会话不重复读历史");
});

test("补标题期间手动改名、清空标题、切会话或删除：迟到的历史不会覆盖", async () => {
  for (const action of ["rename", "clear", "switch", "delete"]) {
    const key = ensure(`race-${action}`);
    updateAgentBinding(key, "claude", { sessionId: `race-${action}` });
    let release!: (messages: HistoryMessage[]) => void;
    readHook = () => new Promise((resolve) => { release = resolve; });
    const task = hub.backfillFeishuTitles([hub.info(key)!]);
    if (action === "rename") updateConversation(key, { title: "手动名称", titleAuto: false });
    if (action === "clear") updateConversation(key, { title: "", titleAuto: false });
    if (action === "switch") updateAgentBinding(key, "claude", { sessionId: "different" });
    if (action === "delete") deleteConversation(key);
    release([{ role: "user", text: "旧会话的问题" }]);
    await task;
    assert.equal(hub.conversation(key)?.title, action === "rename" ? "手动名称" : action === "clear" ? "" : undefined);
    readHook = undefined;
  }
});
