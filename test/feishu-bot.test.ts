// 飞书机器人的收发流程：用假的 agent 驱动 + 假的飞书客户端，不连真飞书。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-test-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aim-ws-"));
process.env.AGENT_LOFT_HOME = home;
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
import type { AgentDriver, AgentEvents, InteractionHost, InteractionOutcome, SessionOptions } from "../src/core/types.js";

loadConfig();

/** 假 agent：普通消息直接回一句；带「授权」两个字的先发起一次审批 */
const outcomes: InteractionOutcome[] = [];
/** 每次拉起会话时给的选项（看模式、记忆有没有带对） */
const created: SessionOptions[] = [];
function fakeDriver(id: string): AgentDriver {
  return {
    id,
    label: id === "codex" ? "Codex" : "Claude Code",
    capabilities: { effort: true, fork: true, cost: false, streaming: true },
    start: async () => {},
    stop: async () => {},
    createSession(opts, events: AgentEvents, host: InteractionHost) {
      created.push(opts);
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
  assert.equal(hub.info("feishu:b1:oc_chat")?.title, "你好");
  assert.equal(hub.conversation("feishu:b1:oc_chat")?.titleAuto, true);
});

test("/expert 弹选择卡，/claude 换过去开新会话，换回来也是新会话", async () => {
  sent.length = 0;
  await message("ou_owner", "/expert");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("换专家"));
  await message("ou_owner", "/claude");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("已换成专家「Claude Code」"));
  assert.equal(hub.conversation("feishu:b1:oc_chat")?.agent, "claude");
  await message("ou_owner", "/claude");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("当前已经是"));
  await message("ou_owner", "/codex");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("开了新会话"));
  assert.equal(hub.conversation("feishu:b1:oc_chat")?.perAgent.codex?.sessionId, undefined);
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

/** 在卡片里按按钮文字找回调数据 */
function buttonValue(card: any, label: string): any {
  let found: any;
  JSON.stringify(card, (_k, v) => {
    if (!found && v && v.tag === "button" && v.text?.content === label) found = v.behaviors[0].value;
    return v;
  });
  return found;
}
let cardToken = 100;
const click = (value: any, chatId = "oc_chat", openId = "ou_owner") =>
  (bot as any).handleCardAction({
    token: `t${++cardToken}`,
    operator: { open_id: openId },
    context: { open_chat_id: chatId },
    action: { value },
  });

test("/web 接上 Web 会话：飞书说的话进那条会话，回复、Web 上的话、授权卡都发到飞书；/detach 回来", async () => {
  const web = "web:t1";
  hub.ensure({ key: web, channel: "web", channelId: "web", defaultAgent: "claude", title: "网页上的活" });
  sent.length = 0;
  await message("ou_owner", "/web");
  await tick();
  const list = sent.at(-1)!;
  assert.ok(cardText(list.body).includes("网页上的活"));
  const attachValue = buttonValue(list.body, "接上");
  assert.equal(attachValue.w, web);

  // 别的聊天拿这张卡点不动
  const wrong = await click(attachValue, "oc_other");
  assert.equal(wrong.toast.type, "error");

  sent.length = 0;
  const res = await click(attachValue);
  assert.equal(res.toast.type, "success");
  await tick(100);
  assert.ok(sent.some((s) => cardText(s.body).includes("已接上 Web 会话")));
  assert.equal((bot as any).attachedWeb("feishu:b1:oc_chat"), web);

  sent.length = 0;
  await message("ou_owner", "飞书里接着说");
  await tick(200);
  assert.equal(hub.conversation(web)?.perAgent.claude?.sessionId, "claude-session", "消息没进 Web 会话");
  assert.ok(sent.some((s) => s.chatId === "oc_chat" && cardText(s.body).includes("claude 收到：飞书里接着说")));
  // 自己在飞书说的话不回显
  assert.ok(!sent.some((s) => cardText(s.body).includes("**飞书**：飞书里接着说")));

  sent.length = 0;
  hub.send(web, { text: "网页上补一句", attachments: [] }, { channel: "web", channelId: "web", name: "Web" });
  await tick(200);
  assert.ok(sent.some((s) => s.chatId === "oc_chat" && cardText(s.body).includes("💻 **Web**：网页上补一句")));
  assert.ok(sent.some((s) => s.chatId === "oc_chat" && cardText(s.body).includes("claude 收到：网页上补一句")));

  // Web 会话里的授权：飞书上能点
  sent.length = 0;
  outcomes.length = 0;
  hub.send(web, { text: "需要授权", attachments: [] }, { channel: "web", channelId: "web", name: "Web" });
  await tick(200);
  const approval = sent.find((s) => s.chatId === "oc_chat" && cardText(s.body).includes("允许一次"));
  assert.ok(approval, "授权卡没发到飞书");
  const allowed = await click(buttonValue(approval!.body, "允许一次"));
  assert.equal(allowed.toast.type, "success");
  await tick(200);
  assert.equal(outcomes[0]?.settlement, "allow-once");

  // 命令也作用在 Web 会话上
  sent.length = 0;
  await message("ou_owner", "/pwd");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes(hub.conversation(web)!.cwd));

  sent.length = 0;
  await message("ou_owner", "/detach");
  await tick();
  assert.ok(cardText(sent.at(-1)!.body).includes("已回到这个聊天自己的会话"));
  assert.equal((bot as any).attachedWeb("feishu:b1:oc_chat"), undefined);
  sent.length = 0;
  hub.send(web, { text: "回来之后网页说的", attachments: [] }, { channel: "web", channelId: "web", name: "Web" });
  await tick(200);
  assert.equal(sent.filter((s) => s.chatId === "oc_chat").length, 0, "退回来之后不该再收到 Web 会话的消息");
});

