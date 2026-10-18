// 一轮对话的输出编排：
//   过程（思考 / 工具调用）→ 实时刷新的过程卡
//   最终回复            → 普通消息，可复制可引用，不套卡片
//
// 全程串行执行。曾经踩过的坑：过程卡的 send 还没 await 完成，收尾就到了，
// 于是多发一张卡，而先前那张永远停在中间态。
export type TurnStreamDeps = {
  sendCard: (card: unknown) => Promise<string | undefined>;
  updateCard: (messageId: string, card: unknown) => Promise<boolean>;
  renderProgress: (steps: string[], done: boolean, footer?: string) => unknown;
  /** 发送最终回复（普通文本消息） */
  sendReply: (text: string) => Promise<unknown>;
  onError?: (err: unknown) => void;
};

export type TurnStreamOptions = {
  minIntervalMs?: number;
  maxEdits?: number;
  now?: () => number;
};

export class TurnStream {
  private steps: string[] = [];
  private text = "";
  private messageId: string | undefined;
  private edits = 0;
  private lastEdit = 0;
  private chain: Promise<void> = Promise.resolve();

  private readonly minIntervalMs: number;
  private readonly maxEdits: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: TurnStreamDeps,
    options: TurnStreamOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.maxEdits = options.maxEdits ?? 15;
    this.now = options.now ?? (() => Date.now());
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => this.deps.onError?.(err));
  }

  /** 一条过程信息（思考片段 / 工具调用）。 */
  addStep(step: string): void {
    this.steps.push(step);
    this.enqueue(async () => {
      const now = this.now();
      if (now - this.lastEdit < this.minIntervalMs || this.edits >= this.maxEdits) return;
      this.lastEdit = now;
      const card = this.deps.renderProgress(this.steps, false);
      if (!this.messageId) {
        this.messageId = await this.deps.sendCard(card);
        return;
      }
      this.edits += 1;
      await this.deps.updateCard(this.messageId, card);
    });
  }

  /** 回复正文片段，累积起来备用。 */
  addText(text: string): void {
    this.text += text;
  }

  /**
   * 收尾：过程卡定格为完成态，然后把最终回复作为普通消息发出去。
   * 整轮没有过程时不会留下任何卡片 —— 简单问答就该只有一条回复。
   */
  finish(finalText: string, footer?: string): void {
    this.enqueue(async () => {
      if (this.messageId) {
        await this.deps.updateCard(
          this.messageId,
          this.deps.renderProgress(this.steps, true, footer),
        );
      }
      const reply = finalText.trim() || this.text.trim();
      if (reply) await this.deps.sendReply(reply);
      this.reset();
    });
  }

  private reset(): void {
    this.steps = [];
    this.text = "";
    this.messageId = undefined;
    this.edits = 0;
    this.lastEdit = 0;
  }

  async drain(): Promise<void> {
    await this.chain;
  }
}
