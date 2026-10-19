// 交互中枢：agent 发起的每一次审批 / 提问，都在这里变成一条「待处理」和一个 Promise。
//
// 和旧桥接器的区别在于它不认识任何渠道：飞书、Web 都只是订阅者。同一条请求可以
// 同时显示在飞书卡片和 Web 页面上，哪边先处理算哪边，其余订阅者收到 settled 事件
// 后把自己那份改成「已处理」。
//
// 继承下来的几条硬规矩：
//   - 超时一律按「没放行」收束，绝不能是放行；
//   - 选项用「设成」语义而不是「切换」，渠道重投回调时结果不变；
//   - 丢弃 / 中断会话时必须取消它挂着的所有请求，否则阻塞的那一轮永远走不完。
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { InteractionOutcome, InteractionSpec, QuestionSpec, Settlement } from "./types.js";

export type Interaction = {
  id: string;
  convKey: string;
  spec: InteractionSpec;
  createdAt: number;
  expiresAt: number;
  /** 仅提问：与 questions 等长，每问已选中的选项下标 */
  selections: number[][];
  /** 仅提问：自由作答，按问题下标存 */
  freeText: Record<number, string>;
  settled?: { settlement: Settlement; by: string; at: number };
  /** 发起它的会话进程编号：只有这个进程还活着时，普通消息才能拿来作答 */
  owner?: number;
};

type Entry = Interaction & {
  resolve: (outcome: InteractionOutcome) => void;
  timer: NodeJS.Timeout;
};

export type InteractionEvents = {
  created: [Interaction];
  updated: [Interaction];
  settled: [Interaction];
};

class InteractionCenter extends EventEmitter<InteractionEvents> {
  private pending = new Map<string, Entry>();
  /** 已收束的留一小段时间，供渠道回调时给出准确的「已由 xx 处理」提示 */
  private recent = new Map<string, Interaction>();

  create(convKey: string, spec: InteractionSpec, timeoutMs: number, owner?: number): Promise<InteractionOutcome> {
    const id = `req_${crypto.randomBytes(4).toString("hex")}`;
    let resolve!: (outcome: InteractionOutcome) => void;
    const promise = new Promise<InteractionOutcome>((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => this.settle(id, "timeout", "无人响应"), timeoutMs);
    timer.unref?.();
    const now = Date.now();
    const entry: Entry = {
      id,
      convKey,
      spec,
      createdAt: now,
      expiresAt: now + timeoutMs,
      selections: spec.kind === "question" ? spec.questions.map(() => []) : [],
      freeText: {},
      ...(owner !== undefined ? { owner } : {}),
      resolve,
      timer,
    };
    this.pending.set(id, entry);
    this.emit("created", publicView(entry));
    return promise;
  }

  get(id: string): Interaction | undefined {
    const entry = this.pending.get(id);
    return entry ? publicView(entry) : this.recent.get(id);
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** 某会话当前挂着的全部请求（Web 端打开会话时要补画出来）。 */
  listPending(convKey?: string): Interaction[] {
    return [...this.pending.values()]
      .filter((e) => !convKey || e.convKey === convKey)
      .map(publicView);
  }

  /** 审批决定。返回 undefined 表示请求已不在（超时、已处理、或进程重启过）。 */
  decide(id: string, decision: Settlement, by: string): Interaction | undefined {
    const entry = this.pending.get(id);
    if (!entry || entry.spec.kind !== "approval") return undefined;
    return this.settle(id, decision, by);
  }

  /** 把某个选项设成选中 / 未选中。全单选且都答完时自动收束。 */
  select(
    id: string,
    questionIndex: number,
    optionIndex: number,
    selected: boolean,
    by: string,
  ): { interaction: Interaction; submitted: boolean } | undefined {
    const entry = this.pending.get(id);
    if (!entry || entry.spec.kind !== "question") return undefined;
    const spec = entry.spec.questions[questionIndex];
    const picked = entry.selections[questionIndex];
    if (!spec || !picked || !spec.options[optionIndex]) return undefined;

    if (spec.multiSelect) {
      const at = picked.indexOf(optionIndex);
      if (selected && at < 0) picked.push(optionIndex);
      if (!selected && at >= 0) picked.splice(at, 1);
    } else {
      entry.selections[questionIndex] = selected ? [optionIndex] : [];
      delete entry.freeText[questionIndex];
    }

    const allSingle = entry.spec.questions.every((q) => !q.multiSelect);
    if (allSingle && unansweredCount(entry) === 0) {
      return { interaction: this.settle(id, "answered", by)!, submitted: true };
    }
    this.emit("updated", publicView(entry));
    return { interaction: publicView(entry), submitted: false };
  }

  /** 点「提交」。还有没答的问题时返回 { missing }。 */
  submit(id: string, by: string): Interaction | { missing: number } | undefined {
    const entry = this.pending.get(id);
    if (!entry || entry.spec.kind !== "question") return undefined;
    const missing = unansweredCount(entry);
    if (missing > 0) return { missing };
    return this.settle(id, "answered", by);
  }

  skip(id: string, by: string): Interaction | undefined {
    const entry = this.pending.get(id);
    if (!entry || entry.spec.kind !== "question") return undefined;
    entry.selections = entry.selections.map(() => []);
    entry.freeText = {};
    return this.settle(id, "skipped", by);
  }

  /**
   * 用一条普通消息回答提问 —— 等价于官方 UI 里的「Other」自由输入。
   * 写进第一个还没作答的问题；返回 true 表示这条消息已被消费，不该再送进会话。
   */
  answerWithText(id: string, text: string, by: string): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.spec.kind !== "question") return false;
    const index = entry.selections.findIndex((picked, i) => picked.length === 0 && !entry.freeText[i]);
    if (index < 0) {
      // 都答过了（多选还没点提交）：这条消息不是作答，交给会话照常处理
      return false;
    }
    entry.freeText[index] = text;
    // 还有没答的问题：留着让人继续答（下一条消息或点按钮），不能提前交卷
    if (unansweredCount(entry) > 0) {
      this.emit("updated", publicView(entry));
      return true;
    }
    this.settle(id, "answered", by);
    return true;
  }