test("接着的 Web 会话被删了：自动退回来并提示", async () => {
  const web = "web:t2";
  hub.ensure({ key: web, channel: "web", channelId: "web", defaultAgent: "codex", title: "要删的" });
  await (bot as any).attachTo("feishu:b1:oc_chat", web);
  sent.length = 0;
  const { updateConversation } = await import("../src/core/store.js");
  updateConversation(web, { hidden: true });
  hub.emitEvent(web, { type: "meta" });
  await tick();
  assert.ok(sent.some((s) => cardText(s.body).includes("已经被删除")));
  assert.equal((bot as any).attachedWeb("feishu:b1:oc_chat"), undefined);
});

function groupMessage(openId: string, text: string, chatId = "oc_group") {
  return (bot as any).handleMessage({
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: `om_${++msgSeq}`,
      chat_id: chatId,
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: `@_user_1 ${text}` }),
      mentions: [{ key: "@_user_1" }],
    },
  });
}

test("/bind：私聊归绑定的人、用他的记忆、/web 只列他的；群里不让绑；解绑后交还管理员", async () => {
  const users = await import("../src/core/users.js");
  const memory = await import("../src/core/memory.js");
  const links = await import("../src/core/feishu-links.js");
  users.createUser({ name: "boss", password: "password-1", role: "admin" });
  const alice = users.createUser({ name: "alice", password: "password-2" });
  memory.setMemoryOptions(alice.id, { enabled: true, about: "alice 的自我介绍" });
  const p2p = "feishu:b1:oc_alice";

  // 先没绑定：私聊没主人，不用记忆
  sent.length = 0;
  await message("ou_owner", "你好", "oc_alice");
  await tick(100);
  assert.equal(hub.conversation(p2p)?.owner, undefined);
  assert.equal(created.at(-1)?.memory, undefined);
  const before = hub.conversation(p2p)?.perAgent.codex?.sessionId;
  assert.ok(before);

  // 群里发绑定码：不绑
  const code = links.createLinkCode(alice.id).code;
  sent.length = 0;
  await groupMessage("ou_owner", `/bind ${code}`);
  await tick();
  assert.match(cardText(sent.at(-1)!.body), /私聊里发/);
  assert.equal(links.linkedUser("b1", "ou_owner"), undefined);

  // 私聊里绑：归 alice，旧的会话不带过去，下一条消息带上她的记忆
  sent.length = 0;
  await message("ou_owner", `/bind ${code}`, "oc_alice");
  await tick();
  assert.match(cardText(sent.at(-1)!.body), /已绑定到 agent-loft 用户/);
  assert.equal(hub.conversation(p2p)?.owner, alice.id);
  assert.equal(hub.conversation(p2p)?.perAgent.codex?.sessionId, undefined, "管理员地盘里的旧会话不交给成员");
  await message("ou_owner", "现在呢", "oc_alice");
  await tick(100);
  assert.equal(created.at(-1)?.memory?.userId, alice.id);
  assert.match(created.at(-1)?.memory?.prompt ?? "", /alice 的自我介绍/);

  // 群聊不受影响：没主人、不用记忆
  await groupMessage("ou_owner", "群里说话");
  await tick(100);
  assert.equal(hub.conversation("feishu:b1:oc_group")?.owner, undefined);
  assert.equal(created.at(-1)?.memory, undefined);

  // /expert：换成 alice 自己的专家 = 开新会话，下次拉起的会话按专家来
  const experts = await import("../src/core/experts.js");
  const helper = experts.createExpert(alice.id, { name: "查资料助手", engine: "codex", access: "web", prompt: "只查资料" });
  await message("ou_owner", "/expert 查资料", "oc_alice");
  await tick();
  assert.equal(hub.conversation(p2p)?.expert, helper.id);
  assert.equal(hub.conversation(p2p)?.perAgent.codex?.sessionId, undefined, "换专家开新会话");
  await message("ou_owner", "专家在吗", "oc_alice");
  await tick(100);
  assert.equal(created.at(-1)?.expert?.name, "查资料助手");
  assert.equal(created.at(-1)?.expert?.access, "web");
  // 换回内置专家
  await message("ou_owner", "/codex", "oc_alice");
  await tick();
  assert.equal(hub.conversation(p2p)?.expert, undefined);

  // /web：只列 alice 自己的 Web 会话
  hub.ensure({ key: "web:alice1", channel: "web", channelId: "web", defaultAgent: "codex", owner: alice.id, title: "alice 的会话" });
  hub.ensure({ key: "web:boss1", channel: "web", channelId: "web", defaultAgent: "codex", title: "管理员的会话" });
  sent.length = 0;
  await message("ou_owner", "/web", "oc_alice");
  await tick();
  const list = cardText(sent.at(-1)!.body);
  assert.ok(list.includes("alice 的会话"));
  assert.ok(!list.includes("管理员的会话"));

  // 解绑：下一条消息时交还给管理员，alice 的会话不留给别人
  links.unlink("b1", "ou_owner");
  await message("ou_owner", "解绑之后", "oc_alice");
  await tick(100);
  assert.equal(hub.conversation(p2p)?.owner, undefined);
  assert.equal(created.at(-1)?.memory, undefined);
});

