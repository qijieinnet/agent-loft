import { h, toast } from "../lib/dom.js";
import { renderMarkdown } from "../lib/markdown.js";
import { desktop, isAdmin, S } from "../state.js";
import { WS } from "../lib/ws.js";
import { convTitle, scheduleSidebar } from "./sidebar.js";
import { addItem, updateItem } from "./messages.js";

// ---------- 交互（授权 / 提问） ----------

export function upsertInteraction(ix) {
  // 只进不退：本地已经知道它处理完了，晚到的旧快照（还写着待处理）不能把它复活
  const known = S.pending.get(ix.id);
  if (known?.settled && !ix.settled) return;
  S.pending.set(ix.id, ix);
  if (ix.settled) setTimeout(() => S.pending.get(ix.id)?.settled && S.pending.delete(ix.id), 60000);
  scheduleSidebar();
  if (ix.convKey !== S.current) {
    if (!ix.settled && document.visibilityState === "visible") {
      const c = S.convs.get(ix.convKey);
      toast(`「${convTitle(c)}」在等你处理：${ix.spec.title}`, 4000);
    }
    return;
  }
  const existing = S.items.find((i) => i.type === "ix" && i.id === ix.id);
  if (existing) {
    existing.ix = ix;
    updateItem(existing);
    return;
  }
  if (ix.settled) return;
  // 卡片插在这一轮中间：之前的输出先封口，之后的输出接在卡片下面，顺序才对
  if (S.turnAi && !S.turnAi.done) {
    S.turnAi.done = true;
    S.turnAi.segment = true;
    updateItem(S.turnAi);
    S.turnAi = null;
  }
  addItem({ type: "ix", id: ix.id, ix });
  notifyIfHidden(ix);
}

function notifyIfHidden(ix) {
  // 桌面端由服务端的 notice 统一弹，这里再弹就重复了
  if (desktop || document.visibilityState === "visible" || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try {
      new Notification("Agent Loft 需要你处理", { body: ix.spec.title, tag: ix.id });
    } catch {
      // 某些浏览器只允许在 SW 里发
    }
  }
}

async function ixOp(id, op, extra = {}) {
  try {
    await WS.request({ t: "ix", id, op, ...extra });
  } catch (err) {
    toast(err.message);
  }
}

const SETTLE_LABEL = {
  "allow-once": "已允许（本次）",
  "allow-always": "已允许（总是）",
  "allow-session": "已允许（本会话全部放行）",
  deny: "已拒绝",
  timeout: "已超时，按拒绝处理",
  cancelled: "已取消",
  answered: "已回答",
  skipped: "已跳过",
  gone: "已处理",
};

export function renderInteraction(item) {
  const ix = item.ix;
  const spec = ix.spec;
  const settled = ix.settled;
  if (spec.kind === "approval") {
    return h(
      "div",
      { class: `ix-card${settled ? " settled" : ""}` },
      h("div", { class: "ix-title" }, settled ? "" : "⚠️", spec.title),
      h("div", { class: "ix-detail" }, renderMarkdown(spec.detail)),
      settled
        ? h("div", { class: "ix-meta" }, `${SETTLE_LABEL[settled.settlement] ?? settled.settlement} · ${settled.by}`)
        : h(
            "div",
            { class: "ix-buttons" },
            spec.allowSession
              ? h("button", { class: "btn accent", onclick: () => ixOp(ix.id, "decide", { decision: "allow-session" }) }, "本会话全部允许")
              : null,
            h("button", { class: `btn${spec.allowSession ? "" : " accent"}`, onclick: () => ixOp(ix.id, "decide", { decision: "allow-once" }) }, "允许一次"),
            // 会落盘、对所有人生效的「总是允许」只给管理员
            spec.alwaysLabel && (!spec.alwaysGlobal || isAdmin())
              ? h("button", { class: "btn", onclick: () => ixOp(ix.id, "decide", { decision: "allow-always" }) }, spec.alwaysLabel)
              : null,
            h("button", { class: "btn danger", onclick: () => ixOp(ix.id, "decide", { decision: "deny" }) }, "拒绝"),
          ),
    );
  }
  // 提问
  const needsSubmit = spec.questions.some((q) => q.multiSelect);
  return h(
    "div",
    { class: `ix-card ask${settled ? " settled" : ""}` },
    h("div", { class: "ix-title" }, settled ? "" : "❓", spec.title),
    spec.questions.map((q, qi) => {
      const picked = ix.selections[qi] ?? [];
      const free = ix.freeText?.[qi];
      return h(
        "div",
        { class: "ix-q" },
        h("div", { class: "q-head" }, h("b", {}, q.header), q.question, q.multiSelect ? "（可多选）" : ""),
        q.options.map((opt, oi) => {
          const on = picked.includes(oi);
          return h(
            "button",
            {
              class: `opt${on ? " on" : ""}`,
              disabled: !!settled,
              onclick: () => ixOp(ix.id, "select", { q: qi, o: oi, v: q.multiSelect ? !on : true }),
            },
            `${on ? "✓ " : ""}${opt.label}`,
            opt.description ? h("small", {}, opt.description) : null,
          );
        }),
        free ? h("div", { class: "ix-meta" }, `→ ${free}`) : null,
      );
    }),
    settled
      ? h("div", { class: "ix-meta" }, `${SETTLE_LABEL[settled.settlement] ?? settled.settlement} · ${settled.by}`)
      : h(
          "div",
          { class: "ix-buttons" },
          needsSubmit ? h("button", { class: "btn accent", onclick: () => ixOp(ix.id, "submit") }, "提交") : null,
          h("button", { class: "btn", onclick: () => ixOp(ix.id, "skip") }, "跳过"),
          h("span", { class: "ix-meta" }, "都不合适？直接在下面输入框里回答"),
        ),
  );
}
