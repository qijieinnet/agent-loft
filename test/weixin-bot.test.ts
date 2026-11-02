// 微信渠道的收发流程：假的 agent 驱动 + 本地假 iLink 服务，走真的 HTTP 客户端，不连真微信。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-test-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aim-ws-"));
process.env.AGENT_LOFT_HOME = home;
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({ workspaceRoot: workspace, agents: { claude: { enabled: true }, codex: { enabled: false } }, web: { enabled: false } }),
);

// ---------- 假 iLink ----------

type Req = { path: string; headers: http.IncomingHttpHeaders; body: any };
const requests: Req[] = [];
const inbox: unknown[] = [];
const fake = {
  qrStatus: [] as object[],
  sendResp: (() => ({ ret: 0, message_id: 7500000000000000001n.toString() })) as () => object | string,
  updatesResp: undefined as object | undefined,
};
let lastCursor = "";

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, "http://x");
    requests.push({ path: url.pathname + url.search, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    const json = (v: object | string) => res.end(typeof v === "string" ? v : JSON.stringify(v));
    switch (url.pathname) {
      case "/ilink/bot/get_bot_qrcode":
        return json({ qrcode: "qr1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/qr1" });
      case "/ilink/bot/get_qrcode_status":
        return json(fake.qrStatus.shift() ?? { status: "wait" });
      case "/ilink/bot/getupdates": {
        lastCursor = requests.at(-1)!.body.get_updates_buf;
        const respond = () => {
          if (fake.updatesResp) return json(fake.updatesResp);
          const msgs = inbox.splice(0);
          json({ ret: 0, msgs, get_updates_buf: msgs.length ? `buf${Date.now()}` : lastCursor });
        };
        return void setTimeout(respond, inbox.length ? 0 : 20);
      }
      case "/ilink/bot/sendmessage":
        return json(fake.sendResp());
      case "/ilink/bot/getconfig":
        return json({ ret: 0, typing_ticket: "ticket" });
      default:
        return json({ ret: 0 });
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.AGENT_LOFT_ILINK_BASE_URL = base;

const { hub } = await import("../src/core/hub.js");
const { interactions } = await import("../src/core/interactions.js");
const { loadConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const accounts = await import("../src/core/weixin-accounts.js");
const { startWeixin, stopWeixin, weixinStatus } = await import("../src/channels/weixin/index.js");
const login = await import("../src/channels/weixin/login.js");
const { weixinEvents } = await import("../src/channels/weixin/events.js");
const { parseIlinkJson } = await import("../src/channels/weixin/client.js");
const fmt = await import("../src/channels/weixin/format.js");
import type { AgentDriver, AgentEvents, InteractionHost, InteractionOutcome } from "../src/core/types.js";

loadConfig();

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const outcomes: InteractionOutcome[] = [];
const LONG = Array.from({ length: 6 }, (_, i) => `第${i}段`.padEnd(3700, "字")).join("\n");
let sessionSeq = 0;
const histories = new Map<string, import("../src/core/types.js").HistoryMessage[]>();

function fakeDriver(): AgentDriver {
  return {
    id: "claude",
    label: "Claude Code",
    capabilities: { effort: true, fork: true, cost: false, streaming: true },
    start: async () => {},
    stop: async () => {},
    createSession(opts, events: AgentEvents, host: InteractionHost) {
      const sessionId = opts.resumeId ?? `s${++sessionSeq}`;
      if (!histories.has(sessionId)) histories.set(sessionId, []);
      // 和真 agent 一样一轮一轮来：授权挂着时，后面的消息排队
      let queue: Promise<void> = Promise.resolve();
      return {
        sessionId: undefined,
        send(input) {
          queue = queue.then(async () => {
            events.onSessionId(sessionId);
            histories.get(sessionId)!.push({ role: "user", text: input.text });
            events.onStep("tool", "🔧 做点什么");
            if (input.text.includes("授权")) {
              outcomes.push(await host({ kind: "approval", title: "需要授权：Bash", detail: "rm -rf x", alwaysLabel: "总是允许", alwaysGlobal: true }));
            }
            if (input.text.includes("提问")) {
              outcomes.push(
                await host({
                  kind: "question",
                  title: "选一个",
                  questions: [{ id: "q", header: "颜色", question: "哪个？", options: [{ label: "红" }, { label: "蓝" }], multiSelect: false, allowOther: true }],
                }),
              );
            }
            if (input.text.includes("慢")) await tick(150);
            const text = input.text.includes("长回复") ? LONG : input.text.includes("二十段") ? "x\n".repeat(30000) : `收到：${input.text}`;
            events.onText(text);
            histories.get(sessionId)!.push({ role: "assistant", text });
            events.onResult({ text, durationMs: 1 });
          });
        },
        interrupt: async () => {},
        setModel: async () => {},
        describeRuntime: async () => ({ model: "m1" }),
        dispose: async () => {},
      };
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async (id) => structuredClone(histories.get(id) ?? []),
    listModels: async () => [{ id: "m1", label: "M1" }],
    catalog: async () => [{ id: "m1", label: "M1" }],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (err) => ({ kind: "x", chatMessage: String(err), consoleHint: "" }),
  };
}
hub.registerDriver(fakeDriver());

const admin = createUser({ name: "owner", password: "password1", role: "admin" });
let key = accounts.weixinKey(admin.id);
const WX = "owner@im.wechat";

async function until(fn: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`等不到：${what}`);
    await tick(10);
  }
}
const sends = () => requests.filter((r) => r.path === "/ilink/bot/sendmessage");
const sentTexts = () => sends().map((r) => r.body.msg.item_list[0].text_item.text as string);
let msgId = 7500000000000000000n;
/** 模拟用户发一条。message_id 按 uint64 写进 JSON，和真实响应一样 */
function say(text: string, extra: object = {}) {
  inbox.push({ message_id: `${++msgId}`, from_user_id: WX, message_type: 1, context_token: `ctx${msgId}`, item_list: [{ type: 1, text_item: { text } }], ...extra });
}
async function turn(text: string): Promise<void> {
  const before = sends().length;
  say(text);
  await until(() => sends().length > before, `回复「${text}」`);
}
const webNotices: string[] = [];
hub.on("event", (env) => {
  if (env.key === key && env.ev.type === "notice") webNotices.push(env.ev.text);
});

after(async () => {
  stopWeixin();
  await hub.shutdown().catch(() => {});
  server.closeAllConnections();
  server.close();
});

// ---------- 纯函数 ----------

test("uint64 消息编号解析后不丢精度，正文里的同名字段不受影响", () => {
  const parsed = parseIlinkJson<{ message_id: string; text: string }>('{"message_id":7500000000000000123,"text":"\\"message_id\\":1"}');
  assert.equal(parsed.message_id, "7500000000000000123");
  assert.equal(parsed.text, '"message_id":1');
  assert.deepEqual(parseIlinkJson(""), {});
});

test("分段不超过上限、不丢内容，也不切开 emoji", () => {
  const text = `${"甲".repeat(3000)}\n${"乙".repeat(3000)}\n${"😀".repeat(3000)}`;
  const chunks = fmt.splitText(text);
  assert.ok(chunks.every((c) => c.length <= fmt.CHUNK_LIMIT));
  assert.equal(chunks.join("").replace(/\n/g, ""), text.replace(/\n/g, ""));
  assert.ok(chunks.every((c) => !/[\ud800-\udbff]$/.test(c)));
});

test("授权的数字含义固定，没有显示的选项不认", () => {
  const i = { spec: { kind: "approval", title: "t", detail: "d", alwaysLabel: "总是", alwaysGlobal: true } } as any;
  assert.equal(fmt.parseApproval("1", i, false), "allow-once");
  assert.equal(fmt.parseApproval("0", i, false), "deny");
  assert.equal(fmt.parseApproval("2", i, true), undefined, "这张卡没有「本会话全部允许」");
  assert.equal(fmt.parseApproval("3", i, false), undefined, "成员不能点会落盘的总是允许");
  assert.equal(fmt.parseApproval("3", i, true), "allow-always");
  assert.equal(fmt.parseApproval("好的", i, true), undefined);
  assert.ok(!fmt.approvalPrompt(i, false, 30).includes("总是"));
});

test("提问的回复：选项、越界、多选、自由作答", () => {
  const options = [{ label: "a" }, { label: "b" }];
  const make = (multiSelect: boolean) =>
    ({ spec: { kind: "question", title: "", questions: [{ id: "q", header: "", question: "?", options, multiSelect, allowOther: true }] }, selections: [[]], freeText: {} }) as any;
  assert.deepEqual(fmt.parseQuestionAnswer("2", make(false)), { kind: "options", options: [1] });
  assert.deepEqual(fmt.parseQuestionAnswer("3", make(false)), { kind: "invalid" });
  assert.deepEqual(fmt.parseQuestionAnswer("1 2", make(false)), { kind: "invalid" });
  assert.deepEqual(fmt.parseQuestionAnswer("1，2", make(true)), { kind: "options", options: [0, 1] });
  assert.deepEqual(fmt.parseQuestionAnswer("都不要", make(false)), { kind: "text" });
  assert.deepEqual(fmt.parseQuestionAnswer("跳过", make(false)), { kind: "skip" });
});

test("回复里的 Markdown 图片换成文字", () => {
  assert.equal(fmt.toWeixinText("看 ![架构图](/tmp/a.png) 和 ![](/tmp/b.png)"), "看 [图片：架构图] 和 [图片]");
});

// ---------- 扫码 ----------

test("扫码：要数字时等页面交上来，确认后保存绑定并开始收消息；token 不外露", async () => {
  startWeixin();
  fake.qrStatus = [{ status: "scaned" }, { status: "need_verifycode" }, { status: "need_verifycode" }, { status: "confirmed", bot_token: "tok-secret", ilink_bot_id: "b1@im.bot", ilink_user_id: WX, baseurl: base }];
  const started = await login.startWeixinLogin(admin.id);
  assert.match(started.qrSvg, /<svg/);
  const qrReq = requests.find((r) => r.path.startsWith("/ilink/bot/get_bot_qrcode"))!;
  assert.equal(qrReq.path, "/ilink/bot/get_bot_qrcode?bot_type=3");
  assert.deepEqual(qrReq.body, { local_token_list: [] });

  const state = () => login.weixinLoginStatus(started.id, admin.id)?.state;
  assert.equal(login.weixinLoginStatus(started.id, "别人"), undefined, "别人取不到这次登录");
  assert.equal(login.submitWeixinVerifyCode(started.id, "别人", "12"), false);
  await until(() => state() === "need_verifycode", "要求输入数字", 5000);
  assert.equal(login.submitWeixinVerifyCode(started.id, admin.id, "11"), true);
  await until(() => state() === "verify_wrong", "数字不对", 5000);
  assert.equal(login.submitWeixinVerifyCode(started.id, admin.id, "22"), true);
  await until(() => state() === "confirmed", "确认", 5000);
  const verified = requests.filter((r) => r.path.includes("verify_code=")).map((r) => r.path);
  assert.ok(verified.some((p) => p.includes("verify_code=11")) && verified.some((p) => p.includes("verify_code=22")));

  const account = accounts.getWeixinAccount(admin.id)!;
  assert.equal(account.ilinkUserId, WX);
  assert.equal((fs.statSync(path.join(home, "data", "weixin-accounts.json")).mode & 0o777).toString(8), "600");
  assert.ok(!JSON.stringify(login.weixinLoginStatus(started.id, admin.id)).includes("tok-secret"));
  await until(() => weixinStatus(admin.id)?.state === "connected", "连上");
  assert.ok(requests.some((r) => r.path === "/ilink/bot/msg/notifystart"));
});

test("没有 ilink_user_id 就不绑定：没法确认后面的消息是不是扫码人发的", async () => {
  const other = createUser({ name: "m1", password: "password1" });
  fake.qrStatus = [{ status: "confirmed", bot_token: "t", ilink_bot_id: "b" }];
  const started = await login.startWeixinLogin(other.id);
  await until(() => login.weixinLoginStatus(started.id, other.id)?.state === "failed", "失败", 5000);
  assert.equal(accounts.getWeixinAccount(other.id), undefined);
});

// ---------- 收发 ----------

test("收到消息就回复：带上最新令牌和协议字段，会话归扫码的人", async () => {
  await turn("你好");
  await until(() => sentTexts().at(-1) === "收到：你好", "回复内容");
  const req = sends().at(-1)!;
  assert.equal(req.body.msg.to_user_id, WX);
  assert.equal(req.body.msg.context_token, `ctx${msgId}`);
  assert.equal(req.body.msg.message_type, 2);
  assert.equal(req.body.msg.message_state, 2);
  assert.match(req.body.base_info.bot_agent, /^agent-loft\//, "如实声明自己，不冒充 OpenClaw");
  assert.equal(req.headers.authorization, "Bearer tok-secret");
  assert.equal(req.headers.authorizationtype, "ilink_bot_token");
  assert.equal(req.headers["ilink-app-id"], "bot");
  assert.equal(hub.conversation(key)?.owner, admin.id);
  assert.equal(hub.conversation(key)?.channel, "weixin");
  await until(() => accounts.getWeixinAccount(admin.id)!.cursor.startsWith("buf"), "游标落盘");
  assert.ok(sentTexts().every((t) => !t.includes("做点什么")), "过程不发到微信");
});

test("微信 /new 新建独立记录：旧历史保留，紧接着的消息进入新会话，旧会话的 Web 消息不发到微信", async () => {
  const oldKey = key;
  const oldSession = hub.info(oldKey)!.sessionId;
  const oldHistory = await hub.history(oldKey);
  const before = hub.list().filter((c) => c.channel === "weixin" && c.channelId === admin.id).length;
  say("/new");
  say("新话题");
  await until(() => sentTexts().at(-1) === "收到：新话题", "新会话回复");
  key = accounts.weixinKey(admin.id);
  assert.notEqual(key, oldKey);
  assert.notEqual(hub.info(key)?.sessionId, oldSession);
  assert.equal(hub.info(oldKey)?.sessionId, oldSession);
  assert.deepEqual(await hub.history(oldKey), oldHistory);
  assert.equal(hub.list().filter((c) => c.channel === "weixin" && c.channelId === admin.id).length, before + 1);
  assert.equal(hub.info(key)?.title, "新话题");
  assert.deepEqual((await hub.history(key)).map((m) => m.text), ["新话题", "收到：新话题"]);
  assert.ok(!(hub.eventsSince(key, 0) ?? []).some(({ ev }) => ev.type === "user" && ev.text === "你好"));
  const saved = JSON.parse(fs.readFileSync(path.join(home, "data", "weixin-accounts.json"), "utf8"));
  assert.equal(saved[admin.id].conversationKey, key, "当前指向已落盘，重启可恢复");
  const sent = sends().length;
  hub.send(oldKey, { text: "在旧会话继续", attachments: [] }, { channel: "web", channelId: "web" });
  await tick(100);
  assert.equal(sends().length, sent, "历史对话的 Web 回复不发到当前微信");
  assert.equal(accounts.weixinKey(admin.id), key, "查看和续聊旧会话不切换微信入口");
});

test("微信切换专家也保留旧会话；重复选择同一专家不增加记录", async () => {
  const { createExpert } = await import("../src/core/experts.js");
  const helper = createExpert(admin.id, { name: "第二位助手", engine: "claude", access: "exec", prompt: "帮忙" });
  const oldKey = key;
  const oldSession = hub.info(oldKey)?.sessionId;
  await turn(`/expert ${helper.id}`);
  key = accounts.weixinKey(admin.id);
  assert.notEqual(key, oldKey);
  assert.equal(hub.info(oldKey)?.sessionId, oldSession);
  assert.equal(hub.conversation(oldKey)?.expert, undefined);
  assert.equal(hub.conversation(key)?.expert, helper.id);
  await turn(`/expert ${helper.id}`);
  assert.equal(accounts.weixinKey(admin.id), key);
  await turn("/expert claude");
  key = accounts.weixinKey(admin.id);
});

test("微信分叉、恢复及切目录保留原记录，完全允许不带入新会话", async () => {
  await turn("分叉前的话题");
  const source = key;
  const sessionId = hub.info(source)!.sessionId!;
  await hub.setPermission(source, "full", true);
  await turn("/fork");
  key = accounts.weixinKey(admin.id);
  assert.notEqual(key, source);
  assert.equal(hub.info(source)?.sessionId, sessionId);
  assert.equal(hub.conversation(key)?.forkOf, source);
  assert.notEqual(hub.info(key)?.permission, "full");
  const forked = key;
  await turn(`/resume ${sessionId}`);
  key = accounts.weixinKey(admin.id);
  assert.notEqual(key, forked);
  assert.ok(hub.conversation(forked));
  assert.equal(hub.info(key)?.sessionId, sessionId);
  const resumed = key;
  const dir = path.join(workspace, "new-dir");
  fs.mkdirSync(dir);
  await turn(`/cd ${dir}`);
  key = accounts.weixinKey(admin.id);
  assert.notEqual(key, resumed);
  assert.equal(hub.conversation(resumed)?.cwd, workspace);
  assert.equal(hub.conversation(key)?.cwd, dir);
  await turn(`/cd ${workspace}`);
  key = accounts.weixinKey(admin.id);
});

test("处理得久时显示正在输入，结束时取消，都带 typing_ticket", async () => {
  await turn("慢一点");
  await until(() => requests.some((r) => r.path === "/ilink/bot/sendtyping" && r.body.status === 2), "取消输入");
  const typing = requests.filter((r) => r.path === "/ilink/bot/sendtyping");
  assert.equal(typing[0]!.body.status, 1);
  assert.equal(typing[0]!.body.typing_ticket, "ticket");
  assert.equal(typing[0]!.body.ilink_user_id, WX);
  const config = requests.find((r) => r.path === "/ilink/bot/getconfig")!;
  assert.match(config.body.context_token, /^ctx/);
});

test("只认扫码的微信号：陌生人、群消息、bot 自己的消息和重投都不处理", async () => {
  const before = sends().length;
  say("陌生人", { from_user_id: "stranger@im.wechat" });
  say("群里", { group_id: "g1" });
  say("回声", { message_type: 2 });
  const dup = `${++msgId}`;
  inbox.push({ message_id: dup, from_user_id: WX, message_type: 1, context_token: "c", item_list: [{ type: 1, text_item: { text: "第一次" } }] });
  inbox.push({ message_id: dup, from_user_id: WX, message_type: 1, context_token: "c", item_list: [{ type: 1, text_item: { text: "重投" } }] });
  await until(() => sentTexts().includes("收到：第一次"), "正常消息");
  await tick(100);
  assert.equal(sends().length, before + 1);
  assert.ok(!sentTexts().some((t) => /陌生人|群里|回声|重投/.test(t)));
});

test("相邻的 uint64 编号不会被当成重投", async () => {
  const before = sends().length;
  const raw = (id: bigint, text: string) => ({ message_id: id.toString(), from_user_id: WX, message_type: 1, context_token: "c", item_list: [{ type: 1, text_item: { text } }] });
  inbox.push(raw(9007199254740993n, "甲"), raw(9007199254740992n, "乙"));
  await until(() => sends().length >= before + 2, "两条都处理");
});

test("语音用微信转好的文字；图片这类先告诉用户不支持", async () => {
  say("", { item_list: [{ type: 3, voice_item: { text: "语音内容" } }] });
  await until(() => sentTexts().includes("收到：语音内容"), "语音转文字");
  say("", { item_list: [{ type: 2 }] });
  await until(() => sentTexts().at(-1)!.includes("暂时只能处理文字和语音"), "不支持的提示");
});

test("授权：回数字处理，发别的话不算放行；网页上处理了微信不再多话", async () => {
  await turn("授权一下");
  await until(() => sentTexts().at(-1)!.startsWith("🔐"), "授权请求");
  const prompt = sentTexts().at(-1)!;
  assert.ok(prompt.includes("rm -rf x") && prompt.includes("1 允许一次") && prompt.includes("3 总是允许") && !prompt.includes("2 本会话"));
  assert.equal(interactions.listPending(key).length, 1);

  await tick(2100); // 过了防误答的时间
  const n = outcomes.length;
  say("好的吧");
  await until(() => sentTexts().at(-1)!.includes("还有一个授权在等你"), "提醒");
  assert.equal(interactions.listPending(key).length, 1, "发别的话不算放行");
  say("9");
  await tick(100);
  assert.equal(interactions.listPending(key).length, 1, "没有的选项不算放行");
  say("0");
  await until(() => outcomes.length > n, "拒绝生效");
  assert.equal(outcomes.at(-1)!.settlement, "deny");
  await until(() => !hub.info(key)?.busy, "这一轮和排队的消息都结束", 3000);
});

test("授权刚发出就收到的数字不认：可能是在回答上一个", async () => {
  await turn("授权二");
  await until(() => sentTexts().at(-1)!.startsWith("🔐"), "授权请求");
  const pending = interactions.listPending(key)[0]!;
  say("1");
  await until(() => sentTexts().at(-1)!.includes("请看清内容"), "防误答提示");
  assert.ok(interactions.isPending(pending.id));
  await tick(2100);
  const n = outcomes.length;
  say("1");
  await until(() => outcomes.length > n, "放行");
  assert.equal(outcomes.at(-1)!.settlement, "allow-once");
  await until(() => !hub.info(key)?.busy, "结束");
});

test("提问：回数字作答、越界提示", async () => {
  await turn("提问一下");
  await until(() => sentTexts().at(-1)!.startsWith("❓"), "提问");
  assert.ok(sentTexts().at(-1)!.includes("1 红") && sentTexts().at(-1)!.includes("2 蓝"));
  await tick(2100);
  say("5");
  await until(() => sentTexts().at(-1)!.includes("没有这个选项"), "越界提示");
  const n = outcomes.length;
  say("2");
  await until(() => outcomes.length > n, "作答");
  assert.deepEqual(outcomes.at(-1)!.answers, { q: ["蓝"] });
  await until(() => !hub.info(key)?.busy, "结束");
});

test("长回复：一次发三段，回「继续」接着发，每段不超过上限", async () => {
  await tick(100); // 上一轮的回复发完
  const before = sends().length;
  say("长回复");
  await until(() => sends().length >= before + 3, "前三段");
  await tick(100);
  assert.equal(sends().length, before + 3);
  const third = sentTexts().at(-1)!;
  assert.match(third, /还有 3 段，回复「继续」查看/);
  say("继续");
  await until(() => sends().length >= before + 6, "后三段");
  await tick(100);
  assert.ok(!sentTexts().at(-1)!.includes("回复「继续」"));
  assert.ok(sentTexts().slice(-6).every((t) => t.length <= 4000));
  assert.ok(!sentTexts().includes("收到：继续"), "「继续」没发给 agent");
});

test("额度用完就不再硬发，Web 上说明；新的入站消息恢复", async () => {
  const account = accounts.getWeixinAccount(admin.id)!;
  say("先来一条");
  await until(() => sentTexts().at(-1) === "收到：先来一条", "回复");
  account.sentSinceInbound = 10;
  const before = sends().length;
  webNotices.length = 0;
  // 定时任务式的 Web 外结果：hub 事件直接到达，这时额度已满
  hub.emitEvent(key, { type: "result", text: "没额度的回复", footer: "", at: Date.now(), task: { id: "t", title: "日报" } });
  await until(() => webNotices.some((t) => t.includes("额度用完")), "Web 提示");
  assert.equal(sends().length, before, "没有硬发");
  say("继续");
  await until(() => sentTexts().at(-1)!.includes("没额度的回复"), "回「继续」后补发");
  assert.ok(sentTexts().at(-1)!.startsWith("⏰ 日报"));
});

test("上一条回复排队时来了新回复：各发各的，不会把长回复一口气发完", async () => {
  await tick(100);
  const before = sends().length;
  hub.emitEvent(key, { type: "result", text: "短回复", footer: "", at: Date.now(), task: { id: "t", title: "一" } });
  hub.emitEvent(key, { type: "result", text: LONG, footer: "", at: Date.now(), task: { id: "t", title: "二" } });
  await until(() => sends().length >= before + 4, "短回复和长回复的前三段");
  await tick(100);
  assert.equal(sends().length, before + 4);
});

test("Web 上说的话回复留在 Web，不花微信的额度；授权也不发到微信", async () => {
  say("换个话题");
  await until(() => sentTexts().at(-1) === "收到：换个话题", "回复");
  await tick(100);
  const before = sends().length;
  hub.send(key, { text: "网页上说的", attachments: [] }, { channel: "web", channelId: "web", name: "Web" });
  await until(() => !hub.info(key)?.busy, "这一轮结束");
  hub.send(key, { text: "网页上要授权", attachments: [] }, { channel: "web", channelId: "web", name: "Web" });
  await until(() => interactions.listPending(key).length > 0, "授权");
  await tick(100);
  assert.equal(sends().length, before);
  interactions.decide(interactions.listPending(key)[0]!.id, "deny", "web");
  await until(() => !hub.info(key)?.busy, "结束");
  assert.equal(sends().length, before);
});

test("接口受理但没给 message_id：记为可能没送到并提示，不当成成功", async () => {
  say("把额度补回来");
  await until(() => sentTexts().at(-1) === "收到：把额度补回来", "回复");
  fake.sendResp = () => ({ ret: 0 });
  webNotices.length = 0;
  await turn("没编号");
  await until(() => weixinStatus(admin.id)?.delivery === "unconfirmed", "状态");
  await until(() => webNotices.some((t) => t.includes("手机可能没收到")), "Web 提示");
  fake.sendResp = () => ({ ret: 0, message_id: "1" });
  await turn("恢复");
  await until(() => weixinStatus(admin.id)?.delivery === "ok", "恢复");
});

test("ret=-2 算发送失败：Web 提示并走系统推送，后面的分段不再发，不重试", async () => {
  fake.sendResp = () => ({ ret: -2, errmsg: "prepare failed" });
  const undelivered: string[] = [];
  const on = (e: { body: string }) => undelivered.push(e.body);
  weixinEvents.on("undelivered", on);
  webNotices.length = 0;
  const before = sends().length;
  say("长回复 被拒");
  await until(() => sends().length > before, "尝试发送");
  await until(() => weixinStatus(admin.id)?.delivery === "failed", "状态");
  await until(() => undelivered.some((b) => b.includes("ret=-2")), "推送");
  assert.ok(webNotices.some((t) => t.includes("ret=-2")));
  await tick(100);
  assert.equal(sends().length, before + 1, "第一段失败后不再发，也不重试");
  weixinEvents.off("undelivered", on);
  fake.sendResp = () => ({ ret: 0, message_id: "1" });
});

test("网络错误重试一次，用同一个 client_id", async () => {
  await tick(100);
  let failedId: string | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (!failedId && String(url).endsWith("/sendmessage")) {
      failedId = JSON.parse(init.body).msg.client_id;
      throw new TypeError("fetch failed");
    }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const before = sends().length;
    say("网络抖动");
    await until(() => sentTexts().at(-1) === "收到：网络抖动", "重试成功", 5000);
    assert.equal(sends().length, before + 1);
    assert.equal(sends().at(-1)!.body.msg.client_id, failedId);
    await until(() => weixinStatus(admin.id)?.delivery === "ok", "发送成功");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("-14 标记登录失效并提示重新扫码", async () => {
  webNotices.length = 0;
  fake.updatesResp = { ret: -14, errmsg: "session timeout" };
  await until(() => weixinStatus(admin.id)?.state === "expired", "失效");
  await until(() => webNotices.some((t) => t.includes("重新扫码")), "提示");
  fake.updatesResp = undefined;
});

test("重新扫码换新 token 时重建连接；已连接的微信重复扫码不换凭据；解绑后停止", async () => {
  fake.qrStatus = [{ status: "binded_redirect" }];
  const again = await login.startWeixinLogin(admin.id);
  await until(() => login.weixinLoginStatus(again.id, admin.id)?.state === "already", "已连接", 5000);
  assert.deepEqual(requests.filter((r) => r.path.startsWith("/ilink/bot/get_bot_qrcode")).at(-1)!.body, { local_token_list: ["tok-secret"] });

  fake.qrStatus = [{ status: "confirmed", bot_token: "tok-new", ilink_bot_id: "b2@im.bot", ilink_user_id: WX, baseurl: base }];
  const fresh = await login.startWeixinLogin(admin.id);
  await until(() => login.weixinLoginStatus(fresh.id, admin.id)?.state === "confirmed", "确认", 5000);
  await until(() => requests.at(-1)!.headers.authorization === "Bearer tok-new", "用上新 token");
  assert.equal(accounts.weixinKey(admin.id), key, "重新扫码仍接着当前会话");
  assert.equal(accounts.getWeixinAccount(admin.id)!.cursor, "", "新绑定从头收");

  assert.equal(accounts.removeWeixinAccount(admin.id), true);
  assert.equal(weixinStatus(admin.id), undefined);
  await tick(100);
  const count = requests.length;
  await tick(100);
  assert.ok(requests.length - count <= 1, "停止轮询");
});