test("同一个机器人里的共享专家：两个账号私聊各用自己的记忆与 MCP，未绑定和群聊不可选", async () => {
  const users = await import("../src/core/users.js");
  const memory = await import("../src/core/memory.js");
  const links = await import("../src/core/feishu-links.js");
  const experts = await import("../src/core/experts.js");
  const mcp = await import("../src/core/mcp.js");
  const a = users.createUser({ name: "family-a", password: "password-1" });
  const b = users.createUser({ name: "family-b", password: "password-1" });
  // 测试机器人已有 ou_owner 白名单；第二个家人也先经过配对。
  bot.cfg.allowFrom.push("ou_family_b");
  const helper = experts.createExpert(a.id, { name: "全家共用", engine: "codex", access: "web", prompt: "共同人设", shared: true });
  for (const [user, openId, chat] of [[a, "ou_owner", "oc_family_a"], [b, "ou_family_b", "oc_family_b"]] as const) {
    memory.setMemoryOptions(user.id, { enabled: true, about: `personal-${user.name}` });
    const server = mcp.createMcp(user.id, { name: "calendar", type: "http", url: "https://calendar.example/mcp", headers: [{ name: "Authorization", value: `token-${user.name}`, secret: true }] });
    experts.setExpertTools(user.id, helper.id, { skills: [], mcp: [server.id] });
    await message(openId, `/bind ${links.createLinkCode(user.id).code}`, chat);
    await message(openId, "/expert 全家共用", chat);
    assert.equal(hub.conversation(`feishu:b1:${chat}`)?.expert, helper.id);
  }
  const before = created.length;
  await Promise.all([message("ou_owner", "家人 A 的问题", "oc_family_a"), message("ou_family_b", "家人 B 的问题", "oc_family_b")]);
  await tick(100);
  for (const user of [a, b]) {
    const session = created.slice(before).find((s) => s.memory?.userId === user.id)!;
    assert.ok(session);
    assert.equal(session.expert?.id, helper.id);
    assert.equal(session.expert?.prompt, "共同人设");
    assert.match(session.memory!.prompt, new RegExp(`personal-${user.name}`));
    assert.match(JSON.stringify(session.expert?.mcp), new RegExp(`token-${user.name}`));
    assert.doesNotMatch(JSON.stringify(session), new RegExp(`token-${user.id === a.id ? b.name : a.name}`));
  }
  await groupMessage("ou_owner", "/expert 全家共用");
  assert.equal(hub.conversation("feishu:b1:oc_group")?.expert, undefined);
  links.unlink("b1", "ou_owner");
  await message("ou_owner", "/expert 全家共用", "oc_unbound_family");
  assert.equal(hub.conversation("feishu:b1:oc_unbound_family")?.expert, undefined);
});

