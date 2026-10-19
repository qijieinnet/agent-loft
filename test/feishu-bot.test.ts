// 飞书机器人的收发流程：用假的 agent 驱动 + 假的飞书客户端，不连真飞书。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-test-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aim-ws-"));
process.env.IM_AGENT_HOME = home;
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({
    workspaceRoot: workspace,
    agents: { claude: { enabled: true }, codex: { enabled: true } },
    web: { enabled: false },
    feishu: {
      bots: [
        {
          id: "b1",
          name: "测试",
          appId: "cli_x",
          appSecret: "s",
          allowFrom: ["ou_owner"],
          agents: ["codex", "claude"],
          defaultAgent: "codex",
        },
      ],
    },
  }),
);

const { hub } = await import("../src/core/hub.js");
const { interactions } = await import("../src/core/interactions.js");
const { loadConfig } = await import("../src/core/config.js");
const { FeishuBot } = await import("../src/channels/feishu/bot.js");
import type { AgentDriver, AgentEvents, InteractionHost, InteractionOutcome } from "../src/core/types.js";

loadConfig();

/** 假 agent：普通消息直接回一句；带「授权」两个字的先发起一次审批 */
const outcomes: InteractionOutcome[] = [];
function fakeDriver(id: string): AgentDriver {
  return {
    id,
    label: id === "codex" ? "Codex" : "Claude Code",
    capabilities: { effort: true, fork: true, cost: false, streaming: true },
    start: async () => {},
    stop: async () => {},
    createSession(_opts, events: AgentEvents, host: InteractionHost) {
      return {
        sessionId: undefined,
        send(input) {
          void (async () => {
            events.onSessionId(`${id}-session`);
            events.onStep("tool", "🔧 做点什么");
            if (input.text.includes("授权")) {
              const outcome = await host({ kind: "approval", title: "需要授权：Bash", detail: "rm -rf x", alwaysLabel: "总是允许" });
              outcomes.push(outcome);
            }
            events.onText(`${id} 收到：${input.text}`);
            events.onResult({ text: `${id} 收到：${input.text}`, durationMs: 10 });
          })();
        },
        interrupt: async () => {},
        setModel: async () => {},
        describeRuntime: async () => ({ model: "m1" }),
        dispose: async () => {},
      };
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [{ id: "m1", label: "M1" }],
    catalog: async () => [{ id: "m1", label: "M1" }],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (err) => ({ kind: "x", chatMessage: String(err), consoleHint: "" }),
  };
}
hub.registerDriver(fakeDriver("codex"));
hub.registerDriver(fakeDriver("claude"));

type Sent = { kind: "text" | "card" | "update"; chatId?: string; body: any; messageId?: string };
const sent: Sent[] = [];
let nextId = 0;
const bot = new FeishuBot(loadConfig().feishu.bots[0]!);
Object.assign(bot.client, {
  sendText: async (chatId: string, text: string) => (sent.push({ kind: "text", chatId, body: text }), `m${++nextId}`),
  sendCard: async (chatId: string, card: unknown) => {
    const messageId = `m${++nextId}`;
    sent.push({ kind: "card", chatId, body: card, messageId });
    return messageId;
  },
  updateCard: async (messageId: string, card: unknown) => (sent.push({ kind: "update", messageId, body: card }), true),
  addTypingReaction: async () => "r1",
  removeReaction: async () => {},
});
// 不连真飞书
Object.assign(bot as any, { connect() {}, startWatchdog() {} });
bot.start();

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const cardText = (card: any) => JSON.stringify(card);
let msgSeq = 0;
function message(openId: string, text: string, chatId = "oc_chat") {
  return (bot as any).handleMessage({
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: `om_${++msgSeq}`,
      chat_id: chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

test("陌生人只拿到配对码，消息不被处理", async () => {
  sent.length = 0;
  await message("ou_stranger", "你好", "oc_stranger");
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.body, /配对码：[A-Z2-9]{8}/);
  assert.equal(hub.conversation("feishu:b1:oc_stranger"), undefined);
});

test("主人说话：默认 agent 回复，以卡片发出", async () => {
  sent.length = 0;
  await message("ou_owner", "你好");
  await tick(200);
  const reply = sent.find((s) => s.kind === "card" && cardText(s.body).includes("codex 收到：你好"));
  assert.ok(reply, `没收到回复：${JSON.stringify(sent).slice(0, 500)}`);
  assert.equal(hub.conversation("feishu:b1:oc_chat")?.perAgent.codex?.sessionId, "codex-session");
});

test("/agent 弹选择卡，/claude 切过去，各自的会话保留", async () => {
  sent.length = 0;
  await message("ou_owner", "/agent");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("切换 Agent"));
  await message("ou_owner", "/claude");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("已切换到 Claude Code"));
  assert.equal(hub.conversation("feishu:b1:oc_chat")?.agent, "claude");
  await message("ou_owner", "/codex");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("接着它上次的会话"));
});

