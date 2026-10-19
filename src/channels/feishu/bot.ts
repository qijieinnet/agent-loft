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
import { getConversation, updateConversation } from "../../core/store.js";
import { adoptFile, KIND_LABEL } from "../../core/uploads.js";
import type { SavedAttachment } from "../../core/types.js";
import { FeishuClient } from "./client.js";
import { SlashSync } from "./slash-sync.js";
import type { CommandEntry } from "../../core/command-catalog.js";
import {
  agentPickerCard,
  approvalCard,
  commandListCard,
  modelPickerCard,
  progressCard,
  questionCard,
  replyCard,
  sessionListCard,
  settledCard,
} from "./cards.js";
import { decodeEnvelope, DECODE_FAILURE_TEXT, type CardCtx, type CardEnvelope } from "./envelope.js";
import { parseMessage, unsupportedTypeLabel, type AttachmentRef } from "./message.js";
import { TurnStream } from "./turn-stream.js";

type CardResponse = {
  toast?: { type: "info" | "success" | "error" | "warning"; content: string };
  card?: { type: "raw"; data: unknown };
};

export type BotStatus = { state: string; since: number; error?: string };

export class FeishuBot {
  readonly client: FeishuClient;
  private ws: Lark.WSClient | null = null;
  private dedup = new Dedup();
  private streams = new Map<string, TurnStream>();
  private typing = new Map<string, { messageId: string; reactionId: string }>();
  /** 交互 id → 飞书卡片的 message_id */
  private cards = new Map<string, string>();
  /** 会话键 → 最后一个在飞书上说话的人。卡片默认只让他点 */
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
      out.push(...(await hub.commandCatalog(agent, { allowedAgents: this.cfg.agents })));
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

  isAuthorized(openId: string | undefined): boolean {
    if (!openId) return false;
    const id = openId.trim().toLowerCase();
    return this.cfg.allowFrom.includes(id) || isPaired(this.cfg.id, id);
  }

  // ---------- 生命周期 ----------