test("机器人直接勾选共享专家：绑定后默认使用、限制命令和旧卡片、配置撤回不退回 Agent", async () => {
  const users = await import("../src/core/users.js");
  const links = await import("../src/core/feishu-links.js");
  const experts = await import("../src/core/experts.js");
  const { createEnvelope } = await import("../src/channels/feishu/envelope.js");
  const a = users.createUser({ name: "bot-default-a", password: "password-1" });
  const b = users.createUser({ name: "bot-default-b", password: "password-1" });
  const helper = experts.createExpert(a.id, { name: "机器人默认专家", shared: true, engine: "claude", access: "web", prompt: "共同人设" });
  const another = experts.createExpert(a.id, { name: "另一位共享专家", shared: true, engine: "claude", access: "web" });
  const legacy = structuredClone(bot.cfg);
  Object.assign(bot.cfg, { agents: ["codex"], defaultAgent: "codex", experts: [helper.id], defaultExpert: helper.id });
  try {
    assert.deepEqual(bot.allowedAgents(), ["claude"], "只勾共享专家，不用另外勾底层引擎");
    links.unlink("b1", "ou_owner");
    const before = created.length;
    sent.length = 0;
    await message("ou_owner", "未绑定的问题", "oc_default_a"); await tick();
    assert.equal(created.length, before);
    assert.ok(sent.some((s) => s.kind === "text" && s.body.includes("/bind")));
    for (const [user, openId, chat] of [[a, "ou_owner", "oc_default_a"], [b, "ou_family_b", "oc_default_b"]] as const) {
      await message(openId, `/bind ${links.createLinkCode(user.id).code}`, chat);
      assert.equal(hub.conversation(`feishu:b1:${chat}`)?.expert, helper.id, "绑定即选择默认共享专家");
      await message(openId, "直接说话，不发 /expert", chat); await tick();
      assert.equal(created.at(-1)?.expert?.id, helper.id);
      assert.equal(created.at(-1)?.tasks?.userId, user.id);
    }
    const key = "feishu:b1:oc_default_a";
    await message("ou_owner", "/claude", "oc_default_a");
    assert.equal(hub.conversation(key)?.expert, helper.id, "同引擎的内置专家也不能越过勾选列表");
    await (bot as any).handleCardAction({ token: "old-agent-card", operator: { open_id: "ou_owner" }, context: { open_chat_id: "oc_default_a" }, action: { value: createEnvelope({ a: "agent", g: "claude", k: key }, { operatorOpenId: "ou_owner", chatId: "oc_default_a", expiresAt: Date.now() + 60000 }) } });
    await tick();
    assert.equal(hub.conversation(key)?.expert, helper.id, "旧卡片也受最新的机器人专家列表约束");
    sent.length = 0;
    await message("ou_owner", "/expert", "oc_default_a");
    assert.ok(cardText(sent.at(-1)!.body).includes("机器人默认专家"));
    assert.ok(!cardText(sent.at(-1)!.body).includes("另一位共享专家"));
    bot.cfg.experts = [helper.id, another.id];
    bot.cfg.defaultExpert = another.id;
    await message("ou_owner", "/expert 另一位共享专家", "oc_default_a");
    await message("ou_owner", "继续使用手动选择", "oc_default_a"); await tick();
    assert.equal(hub.conversation(key)?.expert, another.id);
    bot.cfg.experts = [helper.id];
    bot.cfg.defaultExpert = helper.id;
    await message("ou_owner", "配置收回另一个专家后", "oc_default_a"); await tick();
    assert.equal(hub.conversation(key)?.expert, helper.id);
    experts.updateExpert(a.id, helper.id, { shared: false });
    const n = created.length;
    await message("ou_family_b", "共享已撤回", "oc_default_b"); await tick();
    assert.equal(created.length, n, "默认专家不可用时不悄悄启动底层 Agent");
    assert.equal(hub.conversation("feishu:b1:oc_default_b")?.expert, helper.id);
  } finally {
    delete bot.cfg.experts;
    delete bot.cfg.defaultExpert;
    Object.assign(bot.cfg, legacy);
  }
});

test("收尾", () => {
  bot.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});
