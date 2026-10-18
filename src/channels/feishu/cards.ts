// 卡片构造，全部使用 JSON 2.0。
//
// 2.0 与 1.0 的三处硬差异（踩过坑，别改回去）：
//   1. 没有 `tag: "action"` 容器，按钮直接作为 element；横排要用 column_set 包 column
//   2. 回调数据不在按钮的 value 上，而是 behaviors: [{ type: "callback", value }]
//   3. 没有 `tag: "note"`，小字提示只能并进 markdown
import { createEnvelope, type CardCtx, type EnvelopeAction } from "./envelope.js";
import { answerTextOf, SETTLEMENT_LABEL, type Interaction } from "../../core/interactions.js";
import type { ModelInfo, SessionSummary } from "../../core/types.js";

function button(
  label: string,
  action: EnvelopeAction,
  ctx: CardCtx,
  type: "default" | "primary" | "danger" = "default",
) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value: createEnvelope(action, ctx) }],
  };
}

function buttonRow(buttons: ReturnType<typeof button>[]) {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [b] })),
  };
}

/** 截断过长的文本，避免卡片超限；保留头尾更利于判断。 */
export function clip(text: string, max = 1500): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.2));
  return `${head}\n\n… (省略 ${text.length - head.length - tail.length} 字) …\n\n${tail}`;
}

// update_multi 必须显式为 true：更新卡片接口要求前后 config 都声明它
const baseConfig = { width_mode: "fill", update_multi: true };

function card(elements: unknown[], header?: { title: string; template: string }) {
  return {
    schema: "2.0",
    config: baseConfig,
    ...(header ? { header: { title: { tag: "plain_text", content: header.title }, template: header.template } } : {}),
    body: { elements },
  };
}

// ---------- 交互 ----------

/** 审批卡：三档决策。请求 id 印在正文里，卡片失效时还能手打 /approve 兜底。 */
export function approvalCard(interaction: Interaction, ctx: CardCtx) {
  const spec = interaction.spec;
  if (spec.kind !== "approval") throw new Error("不是审批");
  const id = interaction.id;
  const buttons = [
    button("允许一次", { a: "approval", r: id, d: "allow-once" }, ctx, "primary"),
    ...(spec.alwaysLabel ? [button(spec.alwaysLabel, { a: "approval", r: id, d: "allow-always" }, ctx)] : []),
    button("拒绝", { a: "approval", r: id, d: "deny" }, ctx, "danger"),
  ];
  return card(
    [
      { tag: "markdown", content: clip(spec.detail) },
      { tag: "hr" },
      buttonRow(buttons),
      { tag: "markdown", content: `请求 \`${id}\`　按钮失效时可发送：\`/approve ${id} allow-once\`` },
    ],
    { title: spec.title, template: "orange" },
  );
}

/** 提问卡：有状态，每点一下就用最新的勾选重渲。全单选且都选完自动收束，多选要点「提交」。 */
export function questionCard(interaction: Interaction, ctx: CardCtx, agentLabel: string) {
  const spec = interaction.spec;
  if (spec.kind !== "question") throw new Error("不是提问");
  const id = interaction.id;
  const needsSubmit = spec.questions.some((q) => q.multiSelect);
  const elements: unknown[] = [];
  spec.questions.forEach((q, qi) => {
    if (qi > 0) elements.push({ tag: "hr" });
    const picked = interaction.selections[qi] ?? [];
    elements.push({ tag: "markdown", content: `**${q.header}**　${q.question}${q.multiSelect ? "（可多选）" : ""}` });
    if (q.options.length > 0) {
      elements.push(
        buttonRow(
          q.options.map((opt, oi) => {
            const on = picked.includes(oi);
            const next: 0 | 1 = q.multiSelect && on ? 0 : 1;
            return button(
              `${on ? "✅ " : ""}${clip(opt.label, 30)}`,
              { a: "ask", r: id, q: qi, o: oi, v: next },
              ctx,
              on ? "primary" : "default",
            );
          }),
        ),
      );
      const notes = q.options
        .filter((opt) => opt.description)
        .map((opt) => `**${opt.label}** — ${opt.description}`)
        .join("\n");
      if (notes) elements.push({ tag: "markdown", content: clip(notes, 800) });
    } else {
      elements.push({ tag: "markdown", content: "_这一问需要你直接回一句话。_" });
    }
  });
  elements.push({ tag: "hr" });
  elements.push(
    buttonRow([
      ...(needsSubmit ? [button("提交", { a: "ask-submit", r: id }, ctx, "primary")] : []),
      button("跳过", { a: "ask-skip", r: id }, ctx),
    ]),
  );
  elements.push({ tag: "markdown", content: "选项都不合适？**直接发一条消息**就当作你的回答。" });
  return card(elements, { title: spec.title || `${agentLabel} 想确认一下`, template: "violet" });
}