  start(): void {
    this.stopped = false;
    const onEvent = (env: EventEnvelope) => {
      if (this.mine(env.key)) this.render(env);
    };
    hub.on("event", onEvent);
    this.offs.push(() => hub.off("event", onEvent));

    const onCreated = (i: Interaction) => this.mine(i.convKey) && void this.showInteraction(i);
    const onUpdated = (i: Interaction) => this.mine(i.convKey) && void this.refreshInteraction(i);
    const onSettled = (i: Interaction) => this.mine(i.convKey) && void this.refreshInteraction(i);
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
          return { toast: { type: "error", content: "处理失败，请看 im-agent 日志。" } };
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

  private stream(key: string): TurnStream {
    let stream = this.streams.get(key);
    if (stream) return stream;
    const chatId = this.chatIdOf(key);
    stream = new TurnStream({
      sendCard: (card) => this.client.sendCard(chatId, card),
      updateCard: (messageId, card) => this.client.updateCard(messageId, card),
      renderProgress: (steps, done, footer) => progressCard({ steps, done, ...(footer ? { footer } : {}) }),
      sendReply: (text) => this.client.sendCard(chatId, replyCard(text)),
      onError: (err) => console.error(`${this.tag} 卡片更新失败:`, err),
    });
    this.streams.set(key, stream);
    return stream;
  }

  private render(env: EventEnvelope): void {
    const { key, ev } = env;
    const chatId = this.chatIdOf(key);
    switch (ev.type) {
      case "user":
        // 别的渠道（Web）说的话，同步一句过来，不然飞书这边看着没头没尾
        if (ev.origin.channel !== "feishu" || ev.origin.channelId !== this.cfg.id) {
          const files = ev.attachments.length ? `\n\n📎 ${ev.attachments.join("、")}` : "";
          void this.client.sendCard(chatId, replyCard(`💻 **${ev.origin.name ?? "Web"}**：${ev.text}${files}`));
        }
        return;
      case "step":
        this.stream(key).addStep(ev.text);
        return;
      case "text":
        this.stream(key).addText(ev.text);
        return;
      case "result": {
        const stream = this.stream(key);
        stream.finish(ev.text, ev.footer);
        void stream.drain().then(() => this.clearTyping(key));
        return;
      }
      case "error": {
        const stream = this.stream(key);
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

  private cardCtx(key: string): CardCtx {
    const operator = this.operators.get(key);
    return {
      ...(operator ? { operatorOpenId: operator } : {}),
      chatId: this.chatIdOf(key),
      expiresAt: Date.now() + config().approvalTimeoutMs,
    };
  }

  private interactionCard(i: Interaction, ctx?: CardCtx) {
    if (i.settled) return settledCard(i);
    const c = ctx ?? this.cardCtx(i.convKey);
    if (i.spec.kind === "approval") return approvalCard(i, c);
    return questionCard(i, c, hub.label(getConversation(i.convKey)?.agent ?? ""));
  }

  private async showInteraction(i: Interaction): Promise<void> {
    const messageId = await this.client.sendCard(this.chatIdOf(i.convKey), this.interactionCard(i));
    if (!messageId) return;
    this.cards.set(i.id, messageId);
    // 发卡的空当里可能已经在 Web 上处理掉了
    const latest = interactions.get(i.id);
    if (latest?.settled) await this.refreshInteraction(latest);
  }

  private async refreshInteraction(i: Interaction): Promise<void> {
    const messageId = this.cards.get(i.id);
    if (!messageId) return;
    if (i.settled) this.cards.delete(i.id);
    await this.client.updateCard(messageId, this.interactionCard(i));
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
      await this.client.sendText(chatId, "这个机器人没有可用的 agent，请到 im-agent 设置里给它勾选至少一个。");
      return;
    }

    const key = this.keyOf(chatId, message.thread_id);
    const conv = hub.ensure({
      key,
      channel: "feishu",
      channelId: this.cfg.id,
      defaultAgent: allowed.includes(this.cfg.defaultAgent) ? this.cfg.defaultAgent : allowed[0]!,
    });
    // 配置改过（这个机器人不再能用当前 agent）：退回默认
    if (!allowed.includes(conv.agent)) {
      updateConversation(key, { agent: allowed.includes(this.cfg.defaultAgent) ? this.cfg.defaultAgent : allowed[0]! });
    }
    this.operators.set(key, openId!.trim().toLowerCase());

    const command = attachments.length > 0 ? ({ kind: "chat", text } as const) : parseCommand(text);
    if (command.kind !== "chat") {
      try {
        const reply = await hub.command(key, command, { allowedAgents: allowed, by: "飞书命令" });
        await this.renderReply(key, reply);
      } catch (err) {
        await this.client.sendText(chatId, `出错了：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    void this.markTyping(key, message.message_id);
    const origin = { channel: "feishu", channelId: this.cfg.id, name: "飞书" };
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

  private async renderReply(key: string, reply: CommandReply): Promise<void> {
    const chatId = this.chatIdOf(key);
    const ctx = this.cardCtx(key);
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
    console.log(`${this.tag} 新的接入请求 ${openId}，配对码 ${code}（Web 设置页批准，或运行 im-agent pair approve ${code}）`);
    await this.client.sendText(
      chatId,
      `你还没有被授权使用这台机器。\n\n配对码：${code}\n\n请让机器主人在 im-agent 的 Web 设置页里批准，或在终端运行：\nim-agent pair approve ${code}\n\n批准后我会通知你。`,
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
          : "这个请求已失效（超时、已处理，或 im-agent 重启过），请重新发一次你的需求。",
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
          card: { type: "raw", data: this.interactionCard(state.interaction) },
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
        this.background(envelope.k, () => hub.resume(envelope.k, envelope.s, envelope.c));
        return { toast: { type: "info", content: "正在恢复该会话…" } };
      case "model":
        this.background(envelope.k, () => hub.setModel(envelope.k, envelope.m));
        return { toast: { type: "success", content: `正在切换到 ${envelope.m}` } };
      case "effort":
        this.background(envelope.k, () => hub.setEffort(envelope.k, envelope.f));
        return { toast: { type: "success", content: `思考程度设为 ${envelope.f}` } };
      case "agent":
        this.background(envelope.k, () => hub.setAgent(envelope.k, envelope.g, this.allowedAgents()));
        return { toast: { type: "success", content: `正在切换到 ${hub.label(envelope.g)}` } };
      case "cmd":
        return this.runCardCommand(envelope.k, `/${envelope.c}`);
    }
  }

  /**
   * 命令表上点「执行」：等同于用户自己发了这条命令。
   * im-agent 的命令就地执行并回卡片；agent 原生命令（skills 等）当一条消息发给 agent。
   */
  private runCardCommand(key: string, text: string): CardResponse {
    if (!this.mine(key) || !getConversation(key)) {
      return { toast: { type: "error", content: "这条会话已不存在，请重新发一次「/」。" } };
    }
    const command = parseCommand(text);
    if (command.kind === "chat") {
      const origin = { channel: "feishu", channelId: this.cfg.id, name: "飞书" };
      const gen = hub.generation(key);
      this.enqueue(key, async () => hub.send(key, { text, attachments: [] }, origin, gen));
      return { toast: { type: "success", content: `已发送 ${text}` } };
    }
    const chatId = this.chatIdOf(key);
    void hub
      .command(key, command, { allowedAgents: this.allowedAgents(), by: "飞书命令" })
      .then((reply) => this.renderReply(key, reply))
      .catch((err) => this.client.sendText(chatId, `出错了：${err instanceof Error ? err.message : String(err)}`));
    return { toast: { type: "info", content: `正在执行 ${text}` } };
  }

  /** 卡片回调里耗时的操作：先应答，做完在会话里回一句。 */
  private background(key: string, task: () => Promise<string>): void {
    if (!this.mine(key) || !getConversation(key)) return;
    const chatId = this.chatIdOf(key);
    void task()
      .then((text) => this.client.sendCard(chatId, replyCard(text)))
      .catch((err) => this.client.sendText(chatId, `出错了：${err instanceof Error ? err.message : String(err)}`));
  }
}