test("飞书上点授权卡：agent 收到允许，卡片换成结果卡", async () => {
  sent.length = 0;
  outcomes.length = 0;
  await message("ou_owner", "需要授权的事");
  await tick(200);
  const card = sent.find((s) => s.kind === "card" && cardText(s.body).includes("允许一次"));
  assert.ok(card, "没发授权卡");
  const allowButton = (card!.body as any).body.elements
    .flatMap((e: any) => e.columns ?? [])
    .flatMap((c: any) => c.elements)
    .find((b: any) => b.text?.content === "允许一次");
  const value = allowButton.behaviors[0].value;
  const res = await (bot as any).handleCardAction({
    token: "t1",
    operator: { open_id: "ou_owner" },
    context: { open_chat_id: "oc_chat", open_message_id: card!.messageId },
    action: { value },
  });
  assert.equal(res.toast.type, "success");
  assert.ok(cardText(res.card.data).includes("已允许"));
  await tick(200);
  assert.equal(outcomes[0]?.settlement, "allow-once");
  // 重投同一个回调：被去重挡掉，不会误报失效
  const again = await (bot as any).handleCardAction({
    token: "t1",
    operator: { open_id: "ou_owner" },
    context: { open_chat_id: "oc_chat" },
    action: { value },
  });
  assert.deepEqual(again, {});
});

test("别人点不动发给主人的卡", async () => {
  sent.length = 0;
  await message("ou_owner", "再来一次授权");
  await tick(200);
  const pending = interactions.listPending("feishu:b1:oc_chat")[0]!;
  const card = sent.find((s) => s.kind === "card" && cardText(s.body).includes("允许一次"))!;
  const value = JSON.parse(cardText(card.body).match(/"value":(\{[^}]*"d":"allow-once"[^}]*\})/)![1]!);
  const res = await (bot as any).handleCardAction({
    token: "t2",
    operator: { open_id: "ou_other" },
    context: { open_chat_id: "oc_chat" },
    action: { value },
  });
  assert.equal(res.toast.type, "error");
  assert.ok(interactions.isPending(pending.id));
  // Web 上处理掉：飞书那张卡自动改成结果卡
  sent.length = 0;
  interactions.decide(pending.id, "deny", "已在 Web 处理");
  await tick(100);
  const update = sent.find((s) => s.kind === "update" && s.messageId === card.messageId);
  assert.ok(update, "飞书卡片没有同步更新");
  assert.ok(cardText(update!.body).includes("已拒绝"));
  await tick(200);
  assert.equal(outcomes.at(-1)?.settlement, "deny");
});

test("Web 上说的话同步到飞书", async () => {
  sent.length = 0;
  hub.send("feishu:b1:oc_chat", { text: "从网页发的", attachments: [] }, { channel: "web", channelId: "web", name: "Web" });
  await tick(200);
  assert.ok(sent.some((s) => cardText(s.body).includes("💻 **Web**：从网页发的")));
  assert.ok(sent.some((s) => cardText(s.body).includes("codex 收到：从网页发的")));
});

test("提问挂着时，下一条消息被当成作答", async () => {
  const key = "feishu:b1:oc_chat";
  const answer = interactions.create(key, {
    kind: "question",
    title: "确认一下",
    questions: [{ id: "q1", header: "颜色", question: "哪个？", options: [{ label: "红" }], multiSelect: false, allowOther: true }],
  }, 60_000, hub.liveSessionId(key));
  await tick();
  await message("ou_owner", "蓝色");
  const outcome = await answer;
  assert.equal(outcome.settlement, "answered");
  assert.deepEqual(outcome.answers, { q1: ["蓝色"] });
});

test("收尾", () => {
  bot.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});