/** 收束后的卡：原地替换，避免重复点击和状态歧义。 */
export function settledCard(interaction: Interaction) {
  const settled = interaction.settled;
  const settlement = settled?.settlement ?? "cancelled";
  const by = settled?.by ?? "";
  if (interaction.spec.kind === "approval") {
    const ok = settlement === "allow-once" || settlement === "allow-always";
    const label =
      settlement === "allow-always"
        ? `已允许（${interaction.spec.alwaysLabel ?? "后续同类自动放行"}）`
        : SETTLEMENT_LABEL[settlement];
    return card([{ tag: "markdown", content: `请求 \`${interaction.id}\`　${by}` }], {
      title: `${label}：${interaction.spec.title.replace(/^需要授权：/, "")}`,
      template: ok ? "green" : "grey",
    });
  }
  const answers = answerTextOf(interaction);
  const answered = interaction.spec.questions.filter((q) => answers[q.question]);
  const empty = answered.length === 0;
  const lines = answered.map((q) => `**${q.header}**　${q.question}\n→ ${answers[q.question]}`);
  return card(
    [
      { tag: "markdown", content: clip(empty ? `${SETTLEMENT_LABEL[settlement]}。${by ? `（${by}）` : ""}` : lines.join("\n\n"), 2000) },
      ...(!empty && by ? [{ tag: "markdown", content: by }] : []),
    ],
    { title: empty ? "未作答" : "已回答", template: empty ? "grey" : "green" },
  );
}

// ---------- 过程与回复 ----------

/** 过程卡：进行中展开，完成后折叠成一行摘要。 */
export function progressCard(params: { steps: string[]; done?: boolean; footer?: string }) {
  const body = clip(params.steps.length > 0 ? params.steps.join("\n") : "…", 2000);
  if (!params.done) return card([{ tag: "markdown", content: body }]);
  const summary = `已完成 ${params.steps.length} 步${params.footer ? `　${params.footer}` : ""}`;
  return card([
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "plain_text", content: summary },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      },
      padding: "8px 8px 8px 8px",
      elements: [{ tag: "markdown", content: body }],
    },
  ]);
}

/** 回复卡：飞书纯文本不渲染 markdown，所以回复必须走卡片。刻意做到最简。 */
export function replyCard(text: string) {
  return card([{ tag: "markdown", content: clip(text, 4000) }]);
}

// ---------- 命令结果 ----------

export function modelPickerCard(params: {
  agentLabel: string;
  models: ModelInfo[];
  current?: string;
  currentEffort?: string;
  effortSupported: boolean;
  sessionKey: string;
  ctx: CardCtx;
}) {
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: `${params.agentLabel}　当前：**${params.current ?? "默认模型"}**${
        params.currentEffort ? `　思考 **${params.currentEffort}**` : ""
      }`,
    },
    { tag: "hr" },
    buttonRow(
      params.models
        .slice(0, 12)
        .map((m) =>
          button(
            `${m.label}${m.id === params.current ? " ✅" : ""}`,
            { a: "model", m: m.id, k: params.sessionKey },
            params.ctx,
          ),
        ),
    ),
  ];
  const efforts =
    params.models.find((m) => m.id === params.current)?.efforts ??
    params.models.find((m) => m.efforts?.length)?.efforts ??
    [];
  if (params.effortSupported && efforts.length > 0) {
    elements.push({ tag: "hr" }, { tag: "markdown", content: "**思考程度**" });
    elements.push(
      buttonRow(
        efforts
          .slice(0, 8)
          .map((e) =>
            button(`${e}${e === params.currentEffort ? " ✅" : ""}`, { a: "effort", e, k: params.sessionKey }, params.ctx),
          ),
      ),
    );
  }
  return card(elements, { title: "切换模型", template: "blue" });
}

export function agentPickerCard(params: {
  agents: { id: string; label: string }[];
  current: string;
  sessionKey: string;
  ctx: CardCtx;
}) {
  return card(
    [
      { tag: "markdown", content: "每个 agent 的会话各自保留，切回来能接着聊。" },
      buttonRow(
        params.agents.map((a) =>
          button(
            `${a.label}${a.id === params.current ? " ✅" : ""}`,
            { a: "agent", g: a.id, k: params.sessionKey },
            params.ctx,
            a.id === params.current ? "primary" : "default",
          ),
        ),
      ),
    ],
    { title: "切换 Agent", template: "blue" },
  );
}

export function sessionListCard(params: {
  agentLabel: string;
  sessions: SessionSummary[];
  current?: string;
  cwd: string;
  allDirs: boolean;
  fellBack: boolean;
  sessionKey: string;
  ctx: CardCtx;
}) {
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: `${params.agentLabel}　${
        params.allDirs
          ? params.fellBack
            ? `\`${params.cwd}\` 下没有历史会话，已列出**所有目录**的最近会话`
            : "所有目录的最近会话"
          : `目录 \`${params.cwd}\``
      }`,
    },
  ];
  params.sessions.forEach((entry, index) => {
    const isCurrent = entry.id === params.current;
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content:
        `**${index + 1}. ${entry.title}**${isCurrent ? "　✅ 当前" : ""}\n` +
        (params.allDirs && entry.cwd ? `\`${entry.cwd}\`\n` : "") +
        `\`${entry.id}\`　${relativeTime(entry.updatedAt)}`,
    });
    if (!isCurrent) {
      elements.push(
        buttonRow([
          button(
            "恢复这条",
            { a: "resume", s: entry.id, k: params.sessionKey, ...(entry.cwd ? { c: entry.cwd } : {}) },
            params.ctx,
          ),
        ]),
      );
    }
  });
  return card(elements, { title: "历史会话", template: "blue" });
}

export function relativeTime(ts: number, now = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}
