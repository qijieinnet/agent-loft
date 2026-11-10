// 一个微信绑定 = 一条长轮询 + 一条当前会话；历史会话保留在同一用户的微信分组。
//
// 和飞书的差别都来自微信的限制，别按飞书的习惯改回去：
//   - 消息发出去不能改，所以不发过程，只显示「正在输入」，一轮结束发一次结果；
//   - 没有卡片，授权和提问都是一条文字，回复数字作答；同一时间只显示一个，免得数字答错对象；
//   - 社区实测每条入站消息之后只能发约 10 条（见 Tencent/openclaw-weixin#202），超过就发不出去。
//     这里自己数着：长回复分段，发不完的等用户回「继续」，这条入站又会把额度补回来；
//   - 大约 24 小时没收到用户消息后，微信会拒绝发送（ret=-2），所以微信不是可靠的提醒渠道。
//     发不出去、或者接口受理了却没给 message_id，都要在 Web 上说一声，并走系统推送。
import { config } from "../../core/config.js";
import { Dedup } from "../../core/dedup.js";
import { hub, type EventEnvelope } from "../../core/hub.js";
import { parseCommand } from "../../core/commands.js";
import { interactions, unansweredCount, type Interaction } from "../../core/interactions.js";
import { getConversation, sessionOwner } from "../../core/store.js";
import { getUser, isAdmin, ownedBy, type User } from "../../core/users.js";
import { patchWeixinAccount, weixinKey, type WeixinAccount } from "../../core/weixin-accounts.js";
import { IlinkClient, IlinkError, isTimeout, newClientId, SESSION_EXPIRED, type WeixinMessage } from "./client.js";
import {
  approvalPrompt,
  commandReplyText,
  currentQuestion,
  inboundText,
  parseApproval,
  parseQuestionAnswer,
  questionPrompt,
  splitText,
  toWeixinText,
} from "./format.js";
import { weixinEvents } from "./events.js";
import { ensureWeixinConversation } from "./conversation.js";

/** 每条入站消息之后能发的条数（社区实测，官方没有公布） */
export const SEND_LIMIT = 10;
/** 一次最多发几段回复。再长就等用户回「继续」，免得一条回复刷满屏 */
const MAX_CHUNKS_PER_ROUND = 3;
/** 额度低于这个数时不发提示类消息，留给回复和授权 */
const NOTICE_RESERVE = 3;
/** 授权请求刚换过时，这么短时间内收到的数字可能是在回答上一个，不认 */
const ANSWER_GRACE_MS = 2000;
const TYPING_KEEPALIVE_MS = 5000;
const TYPING_MAX_MS = 30 * 60_000;
const TICKET_TTL_MS = 12 * 3600_000;
/** Web 上「可能没送到」的提示隔多久才再说一次 */
const WARN_INTERVAL_MS = 10 * 60_000;
const EXPIRED_RETRY_MS = 3600_000;
const RETRY_DELAY_MS = 2000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const ORIGIN = { channel: "weixin", name: "微信" };

export type WeixinStatus = {
  state: "connecting" | "connected" | "reconnecting" | "expired" | "stopped";
  since: number;
  error?: string;
  /** 最近一次发送的结果。unconfirmed：接口受理了但没给 message_id，手机可能没收到 */
  delivery?: "ok" | "unconfirmed" | "failed";
  deliveryAt?: number;
};

export class WeixinBot {
  readonly client: IlinkClient;
  get key(): string { return weixinKey(this.account.userId); }
  private eventKey: string | undefined;
  status: WeixinStatus = { state: "stopped", since: Date.now() };
  private dedup = new Dedup();
  private stop_ = new AbortController();
  private offs: (() => void)[] = [];
  /** 发送串行：回复、授权的先后不能乱 */
  private sendChain: Promise<unknown> = Promise.resolve();
  /** 入站串行：前一条还在处理（比如换专家）时，后一条不能抢在前面 */
  private inboundChain: Promise<unknown> = Promise.resolve();
  /** 最后一个说话的渠道：Web 上说的话，回复留在 Web，不花微信的额度 */
  private lastOrigin: string | undefined;
  /** 还没发出去的回复分段 */
  private pendingChunks: string[] = [];
  /** 微信上正显示着的授权 / 提问 */
  private shown: { id: string; at: number; question: number } | undefined;
  private typing: { ticket: string; timer: NodeJS.Timeout; deadline: number } | undefined;
  private ticket: { value: string; at: number } | undefined;
  /** 每种提示上次在 Web 上说的时间 */
  private warned = new Map<string, number>();
  /** 这一轮还要不要「正在输入」：等 ticket 的空当里这一轮可能已经结束了 */
  private typingWanted = false;
  /** 自己发的提示不再发回微信，否则发送失败时会循环 */
  private ownNotice = false;

