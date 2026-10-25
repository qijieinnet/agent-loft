// 一个飞书机器人 = 一条长连接 + 一组会话。
//
// 它是 hub 的一个渠道：把飞书消息翻成 hub.send / hub.command，把 hub 的事件和
// 交互请求画成飞书卡片。同一条会话在 Web 上被操作时，这里照样收到事件 ——
// 所以 Web 上说的话、点的授权，飞书这边都会同步显示。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { config, type FeishuBotConfig } from "../../core/config.js";
import { hub, type CommandReply, type EventEnvelope } from "../../core/hub.js";
import { interactions, type Interaction } from "../../core/interactions.js";
import { parseCommand } from "../../core/commands.js";
import { Dedup } from "../../core/dedup.js";
import { isPaired, requestPairing } from "../../core/pairing.js";
import { getConversation, listConversations, sessionOwner, updateConversation } from "../../core/store.js";
import { adminVisible, getUser, hasMembers, ownedBy, type User } from "../../core/users.js";
import { linkedUser, redeemLinkCode } from "../../core/feishu-links.js";
import { adoptFile, KIND_LABEL } from "../../core/uploads.js";
import type { SavedAttachment } from "../../core/types.js";
import { FeishuClient } from "./client.js";
import { SlashSync } from "./slash-sync.js";
import type { CommandEntry } from "../../core/command-catalog.js";
import { attach, attachedTarget, detach, watchersOf } from "./attach.js";
import {
  agentPickerCard,
  approvalCard,
  attachedCard,
  commandListCard,
  modelPickerCard,
  progressCard,
  questionCard,
  replyCard,
  sessionListCard,
  settledCard,
  webListCard,
  type WebConvEntry,
} from "./cards.js";
import { decodeEnvelope, DECODE_FAILURE_TEXT, type CardCtx, type CardEnvelope } from "./envelope.js";
import { parseMessage, unsupportedTypeLabel, type AttachmentRef } from "./message.js";
import { TurnStream } from "./turn-stream.js";

type CardResponse = {
  toast?: { type: "info" | "success" | "error" | "warning"; content: string };
  card?: { type: "raw"; data: unknown };
};

export type BotStatus = { state: string; since: number; error?: string };

type FeishuCommand = { kind: "web" } | { kind: "detach" } | { kind: "bind"; code: string };

/** 只在飞书里认的命令：挂到 Web 会话上 / 退回来 / 绑定账号。整条消息只有命令才算 */
function feishuCommandOf(text: string): FeishuCommand | null {
  const t = text.trim().replace(/^／/, "/");
  const lower = t.toLowerCase();
  if (lower === "/web") return { kind: "web" };
  if (lower === "/detach") return { kind: "detach" };
  const bind = /^\/bind\s+([A-Za-z0-9]{4,16})$/i.exec(t);
  if (bind) return { kind: "bind", code: bind[1]! };
  return null;
}

/** 一条会话画到某个飞书聊天里：流式卡片、操作人都按这一对记 */
const pairKey = (key: string, chatId: string) => `${key}\n${chatId}`;

export class FeishuBot {
  readonly client: FeishuClient;
  private ws: Lark.WSClient | null = null;
  private dedup = new Dedup();
  /** (会话键, 聊天) → 这一轮的输出编排。一条 Web 会话可能同时画在好几个飞书聊天里 */
  private streams = new Map<string, TurnStream>();
  private typing = new Map<string, { messageId: string; reactionId: string }>();
  /** 交互 id → 发出去的飞书卡片（可能发在好几个聊天里） */
  private cards = new Map<string, { chatId: string; messageId: string }[]>();
  /** (会话键, 聊天) → 最后一个在这个聊天里说话的人。卡片默认只让他点 */
  private operators = new Map<string, string>();
  /** 附件要先下载才能送，紧跟着的文字不能抢在前面 —— 每条会话一条串行链 */
  private chains = new Map<string, Promise<void>>();
  private offs: (() => void)[] = [];
  private watchdog: NodeJS.Timeout | null = null;
  private downSince: number | undefined;
  private stopped = false;
  status: BotStatus = { state: "stopped", since: Date.now() };

  /** 飞书输入框里「/」弹出的指令面板 */
  readonly slash: SlashSync;
  private slashTimer: NodeJS.Timeout | null = null;

  constructor(readonly cfg: FeishuBotConfig) {
    this.client = new FeishuClient(cfg.appId, cfg.appSecret, cfg.domain, `飞书:${cfg.name}`);
    this.slash = new SlashSync(this.client.lark, () => this.slashCommands(), `[飞书:${cfg.name}]`);
  }

  /**
   * 这个机器人该注册的命令：默认 agent 的命令表在前，其它可用 agent 的原生命令接在后面。
   * 飞书的指令面板是整个应用一份，不分会话，没法跟着每个会话当前的 agent 变。
   */
  private async slashCommands(): Promise<CommandEntry[]> {
    const agents = [this.cfg.defaultAgent, ...this.cfg.agents.filter((a) => a !== this.cfg.defaultAgent)];
    const out: CommandEntry[] = [];
    for (const agent of agents) {
      if (!hub.driver(agent)) continue;
      out.push(...(await hub.commandCatalog(agent, { allowedAgents: this.cfg.agents, channel: "feishu" })));
    }
    return out;
  }