  /** 这条会话里挂着的提问（正常同时只会有一个）。 */
  findQuestion(convKey: string): Interaction | undefined {
    let oldest: Entry | undefined;
    for (const entry of this.pending.values()) {
      if (entry.spec.kind !== "question" || entry.convKey !== convKey) continue;
      if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
    }
    return oldest ? publicView(oldest) : undefined;
  }

  /** 取消某会话上所有挂着的请求。中断、切目录、开新会话时必须调用。 */
  cancelAll(convKey: string, note: string): Interaction[] {
    const out: Interaction[] = [];
    for (const entry of [...this.pending.values()]) {
      if (entry.convKey !== convKey) continue;
      const settled = this.settle(entry.id, "cancelled", note);
      if (settled) out.push(settled);
    }
    return out;
  }

  private settle(id: string, settlement: Settlement, by: string): Interaction | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.settled = { settlement, by, at: Date.now() };
    const view = publicView(entry);
    this.recent.set(id, view);
    if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!);
    entry.resolve({ settlement, answers: answersOf(entry) });
    this.emit("settled", view);
    return view;
  }
}

function publicView(entry: Entry | Interaction): Interaction {
  const { id, convKey, spec, createdAt, expiresAt, selections, freeText, settled, owner } = entry;
  return {
    id,
    convKey,
    spec,
    createdAt,
    expiresAt,
    selections: selections.map((s) => [...s]),
    freeText: { ...freeText },
    ...(settled ? { settled } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

export function unansweredCount(entry: Interaction): number {
  return entry.selections.filter((picked, i) => picked.length === 0 && !entry.freeText[i]).length;
}

/** 问题 id → 答案。没作答的问题不出现在表里 —— 不替人编答案。 */
export function answersOf(entry: Interaction): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  if (entry.spec.kind !== "question") return answers;
  if (entry.settled && entry.settled.settlement !== "answered") return answers;
  entry.spec.questions.forEach((spec: QuestionSpec, i) => {
    const free = entry.freeText[i];
    if (free) {
      answers[spec.id] = [free];
      return;
    }
    const labels = (entry.selections[i] ?? [])
      .map((o) => spec.options[o]?.label)
      .filter((l): l is string => !!l);
    if (labels.length > 0) answers[spec.id] = labels;
  });
  return answers;
}

/** 给人看的：问题原文 → 答案文字。 */
export function answerTextOf(entry: Interaction): Record<string, string> {
  const shown: Record<string, string> = {};
  if (entry.spec.kind !== "question") return shown;
  const answers = answersOf(entry);
  for (const spec of entry.spec.questions) {
    const picked = answers[spec.id];
    if (picked) shown[spec.question] = picked.join(", ");
  }
  return shown;
}

export const SETTLEMENT_LABEL: Record<Settlement, string> = {
  "allow-once": "已允许（本次）",
  "allow-always": "已允许",
  deny: "已拒绝",
  timeout: "已超时，按拒绝处理",
  cancelled: "已取消",
  answered: "已回答",
  skipped: "已跳过",
};

export const interactions = new InteractionCenter();