  constructor(readonly account: WeixinAccount) {
    this.client = new IlinkClient(account.baseUrl, account.botToken);
  }

  private get user(): User | undefined {
    const user = getUser(this.account.userId);
    return user && !user.disabled ? user : undefined;
  }

  private get admin(): boolean {
    return isAdmin(this.user);
  }

  private setStatus(state: WeixinStatus["state"], error?: string): void {
    if (this.status.state === state && !error) return;
    const { delivery, deliveryAt } = this.status;
    this.status = { state, since: Date.now(), ...(error ? { error } : {}), ...(delivery ? { delivery } : {}), ...(deliveryAt ? { deliveryAt } : {}) };
  }

  // ---------- 生命周期 ----------

  start(): void {
    const onEvent = (env: EventEnvelope) => {
      if (env.key !== this.key) return;
      if (this.eventKey !== env.key) {
        this.eventKey = env.key;
        this.lastOrigin = undefined;
        this.shown = undefined;
        this.pendingChunks = [];
      }
      this.onHubEvent(env);
    };
    hub.on("event", onEvent);
    this.offs.push(() => hub.off("event", onEvent));

    const onCreated = (i: Interaction) => {
      if (i.convKey === this.key) this.showNextPrompt();
    };
    const onUpdated = (i: Interaction) => {
      if (i.id !== this.shown?.id) return;
      const q = currentQuestion(i);
      if (q >= 0 && q !== this.shown.question) this.showPrompt(i);
    };
    const onSettled = (i: Interaction) => {
      if (i.convKey !== this.key || i.id !== this.shown?.id) return;
      this.shown = undefined;
      this.showNextPrompt();
      if (!this.shown && hub.info(this.key)?.busy) void this.startTyping();
    };
    interactions.on("created", onCreated);
    interactions.on("updated", onUpdated);
    interactions.on("settled", onSettled);
    this.offs.push(() => {
      interactions.off("created", onCreated);
      interactions.off("updated", onUpdated);
      interactions.off("settled", onSettled);
    });

    this.setStatus("connecting");
    void this.client.notifyStart().catch((err) => console.warn(`${this.tag} notifystart 失败（不影响收发）: ${errText(err)}`));
    void this.pollLoop();
  }

  /** silent：解绑后 token 不再有效，不用再告诉微信 */
  stop(opts: { silent?: boolean } = {}): void {
    this.stop_.abort();
    for (const off of this.offs.splice(0)) off();
    void this.stopTyping();
    if (!opts.silent) void this.client.notifyStop().catch(() => {});
    this.setStatus("stopped");
  }

  private get tag(): string {
    return `[微信:${this.account.userId}]`;
  }

  // ---------- 收消息 ----------