  get id(): string {
    return this.cfg.id;
  }

  private get tag(): string {
    return `[飞书:${this.cfg.name}]`;
  }

  private get prefix(): string {
    return `feishu:${this.cfg.id}:`;
  }

  keyOf(chatId: string, threadId?: string): string {
    return `${this.prefix}${chatId}${threadId ? `:${threadId}` : ""}`;
  }

  private chatIdOf(key: string): string {
    return key.slice(this.prefix.length).split(":")[0]!;
  }

  private mine(key: string): boolean {
    return key.startsWith(this.prefix);
  }

  /** 这个机器人能用的 agent：配置里勾选的 ∩ 已启用的 */
  allowedAgents(): string[] {
    const enabled = new Set(hub.enabledAgents().map((d) => d.id));
    return this.cfg.agents.filter((a) => enabled.has(a));
  }

  /** 某条会话能切到哪些 agent：自己的会话按机器人的勾选；接着的 Web 会话和 Web 上一样，启用的都行 */
  private allowedFor(key: string): string[] {
    return this.mine(key) ? this.allowedAgents() : hub.enabledAgents().map((d) => d.id);
  }

  // ---------- 这个聊天能碰哪些东西 ----------
  //
  // 飞书聊天自己的会话有主人（绑定了账号的私聊，见 core/feishu-links.ts）：按主人算，和他在 Web 上一样；
  // 没主人（群聊、没绑定的私聊）：照旧是管理员的地盘。

  /** 飞书会话键的主人（绑定了账号的私聊才有） */
  private viewerOf(feishuKey: string): User | undefined {
    const owner = getConversation(feishuKey)?.owner;
    const user = getUser(owner);
    return user && !user.disabled ? user : undefined;
  }

  /** feishuKey 这个聊天能不能碰主人是 owner 的东西（Web 会话、agent 会话） */
  private canSee(feishuKey: string, owner: string | undefined): boolean {
    const viewer = this.viewerOf(feishuKey);
    return viewer ? ownedBy(viewer, owner) : adminVisible(owner);
  }

  /** 命令里要用的可见范围：/sessions 列哪些、/resume 能恢复哪些、/approve 能处理哪些 */
  private commandScope(feishuKey: string) {
    const viewer = this.viewerOf(feishuKey);
    return {
      ...(viewer
        ? { sessionVisible: (id: string) => ownedBy(viewer, sessionOwner(id)) }
        : hasMembers()
          ? { sessionVisible: (id: string) => adminVisible(sessionOwner(id)) }
          : {}),
      convVisible: (k: string) => this.canSee(feishuKey, getConversation(k)?.owner),
    };
  }

  // ---------- 接着 Web 会话 ----------

  /** 飞书会话键挂着的 Web 会话（还在、没被删的）；没挂着返回 undefined */
  attachedWeb(feishuKey: string): string | undefined {
    const target = attachedTarget(feishuKey);
    if (!target) return undefined;
    const conv = getConversation(target);
    // 这个聊天不再能碰它了（主人被降成了普通成员、私聊换了主人）：当它没了（下条消息时自动退回来）
    return conv && !conv.hidden && this.canSee(feishuKey, conv.owner) ? target : undefined;
  }

  /** 挂在 Web 会话 key 上的本机器人聊天（只算还能碰它的） */
  private watchers(key: string): string[] {
    const owner = getConversation(key)?.owner;
    return watchersOf(key, this.prefix).filter((k) => this.canSee(k, owner));
  }

  /** 这条会话的事件该画到哪些飞书聊天里：自己的那个聊天，加上挂着它的聊天 */
  chatsOf(key: string): string[] {
    const out = new Set<string>();
    if (this.mine(key)) out.add(this.chatIdOf(key));
    for (const k of this.watchers(key)) out.add(this.chatIdOf(k));
    return [...out];
  }

  /** 这个聊天能不能操作这条会话（卡片按钮里带的会话键） */
  private controls(key: string, chatId: string | undefined): boolean {
    if (!chatId) return false;
    if (this.mine(key)) return this.chatIdOf(key) === chatId;
    return this.watchers(key).some((k) => this.chatIdOf(k) === chatId);
  }

  private webEntry(key: string): WebConvEntry | undefined {
    const info = hub.info(key);
    if (!info) return undefined;
    return {
      key,
      title: info.title || "（未命名）",
      agentLabel: hub.label(info.agent),
      cwd: info.cwd,
      busy: info.busy,
      activeAt: info.activeAt,
    };
  }

  /** 这个机器人聊过的飞书聊天 → 最近活跃时间 */
  private chatActivity(): Map<string, number> {
    const latest = new Map<string, number>();
    for (const c of listConversations()) {
      if (c.channel !== "feishu" || c.channelId !== this.cfg.id) continue;
      const chatId = this.chatIdOf(c.key);
      latest.set(chatId, Math.max(latest.get(chatId) ?? 0, c.activeAt));
    }
    return latest;
  }

  hasChat(chatId: string): boolean {
    return this.chatActivity().has(chatId);
  }