  private async pollLoop(): Promise<void> {
    const signal = this.stop_.signal;
    let cursor = this.account.cursor;
    let timeoutMs: number | undefined;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const resp = await this.client.getUpdates(cursor, timeoutMs, signal);
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;
        if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
          if (resp.ret === SESSION_EXPIRED || resp.errcode === SESSION_EXPIRED) {
            this.onSessionExpired();
            failures = 0;
            await this.sleep(EXPIRED_RETRY_MS);
            continue;
          }
          throw new IlinkError("getupdates", resp.ret, resp.errcode, resp.errmsg);
        }
        failures = 0;
        this.setStatus("connected");
        if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
          cursor = resp.get_updates_buf;
          this.account.cursor = cursor;
          patchWeixinAccount(this.account.userId, { cursor });
        }
        for (const msg of resp.msgs ?? []) this.onInbound(msg);
      } catch (err) {
        if (signal.aborted) return;
        // 长轮询超时是常态：这段时间没有新消息
        if (isTimeout(err)) continue;
        failures += 1;
        this.setStatus("reconnecting", errText(err));
        console.error(`${this.tag} 收消息失败（${failures}/${MAX_CONSECUTIVE_FAILURES}）: ${errText(err)}`);
        await this.sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.stop_.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private onSessionExpired(): void {
    if (this.status.state === "expired") return;
    this.setStatus("expired", "微信登录已失效");
    console.error(`${this.tag} 微信登录已失效，需要重新扫码`);
    this.warnWeb("微信登录已失效，收不到微信消息了。请到「设置 → 账号 → 微信」重新扫码。", true);
  }

  private onInbound(msg: WeixinMessage): void {
    // 只处理真人发的私聊。bot 自己的消息、群消息都不是给这条会话的
    if (msg.message_type !== 1 || msg.group_id) return;
    if (msg.from_user_id !== this.account.ilinkUserId) {
      console.warn(`${this.tag} 忽略非绑定微信号发来的消息`);
      return;
    }
    if (msg.message_id !== undefined && this.dedup.isDuplicate(String(msg.message_id))) return;
    // 新的入站消息：令牌换新、额度补满。写在排队之前，紧接着的发送就能用上
    if (msg.context_token) this.account.contextToken = msg.context_token;
    this.account.lastInboundAt = Date.now();
    this.account.sentSinceInbound = 0;
    patchWeixinAccount(this.account.userId, {
      ...(msg.context_token ? { contextToken: msg.context_token } : {}),
      lastInboundAt: this.account.lastInboundAt,
      sentSinceInbound: 0,
    });
    this.inboundChain = this.inboundChain
      .then(() => this.handleInbound(msg))
      .catch((err) => {
        console.error(`${this.tag} 处理消息失败:`, err);
        this.say(`出错了：${errText(err)}`);
      });
  }

  private async handleInbound(msg: WeixinMessage): Promise<void> {
    const user = this.user;
    if (!user) return;
    const { text, unsupported } = inboundText(msg);
    if (unsupported) {
      this.say("暂时只能处理文字和语音（语音要微信能转成文字）。图片、文件、视频请到网页上发。");
      return;
    }
    if (!text) return;

    const allowed = await ensureWeixinConversation(user.id);
    if (!allowed) {
      this.say("你现在没有可用的专家。所选专家可能已取消共享、删除，或引擎已停用。");
      return;
    }

    const command = parseCommand(text);
    if (command.kind !== "chat") {
      const reply = await hub.command(this.key, command, {
        allowedAgents: allowed,
        by: "微信命令",
        channel: "weixin",
        sessionVisible: (id) => ownedBy(user, sessionOwner(id)),
        convVisible: (k) => ownedBy(user, getConversation(k)?.owner),
        allowGlobalAlways: this.admin,
        allowFullAccess: this.admin,
      });
      const shown = commandReplyText(reply, (a) => hub.label(a));
      if (shown) this.reply(shown);
      return;
    }

    if (this.answerPrompt(text)) return;

    if (this.pendingChunks.length > 0 && text === "继续") {
      this.enqueueSend(() => this.sendRound());
      return;
    }

    // 回了别的话，上一条没看完的就不再接着发了（网页上有完整内容）
    this.enqueueSend(async () => {
      this.pendingChunks = [];
    });
    this.lastOrigin = ORIGIN.channel;
    hub.send(this.key, { text, attachments: [] }, { ...ORIGIN, channelId: user.id });
    void this.startTyping();
  }

  // ---------- 授权和提问 ----------

  /** 看这条消息是不是在回答正显示的授权 / 提问。返回 true 表示用掉了，不再发给 agent */
  private answerPrompt(text: string): boolean {
    const shown = this.shown;
    if (!shown) return false;
    const i = interactions.get(shown.id);
    if (!i || i.settled) {
      this.shown = undefined;
      return false;
    }
    const by = "已在微信处理";
    const tooSoon = Date.now() - shown.at < ANSWER_GRACE_MS;

    if (i.spec.kind === "approval") {
      const decision = parseApproval(text, i, this.admin);
      if (decision === undefined) {
        // 不阻塞的卡（Codex 出完方案问开不开始做）：另外发消息就是不用它了，照常发给 agent
        if (!i.spec.detached) this.say(`还有一个授权在等你：回复 1 ${i.spec.allowLabel ?? "允许一次"}，回复 0 ${i.spec.denyLabel ?? "拒绝"}。这条消息已排队，处理完授权才会发给 agent。`);
        return false;
      }
      if (tooSoon) {
        this.say("刚换了一个新的授权请求，请看清内容后再回复。");
        return true;
      }
      interactions.decide(i.id, decision, by);
      return true;
    }

    const answer = parseQuestionAnswer(text, i);
    switch (answer.kind) {
      case "skip":
        interactions.skip(i.id, "已在微信跳过，agent 会按合理的默认继续");
        return true;
      case "invalid":
        this.say("没有这个选项，请重新回复。");
        return true;
      case "text":
        // 交给 hub.send：它会判断提问是否还属于当前会话，再当成自由作答
        return false;
      case "options": {
        if (tooSoon) {
          this.say("刚换了一个新的问题，请看清内容后再回复。");
          return true;
        }
        const q = currentQuestion(i);
        let settled = false;
        for (const option of answer.options) {
          settled = interactions.select(i.id, q, option, true, by)?.submitted ?? settled;
        }
        if (!settled) {
          const latest = interactions.get(i.id);
          // 多选题没有自动交卷：都答完了就替他提交
          if (latest && !latest.settled && unansweredCount(latest) === 0) interactions.submit(i.id, by);
        }
        return true;
      }
    }
  }

  /** Web 上发起的这一轮，Web 上有卡片，不打扰微信 */
  private showNextPrompt(): void {
    if (this.shown || this.lastOrigin === "web") return;
    const next = interactions.listPending(this.key).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) this.showPrompt(next);
  }

  private showPrompt(i: Interaction): void {
    const shown = { id: i.id, at: Date.now(), question: currentQuestion(i) };
    this.shown = shown;
    void this.stopTyping();
    const timeoutMin = Math.round(config().approvalTimeoutMs / 60_000);
    this.enqueueSend(async () => {
      const latest = interactions.get(i.id);
      if (!latest || latest.settled) return;
      const text =
        latest.spec.kind === "approval"
          ? approvalPrompt(latest, this.admin, timeoutMin)
          : questionPrompt(latest, hub.label(getConversation(this.key)?.agent ?? ""));
      const sent = this.remaining() > 0 && (await this.sendOne(text));
      // 真正发出去的时刻才开始算：之前收到的数字不可能是在回答这一个
      shown.at = Date.now();
      if (!sent) this.warnWeb("微信发不出这个授权 / 提问，请在这里处理。", true);
    });
  }

  // ---------- 渲染 hub 事件 ----------

  private onHubEvent({ ev }: EventEnvelope): void {
    switch (ev.type) {
      case "user":
        this.lastOrigin = ev.origin.channel;
        return;
      case "result": {
        void this.stopTyping();
        if (ev.silent) return;
        // Web 上说的话，回复留在 Web；定时任务的结果要发过来
        if (this.lastOrigin === "web" && !ev.task) return;
        const body = ev.task ? `⏰ ${ev.task.title}\n\n${ev.text}` : ev.text;
        if (body.trim()) this.reply(body);
        return;
      }
      case "error":
        void this.stopTyping();
        if (this.lastOrigin !== "web") this.say(ev.message);
        return;
      case "notice":
        if (!this.ownNotice && this.lastOrigin !== "web") this.notice(ev.text);
        return;
      case "state":
        if (!ev.busy) void this.stopTyping();
        return;
      default:
        return;
    }
  }

  // ---------- 发消息 ----------

  /** 别的对话里的定时任务选了推送到微信：把结果发过来 */
  pushTaskResult(title: string, text: string): void {
    const body = `⏰ ${title}\n\n${text}`;
    if (text.trim()) this.reply(body);
  }

  private remaining(): number {
    return SEND_LIMIT - this.account.sentSinceInbound;
  }

  /** 一段完整的回复：太长就分段，发不完的留着等「继续」 */
  private reply(markdown: string): void {
    const chunks = splitText(toWeixinText(markdown));
    // 改分段也排进发送队列：前一条回复可能还没发完，它不能把这条的分段也一起发了
    this.enqueueSend(async () => {
      this.pendingChunks = chunks;
      await this.sendRound();
    });
  }

  /** 发一轮分段。只在发送队列里调用 */
  private async sendRound(): Promise<void> {
    const rem = this.remaining();
    if (this.pendingChunks.length > 0 && rem <= 0) {
      this.warnWeb("微信这边的发送额度用完了，这条回复还没发过去，在这里能看到完整内容。在微信里回复「继续」就会接着发。", true);
      return;
    }
    const round = this.pendingChunks.splice(0, Math.min(MAX_CHUNKS_PER_ROUND, rem));
    for (const [index, chunk] of round.entries()) {
      const left = this.pendingChunks.length;
      const tail = index === round.length - 1 && left > 0 ? `\n\n（还有 ${left} 段，回复「继续」查看，网页上有完整内容）` : "";
      if (!(await this.sendOne(chunk + tail))) {
        this.pendingChunks = [];
        return;
      }
    }
  }

  /** 一句话：错误、提示。不分段 */
  private say(text: string): void {
    this.enqueueSend(async () => {
      if (this.remaining() > 0) await this.sendOne(splitText(toWeixinText(text))[0] ?? "");
    });
  }

  /** 可有可无的提示：额度紧张时不发，留给回复和授权 */
  private notice(text: string): void {
    this.enqueueSend(async () => {
      if (this.remaining() > NOTICE_RESERVE) await this.sendOne(splitText(toWeixinText(text))[0] ?? "");
    });
  }

  private enqueueSend(task: () => Promise<void>): void {
    this.sendChain = this.sendChain.then(task).catch((err) => console.error(`${this.tag} 发送失败:`, errText(err)));
  }

  /** 发一条。返回 false 表示确定没发出去，后面的也不用发了 */
  private async sendOne(text: string): Promise<boolean> {
    if (!text.trim()) return true;
    const contextToken = this.account.contextToken;
    if (!contextToken) {
      this.markDelivery("failed");
      this.warnWeb("还没收到过你的微信消息，微信不允许先发。请先在微信里给 ClawBot 发一条消息。", true);
      return false;
    }
    const clientId = newClientId();
    const payload = { to: this.account.ilinkUserId, text, contextToken, clientId };
    try {
      let result;
      try {
        result = await this.client.sendText(payload);
      } catch (err) {
        if (err instanceof IlinkError) throw err;
        // 网络问题重试一次。同一个 client_id，万一上次其实到了也不会重复显示
        await this.sleep(RETRY_DELAY_MS);
        result = await this.client.sendText(payload);
      }
      this.account.sentSinceInbound += 1;
      patchWeixinAccount(this.account.userId, { sentSinceInbound: this.account.sentSinceInbound });
      if (result.confirmed) {
        this.markDelivery("ok");
      } else {
        this.markDelivery("unconfirmed");
        this.warnWeb("微信接口受理了回复，但没有返回消息编号，手机可能没收到（微信可能在限制这个账号）。");
      }
      return true;
    } catch (err) {
      this.markDelivery("failed");
      console.error(`${this.tag} 发送失败: ${errText(err)}`);
      if (err instanceof IlinkError && err.sessionExpired) {
        this.onSessionExpired();
      } else if (err instanceof IlinkError && err.ret === -2) {
        this.warnWeb(`微信拒绝发送这条消息（ret=-2）。${this.idleHint()}在微信里发一条消息就能恢复。`, true);
      } else {
        this.warnWeb(`微信发送失败：${errText(err)}`, true);
      }
      return false;
    }
  }

  private idleHint(): string {
    const at = this.account.lastInboundAt;
    return at && Date.now() - at > 23 * 3600_000 ? "你已经超过一天没在微信里说话，微信不允许这时主动发消息。" : "";
  }

  private markDelivery(delivery: NonNullable<WeixinStatus["delivery"]>): void {
    this.status = { ...this.status, delivery, deliveryAt: Date.now() };
  }

  /** 在 Web 的这条对话里说一声，urgent 的同时走系统推送。隔一段时间才再说，免得刷屏 */
  private warnWeb(text: string, urgent = false): void {
    const now = Date.now();
    if (now - (this.warned.get(text) ?? 0) < WARN_INTERVAL_MS) return;
    this.warned.set(text, now);
    this.ownNotice = true;
    try {
      if (getConversation(this.key)) hub.notice(this.key, text);
    } finally {
      this.ownNotice = false;
    }
    if (urgent) weixinEvents.emit("undelivered", { key: this.key, userId: this.account.userId, body: text });
  }

  // ---------- 正在输入 ----------

  private async startTyping(): Promise<void> {
    const contextToken = this.account.contextToken;
    this.typingWanted = true;
    if (this.typing || !contextToken) return;
    try {
      if (!this.ticket || Date.now() - this.ticket.at > TICKET_TTL_MS) {
        const value = await this.client.typingTicket(this.account.ilinkUserId, contextToken);
        if (!value) return;
        this.ticket = { value, at: Date.now() };
      }
      if (this.typing || !this.typingWanted) return;
      const ticket = this.ticket.value;
      const send = () => this.client.sendTyping(this.account.ilinkUserId, ticket, true).catch(() => {});
      void send();
      const deadline = Date.now() + TYPING_MAX_MS;
      const timer = setInterval(() => {
        if (Date.now() > deadline) void this.stopTyping();
        else void send();
      }, TYPING_KEEPALIVE_MS);
      timer.unref?.();
      this.typing = { ticket, timer, deadline };
    } catch (err) {
      console.warn(`${this.tag} 「正在输入」发送失败（不影响回复）: ${errText(err)}`);
    }
  }

  private async stopTyping(): Promise<void> {
    this.typingWanted = false;
    const typing = this.typing;
    if (!typing) return;
    this.typing = undefined;
    clearInterval(typing.timer);
    await this.client.sendTyping(this.account.ilinkUserId, typing.ticket, false).catch(() => {});
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