  /** 这个机器人聊过的飞书聊天（Web 上选「在哪继续」用），按最近活跃排 */
  async knownChats(): Promise<{ chatId: string; label: string; activeAt: number; attached?: string }[]> {
    const chats = [...this.chatActivity()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    return Promise.all(
      chats.map(async ([chatId, activeAt]) => {
        const info = await this.client.chatInfo(chatId);
        const label =
          info?.mode === "p2p" ? "私聊" : info?.name ? info.name : `聊天 ${chatId.slice(-6)}`;
        const attached = this.attachedWeb(this.keyOf(chatId));
        return { chatId, label, activeAt, ...(attached ? { attached } : {}) };
      }),
    );
  }

  /**
   * 把飞书会话 feishuKey 挂到 Web 会话 webKey 上，并在聊天里发一张「已接上」卡（带最近几句）。
   * 返回给人看的结果；挂不上时抛错。
   */
  async attachTo(feishuKey: string, webKey: string, operatorOpenId?: string): Promise<string> {
    const conv = getConversation(webKey);
    // 只能接上这个聊天的主人自己的 Web 会话（没主人的聊天：管理员能看的）
    if (!conv || conv.channel !== "web" || conv.hidden || !this.canSee(feishuKey, conv.owner)) throw new Error("这条 Web 会话已不存在");
    const chatId = this.chatIdOf(feishuKey);
    // 本聊天自己的会话也得有：之后 /detach 回来、侧栏里显示机器人都要它
    const allowed = this.allowedAgents();
    if (allowed.length > 0) {
      hub.ensure({
        key: feishuKey,
        channel: "feishu",
        channelId: this.cfg.id,
        defaultAgent: allowed.includes(this.cfg.defaultAgent) ? this.cfg.defaultAgent : allowed[0]!,
      });
    }
    const already = attachedTarget(feishuKey) === webKey;
    attach(feishuKey, webKey);
    if (operatorOpenId) this.operators.set(pairKey(webKey, chatId), operatorOpenId.trim().toLowerCase());
    const entry = this.webEntry(webKey)!;
    console.log(`${this.tag} ${feishuKey} 接上 Web 会话 ${webKey}`);
    // 最近几句：读历史可能要一会儿，读不到也不影响接上
    const history = await hub.history(webKey).catch(() => []);
    const recent = history
      .filter((m) => m.role !== "question" && m.text.trim())
      .slice(-4)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text }));
    await this.client.sendCard(
      chatId,
      attachedCard({ conv: entry, recent, sessionKey: feishuKey, ctx: this.cardCtx(feishuKey, chatId) }),
    );
    // 已经挂着的授权 / 提问：这个聊天也要能点
    for (const i of interactions.listPending(webKey)) {
      if (!this.cards.get(i.id)?.some((c) => c.chatId === chatId)) await this.showInteractionIn(i, chatId);
    }
    return already ? `已经接着「${entry.title}」了` : `已在飞书接上「${entry.title}」`;
  }

  /** 不再接着 Web 会话。返回给人看的结果 */
  detachFrom(feishuKey: string): string {
    const prev = detach(feishuKey);
    if (!prev) return "这个聊天没有接着 Web 会话，本来就在用自己的会话。";
    console.log(`${this.tag} ${feishuKey} 不再接着 Web 会话 ${prev}`);
    const title = getConversation(prev)?.title;
    return `已回到这个聊天自己的会话${title ? `，不再接着「${title}」` : ""}。之后发 \`/web\` 可以再接上。`;
  }

  /** 发 /web：列最近的 Web 会话 */
  private async sendWebList(feishuKey: string, chatId: string): Promise<void> {
    const current = this.attachedWeb(feishuKey);
    const convs = hub
      .list((c) => c.channel === "web" && !c.hidden && this.canSee(feishuKey, c.owner))
      .slice(0, 10)
      .map((c) => this.webEntry(c.key)!)
      .filter(Boolean);
    await this.client.sendCard(
      chatId,
      webListCard({
        convs,
        ...(current ? { current } : {}),
        sessionKey: feishuKey,
        ctx: this.cardCtx(feishuKey, chatId),
      }),
    );
  }

  /** 挂着的 Web 会话被删了 / 没了：自动退回来，告诉一声 */
  private dropStale(feishuKey: string): boolean {
    const target = attachedTarget(feishuKey);
    if (!target || this.attachedWeb(feishuKey)) return false;
    detach(feishuKey);
    void this.client.sendCard(
      this.chatIdOf(feishuKey),
      replyCard("之前接着的 Web 会话已经被删除，已回到这个聊天自己的会话。"),
    );
    return true;
  }

  isAuthorized(openId: string | undefined): boolean {
    if (!openId) return false;
    const id = openId.trim().toLowerCase();
    return this.cfg.allowFrom.includes(id) || isPaired(this.cfg.id, id);
  }

  // ---------- 生命周期 ----------

  start(): void {
    this.stopped = false;
    const onEvent = (env: EventEnvelope) => {
      // 流式片段飞书不画（回复走整段），先挡掉，免得每个片段都去翻一遍挂载表
      if (env.ev.type === "delta") return;
      if (env.ev.type === "meta") {
        for (const k of watchersOf(env.key, this.prefix)) this.dropStale(k);
        return;
      }
      for (const chatId of this.chatsOf(env.key)) this.render(env, chatId);
    };
    hub.on("event", onEvent);
    this.offs.push(() => hub.off("event", onEvent));

    const onCreated = (i: Interaction) => void this.showInteraction(i);
    const onUpdated = (i: Interaction) => this.cards.has(i.id) && void this.refreshInteraction(i);
    const onSettled = (i: Interaction) => this.cards.has(i.id) && void this.refreshInteraction(i);
    interactions.on("created", onCreated);
    interactions.on("updated", onUpdated);
    interactions.on("settled", onSettled);
    this.offs.push(() => {
      interactions.off("created", onCreated);
      interactions.off("updated", onUpdated);
      interactions.off("settled", onSettled);
    });

    this.connect();
    this.startWatchdog();
    // 等 agent 起来再同步（Claude 的原生命令要起进程读）；之后每 6 小时对一次账，新装的 skill 会跟上
    this.slash.request(15_000);
    this.slashTimer = setInterval(() => this.slash.request(0), 6 * 3600_000);
    this.slashTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.slash.stop();
    if (this.slashTimer) clearInterval(this.slashTimer);
    this.slashTimer = null;
    for (const off of this.offs.splice(0)) off();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    try {
      this.ws?.close({ force: true });
    } catch {
      // 已经断了
    }
    this.ws = null;
    this.setStatus("stopped");
  }

  private setStatus(state: string, error?: string): void {
    if (this.status.state === state && !error) return;
    this.status = { state, since: Date.now(), ...(error ? { error } : {}) };
  }

  private connect(): void {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        try {
          await this.handleMessage(data);
        } catch (err) {
          console.error(`${this.tag} 处理消息出错:`, err);
        }
      },
      "card.action.trigger": async (data: any) => {
        try {
          return await this.handleCardAction(data);
        } catch (err) {
          console.error(`${this.tag} 处理卡片回调出错:`, err);
          return { toast: { type: "error", content: "处理失败，请看 agent-loft 日志。" } };
        }
      },
    } as any);

    this.setStatus("connecting");
    this.ws = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: this.cfg.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
      // 不设握手超时的话，DNS / 代理卡住时握手会无限期挂着，连重连循环都进不去
      handshakeTimeoutMs: 30_000,
      onReady: () => {
        this.setStatus("connected");
        console.log(`${this.tag} 长连接已就绪`);
      },
      onReconnecting: () => this.setStatus("reconnecting"),
      onReconnected: () => this.setStatus("connected"),
      // SDK 放弃了：它不会再自己起来。以前是整个进程退出重来，现在只重建这一条连接
      onError: (err: Error) => {
        this.setStatus("failed", err.message);
        console.error(`${this.tag} 长连接彻底失败：${err.message}，30 秒后重建`);
        setTimeout(() => this.reconnect(), 30_000).unref?.();
      },
    } as any);
    this.ws.start({ eventDispatcher: dispatcher });
  }

  private reconnect(): void {
    if (this.stopped) return;
    try {
      this.ws?.close({ force: true });
    } catch {
      // ignore
    }
    this.ws = null;
    this.downSince = undefined;
    this.connect();
  }

  /**
   * 看门狗：长连接放弃时只发一个 onError 就停手，而 ping 定时器还在续期，
   * 进程活得好好的、消息却再也收不到。连续掉线超过阈值就重建连接。
   */
  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      const limit = config().feishu.watchdogMs;
      if (limit <= 0 || !this.ws) return;
      const state = (this.ws as any).getConnectionStatus?.()?.state as string | undefined;
      if (state === "connected") {
        this.downSince = undefined;
        if (this.status.state !== "connected") this.setStatus("connected");
        return;
      }
      this.downSince ??= Date.now();
      if (Date.now() - this.downSince >= limit) {
        console.error(`${this.tag} 长连接已断开 ${Math.round((Date.now() - this.downSince) / 60000)} 分钟，重建`);
        this.reconnect();
      }
    }, 30_000);
    this.watchdog.unref?.();
  }

  // ---------- 渲染 hub 事件 ----------

  private stream(key: string, chatId: string): TurnStream {
    const id = pairKey(key, chatId);
    let stream = this.streams.get(id);
    if (stream) return stream;
    stream = new TurnStream({
      sendCard: (card) => this.client.sendCard(chatId, card),
      updateCard: (messageId, card) => this.client.updateCard(messageId, card),
      renderProgress: (steps, done, footer) => progressCard({ steps, done, ...(footer ? { footer } : {}) }),
      sendReply: (text) => this.client.sendCard(chatId, replyCard(text)),
      onError: (err) => console.error(`${this.tag} 卡片更新失败:`, err),
    });
    this.streams.set(id, stream);
    return stream;
  }

  private render(env: EventEnvelope, chatId: string): void {
    const { key, ev } = env;
    switch (ev.type) {
      case "user": {
        // 别处（Web、别的飞书聊天）说的话，同步一句过来，不然这边看着没头没尾
        const o = ev.origin;
        const here = o.channel === "feishu" && o.channelId === this.cfg.id && (!o.chatId || o.chatId === chatId);
        // 定时任务的提示词不同步过来：每次运行都发一条，飞书里就全是它了。结果出来时再带上任务名
        if (!here && o.channel !== "task") {
          const files = ev.attachments.length ? `\n\n📎 ${ev.attachments.join("、")}` : "";
          const icon = o.channel === "web" ? "💻" : "💬";
          void this.client.sendCard(chatId, replyCard(`${icon} **${o.name ?? "Web"}**：${ev.text}${files}`));
        }
        return;
      }
      // 定时任务这一轮不画过程卡：跑完之前不知道要不要提醒，卡片一发出去飞书就响了
      case "step":
        if (!hub.currentTaskTurn(key)) this.stream(key, chatId).addStep(ev.text);
        return;
      case "text":
        if (!hub.currentTaskTurn(key)) this.stream(key, chatId).addText(ev.text);
        return;
      case "result": {
        const stream = this.stream(key, chatId);
        if (ev.silent) stream.finish("", ev.footer, true);
        else if (ev.task) stream.finish(`⏰ **${ev.task.title}**\n\n${ev.text}`, ev.footer);
        else stream.finish(ev.text, ev.footer);
        void stream.drain().then(() => this.clearTyping(key));
        return;
      }
      case "error": {
        const stream = this.stream(key, chatId);
        stream.finish("", "出错");
        void stream.drain().then(() => {
          this.clearTyping(key);
          void this.client.sendText(chatId, ev.message);
        });
        return;
      }
      case "notice":
        void this.client.sendCard(chatId, replyCard(ev.text));
        return;
      default:
        return;
    }
  }

  private cardCtx(key: string, chatId: string): CardCtx {
    const operator = this.operators.get(pairKey(key, chatId));
    return {
      ...(operator ? { operatorOpenId: operator } : {}),
      chatId,
      expiresAt: Date.now() + config().approvalTimeoutMs,
    };
  }

  private interactionCard(i: Interaction, chatId: string, ctx?: CardCtx) {
    if (i.settled) return settledCard(i);
    const c = ctx ?? this.cardCtx(i.convKey, chatId);
    if (i.spec.kind === "approval") return approvalCard(i, c);
    return questionCard(i, c, hub.label(getConversation(i.convKey)?.agent ?? ""));
  }

  private async showInteraction(i: Interaction): Promise<void> {
    for (const chatId of this.chatsOf(i.convKey)) await this.showInteractionIn(i, chatId);
  }

  private async showInteractionIn(i: Interaction, chatId: string): Promise<void> {
    const messageId = await this.client.sendCard(chatId, this.interactionCard(i, chatId));
    if (!messageId) return;
    const list = this.cards.get(i.id) ?? [];
    list.push({ chatId, messageId });
    this.cards.set(i.id, list);
    // 发卡的空当里可能已经在 Web 上处理掉了
    const latest = interactions.get(i.id);
    if (latest?.settled) await this.refreshInteraction(latest);
  }

  private async refreshInteraction(i: Interaction): Promise<void> {
    const list = this.cards.get(i.id);
    if (!list) return;
    if (i.settled) this.cards.delete(i.id);
    await Promise.all(list.map((c) => this.client.updateCard(c.messageId, this.interactionCard(i, c.chatId))));
  }


  // ---------- 正在输入 ----------

  private clearTyping(key: string): void {
    const typing = this.typing.get(key);
    if (!typing) return;
    this.typing.delete(key);
    void this.client.removeReaction(typing.messageId, typing.reactionId);
  }

  private async markTyping(key: string, messageId: string): Promise<void> {
    this.clearTyping(key);
    const reactionId = await this.client.addTypingReaction(messageId);
    if (reactionId) this.typing.set(key, { messageId, reactionId });
  }

  private enqueue(key: string, task: () => Promise<void>): void {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => console.error(`${this.tag} ${key} 处理消息失败:`, err))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  // ---------- 收消息 ----------

  private async handleMessage(data: any): Promise<void> {
    const message = data?.message;
    const openId: string | undefined = data?.sender?.sender_id?.open_id;
    const chatId: string | undefined = message?.chat_id;
    if (!message || !chatId) return;
    if (this.dedup.isDuplicate(message.message_id)) return;

    if (!this.isAuthorized(openId)) {
      await this.handleUnknownSender(openId, chatId);
      return;
    }

    // 群聊必须 @ 机器人才响应，私聊不用
    const isGroup = message.chat_type === "group";
    const mentioned = Array.isArray(message.mentions) && message.mentions.length > 0;
    if (isGroup && !mentioned) return;

    const parsed = parseMessage(message);
    if (!parsed) {
      await this.client.sendText(
        chatId,
        `暂不支持${unsupportedTypeLabel(message.message_type)}消息。目前支持文字、富文本、图片、文件、语音和视频。`,
      );
      return;
    }
    const text = parsed.text.replace(/@_user_\d+/g, "").trim();
    const { attachments } = parsed;
    if (!text && attachments.length === 0) return;

    const allowed = this.allowedAgents();
    if (allowed.length === 0) {
      await this.client.sendText(chatId, "这个机器人没有可用的 agent，请到 agent-loft 设置里给它勾选至少一个。");
      return;
    }

    const ownKey = this.keyOf(chatId, message.thread_id);
    const conv = hub.ensure({
      key: ownKey,
      channel: "feishu",
      channelId: this.cfg.id,
      defaultAgent: allowed.includes(this.cfg.defaultAgent) ? this.cfg.defaultAgent : allowed[0]!,
    });
    // 配置改过（这个机器人不再能用当前 agent）：退回默认
    if (!allowed.includes(conv.agent)) {
      updateConversation(ownKey, { agent: allowed.includes(this.cfg.defaultAgent) ? this.cfg.defaultAgent : allowed[0]! });
    }
    const operator = openId!.trim().toLowerCase();
    this.operators.set(pairKey(ownKey, chatId), operator);

    // 私聊的主人跟着发消息的人的绑定走：绑定了就是他的个人会话（用他的记忆），解绑了就回到管理员的地盘。
    // 群聊不动：群里不止一个人
    const p2p = message.chat_type === "p2p";
    if (p2p && hub.reassignOwner(ownKey, linkedUser(this.cfg.id, operator)?.id)) {
      const owner = this.viewerOf(ownKey);
      console.log(`${this.tag} 私聊 ${ownKey} 的主人变为 ${owner?.name ?? "（无，归管理员）"}`);
    }

    const feishuCmd = attachments.length > 0 ? null : feishuCommandOf(text);
    if (feishuCmd) {
      await this.runFeishuCommand(feishuCmd, ownKey, chatId, { openId: operator, p2p });
      return;
    }

    // 挂着 Web 会话：说的话、命令都送进那条会话
    this.dropStale(ownKey);
    const key = this.attachedWeb(ownKey) ?? ownKey;
    this.operators.set(pairKey(key, chatId), operator);

    const command = attachments.length > 0 ? ({ kind: "chat", text } as const) : parseCommand(text);
    if (command.kind !== "chat") {
      try {
        const reply = await hub.command(key, command, {
          allowedAgents: this.allowedFor(key),
          by: "飞书命令",
          channel: "feishu",
          // 别人的 agent 会话、挂着的请求，这个聊天里都碰不到
          ...this.commandScope(ownKey),
        });
        await this.renderReply(key, chatId, reply);
      } catch (err) {
        await this.client.sendText(chatId, `出错了：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    void this.markTyping(key, message.message_id);
    const origin = { channel: "feishu", channelId: this.cfg.id, name: "飞书", chatId };
    // 收到消息这一刻的代次：下载附件期间点了 /stop、或者 /cd /new 换了会话，这条就作废
    const gen = hub.generation(key);
    this.enqueue(key, async () => {
      if (attachments.length === 0) {
        hub.send(key, { text: command.text, attachments: [] }, origin, gen);
        return;
      }
      const { saved, failed } = await this.download(key, message.message_id, attachments);
      if (failed.length > 0) {
        await this.client.sendText(
          chatId,
          ["有附件没能下载下来：", ...failed.map((f) => `- ${f.ref.name ?? KIND_LABEL[f.ref.kind]}：${f.reason}`)].join("\n"),
        );
      }
      if (saved.length === 0 && !command.text) {
        this.clearTyping(key);
        return;
      }
      hub.send(key, { text: command.text, attachments: saved }, origin, gen);
    });
  }

  private async download(
    key: string,
    messageId: string,
    refs: AttachmentRef[],
  ): Promise<{ saved: SavedAttachment[]; failed: { ref: AttachmentRef; reason: string }[] }> {
    const saved: SavedAttachment[] = [];
    const failed: { ref: AttachmentRef; reason: string }[] = [];
    for (const ref of refs) {
      const tmp = path.join(os.tmpdir(), `aim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        await this.client.downloadResource(messageId, ref.key, ref.kind === "image" ? "image" : "file", tmp);
        saved.push(
          adoptFile({
            key,
            tmpPath: tmp,
            kind: ref.kind,
            ...(ref.name ? { name: ref.name } : {}),
            ...(ref.durationMs ? { durationMs: ref.durationMs } : {}),
          }),
        );
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        failed.push({ ref, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { saved, failed };
  }

  /** /web、/detach、/bind：只认飞书会话自己的键，不管现在挂没挂着 */
  private async runFeishuCommand(
    cmd: FeishuCommand,
    ownKey: string,
    chatId: string,
    sender?: { openId: string; p2p: boolean },
  ): Promise<void> {
    try {
      if (cmd.kind === "web") await this.sendWebList(ownKey, chatId);
      else if (cmd.kind === "detach") await this.client.sendCard(chatId, replyCard(this.detachFrom(ownKey)));
      else await this.client.sendCard(chatId, replyCard(this.bind(cmd.code, ownKey, sender)));
    } catch (err) {
      await this.client.sendText(chatId, `出错了：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** /bind 绑定码：把发消息的人的飞书账号绑到生成这个码的 agent-loft 用户上 */
  private bind(code: string, ownKey: string, sender: { openId: string; p2p: boolean } | undefined): string {
    if (!sender) return "请直接在聊天里发 `/bind 绑定码`。";
    // 群里发的码别人也看得见，而且群聊本来就不归个人：只在私聊里绑
    if (!sender.p2p) return "请在和我的私聊里发 `/bind 绑定码`（群里别人也看得到绑定码）。绑定码已经露出来了的话，到 Web 上重新生成一个。";
    const user = redeemLinkCode(code, this.cfg.id, sender.openId);
    hub.reassignOwner(ownKey, user.id);
    console.log(`${this.tag} ${sender.openId} 绑定到用户 ${user.name}`);
    return [
      `已绑定到 agent-loft 用户 **${user.name}**。`,
      "",
      "从现在起这个私聊是你的个人会话：用你的记忆，`/sessions` 只列你的会话，`/web` 只能接上你自己的 Web 会话。群聊不受影响。",
      "",
      "在 Web 的「设置 → 账号」里可以随时解除绑定。",
    ].join("\n");
  }

  private async renderReply(key: string, chatId: string, reply: CommandReply): Promise<void> {
    const ctx = this.cardCtx(key, chatId);
    switch (reply.type) {
      case "text":
        await this.client.sendCard(chatId, replyCard(reply.text));
        return;
      case "sessions":
        await this.client.sendCard(
          chatId,
          sessionListCard({
            agentLabel: hub.label(reply.agent),
            sessions: reply.sessions,
            ...(reply.current ? { current: reply.current } : {}),
            cwd: reply.cwd,
            allDirs: reply.allDirs,
            fellBack: reply.fellBack,
            sessionKey: key,
            ctx,
          }),
        );
        return;
      case "models":
        await this.client.sendCard(
          chatId,
          modelPickerCard({
            agentLabel: hub.label(reply.agent),
            models: reply.models,
            ...(reply.current ? { current: reply.current } : {}),
            ...(reply.currentEffort ? { currentEffort: reply.currentEffort } : {}),
            effortSupported: reply.effortSupported,
            sessionKey: key,
            ctx,
          }),
        );
        return;
      case "agents":
        await this.client.sendCard(chatId, agentPickerCard({ ...reply, sessionKey: key, ctx }));
        return;
      case "commands":
        await this.client.sendCard(
          chatId,
          commandListCard({ agentLabel: hub.label(reply.agent), commands: reply.commands, sessionKey: key, ctx }),
        );
        return;
      case "none":
        return;
    }
  }

  /** 陌生人：不处理内容，只发一个配对码。同一个人在码有效期内不会被反复回复。 */
  private async handleUnknownSender(openId: string | undefined, chatId: string): Promise<void> {
    if (!openId) return;
    const outcome = requestPairing(this.cfg.id, { userId: openId, chatId });
    if (outcome.kind === "rejected_full") {
      console.warn(`${this.tag} 待批准配对已达上限，忽略 ${openId}`);
      return;
    }
    if (outcome.kind !== "created") return;
    const { code } = outcome.request;
    console.log(`${this.tag} 新的接入请求 ${openId}，配对码 ${code}（Web 设置页批准，或运行 agent-loft pair approve ${code}）`);
    await this.client.sendText(
      chatId,
      `你还没有被授权使用这台机器。\n\n配对码：${code}\n\n请让机器主人在 agent-loft 的 Web 设置页里批准，或在终端运行：\nagent-loft pair approve ${code}\n\n批准后我会通知你。`,
    );
  }

  /** 配对被批准后通知等待中的人 */
  notifyApproved(chatId: string): void {
    void this.client.sendText(chatId, "已获授权，现在可以直接跟我说话了。");
  }

  // ---------- 卡片回调 ----------

  /**
   * 响应体里带 card 是让卡片「点完就变样」的唯一可靠途径：飞书客户端会拿它重渲这条
   * 消息，没有 card 就把本地旧卡片渲染回去（闪一下又变回可点）。另外必须 3 秒内响应，
   * 耗时的活儿一律先应答再后台做。
   */
  private async handleCardAction(data: any): Promise<CardResponse> {
    const operatorOpenId: string | undefined = data?.operator?.open_id;
    const chatId: string | undefined = data?.context?.open_chat_id ?? data?.context?.chat_id;
    const dedupKey =
      data?.token ??
      data?.event_id ??
      `${operatorOpenId}:${data?.context?.open_message_id}:${JSON.stringify(data?.action?.value)}`;
    if (this.dedup.isDuplicate(`card:${dedupKey}`)) return {};

    const decoded = decodeEnvelope({
      value: data?.action?.value,
      operatorOpenId,
      chatId,
      isAllowed: (id) => this.isAuthorized(id),
    });
    if (!decoded.ok) return { toast: { type: "error", content: DECODE_FAILURE_TEXT[decoded.reason] } };
    const envelope: CardEnvelope = decoded.envelope;
    const by = "已在飞书处理";
    const stale = (i: Interaction | undefined): CardResponse => ({
      toast: {
        type: "error",
        content: i?.settled
          ? `这个请求已经处理过了（${i.settled.by}）。`
          : "这个请求已失效（超时、已处理，或 agent-loft 重启过），请重新发一次你的需求。",
      },
      ...(i?.settled ? { card: { type: "raw", data: settledCard(i) } } : {}),
    });

    switch (envelope.a) {
      case "approval": {
        const settled = interactions.decide(envelope.r, envelope.d, by);
        if (!settled) return stale(interactions.get(envelope.r));
        this.cards.delete(settled.id);
        return {
          toast: { type: "success", content: envelope.d === "deny" ? "已拒绝" : "已允许" },
          card: { type: "raw", data: settledCard(settled) },
        };
      }
      case "ask": {
        const state = interactions.select(envelope.r, envelope.q, envelope.o, envelope.v === 1, by);
        if (!state) return stale(interactions.get(envelope.r));
        if (state.submitted) {
          this.cards.delete(state.interaction.id);
          return { toast: { type: "success", content: "已回答" }, card: { type: "raw", data: settledCard(state.interaction) } };
        }
        return {
          toast: { type: "info", content: "已勾选" },
          card: { type: "raw", data: this.interactionCard(state.interaction, chatId ?? "") },
        };
      }
      case "ask-submit": {
        const result = interactions.submit(envelope.r, by);
        if (!result) return stale(interactions.get(envelope.r));
        if ("missing" in result) return { toast: { type: "warning", content: "还有问题没选，选完再提交。" } };
        this.cards.delete(result.id);
        return { toast: { type: "success", content: "已回答" }, card: { type: "raw", data: settledCard(result) } };
      }
      case "ask-skip": {
        const result = interactions.skip(envelope.r, "已在飞书跳过，agent 会按合理的默认继续");
        if (!result) return stale(interactions.get(envelope.r));
        this.cards.delete(result.id);
        return { toast: { type: "info", content: "已跳过" }, card: { type: "raw", data: settledCard(result) } };
      }
      case "resume":
        return this.background(envelope.k, chatId, "正在恢复该会话…", () => hub.resume(envelope.k, envelope.s, envelope.c));
      case "model":
        return this.background(envelope.k, chatId, `正在切换到 ${envelope.m}`, () => hub.setModel(envelope.k, envelope.m));
      case "effort":
        return this.background(envelope.k, chatId, `思考程度设为 ${envelope.f}`, () => hub.setEffort(envelope.k, envelope.f));
      case "agent":
        return this.background(envelope.k, chatId, `正在切换到 ${hub.label(envelope.g)}`, () =>
          hub.setAgent(envelope.k, envelope.g, this.allowedFor(envelope.k)),
        );
      case "cmd":
        return this.runCardCommand(envelope.k, chatId, operatorOpenId, `/${envelope.c}`);
      case "attach": {
        // k 必须是这个聊天自己的会话：卡片被转发到别处点，挂的也只能是那个聊天
        if (!this.mine(envelope.k) || this.chatIdOf(envelope.k) !== chatId) {
          return { toast: { type: "error", content: DECODE_FAILURE_TEXT.wrong_conversation } };
        }
        const conv = getConversation(envelope.w);
        if (!conv || conv.channel !== "web" || conv.hidden) {
          return { toast: { type: "error", content: "这条 Web 会话已不存在，请重新发 /web。" } };
        }
        void this.attachTo(envelope.k, envelope.w, operatorOpenId).catch((err) =>
          this.client.sendText(chatId!, `出错了：${err instanceof Error ? err.message : String(err)}`),
        );
        return { toast: { type: "success", content: `正在接上「${conv.title ?? "Web 会话"}」` } };
      }
      case "detach": {
        if (!this.mine(envelope.k) || this.chatIdOf(envelope.k) !== chatId) {
          return { toast: { type: "error", content: DECODE_FAILURE_TEXT.wrong_conversation } };
        }
        const text = this.detachFrom(envelope.k);
        void this.client.sendCard(chatId!, replyCard(text));
        return { toast: { type: "success", content: "已回到本聊天" } };
      }
    }
  }

  /**
   * 命令表上点「执行」：等同于用户自己发了这条命令。
   * agent-loft 的命令就地执行并回卡片；agent 原生命令（skills 等）当一条消息发给 agent。
   */
  private runCardCommand(key: string, chatId: string | undefined, operatorOpenId: string | undefined, text: string): CardResponse {
    if (!this.controls(key, chatId) || !getConversation(key)) {
      return { toast: { type: "error", content: "这条会话已不存在，请重新发一次「/」。" } };
    }
    const chat = chatId!;
    // /web、/detach 作用在这个聊天自己的会话上：命令表可能是接着 Web 会话时发的，k 是 Web 会话
    const ownKey = this.mine(key) ? key : this.keyOf(chat);
    const feishuCmd = feishuCommandOf(text);
    if (feishuCmd) {
      void this.runFeishuCommand(feishuCmd, ownKey, chat);
      return { toast: { type: "info", content: `正在执行 ${text}` } };
    }
    if (operatorOpenId) this.operators.set(pairKey(key, chat), operatorOpenId.trim().toLowerCase());
    const command = parseCommand(text);
    if (command.kind === "chat") {
      const origin = { channel: "feishu", channelId: this.cfg.id, name: "飞书", chatId: chat };
      const gen = hub.generation(key);
      this.enqueue(key, async () => hub.send(key, { text, attachments: [] }, origin, gen));
      return { toast: { type: "success", content: `已发送 ${text}` } };
    }
    void hub
      .command(key, command, { allowedAgents: this.allowedFor(key), by: "飞书命令", channel: "feishu", ...this.commandScope(ownKey) })
      .then((reply) => this.renderReply(key, chat, reply))
      .catch((err) => this.client.sendText(chat, `出错了：${err instanceof Error ? err.message : String(err)}`));
    return { toast: { type: "info", content: `正在执行 ${text}` } };
  }

  /** 卡片回调里耗时的操作：先应答，做完在点的那个聊天里回一句。 */
  private background(
    key: string,
    chatId: string | undefined,
    toast: string,
    task: () => Promise<string>,
  ): CardResponse {
    if (!this.controls(key, chatId) || !getConversation(key)) {
      return { toast: { type: "error", content: "这条会话已不存在，或者这个聊天已经不接着它了。" } };
    }
    const chat = chatId!;
    void task()
      .then((text) => this.client.sendCard(chat, replyCard(text)))
      .catch((err) => this.client.sendText(chat, `出错了：${err instanceof Error ? err.message : String(err)}`));
    return { toast: { type: "info", content: toast } };
  }
}
