import { h, icon, isTouch, toast } from "../lib/dom.js";
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
  insertCard(ix);
  notifyIfHidden(ix);
}

/** 把卡片放进对话：插在这一轮中间的话，之前的输出先封口，之后的输出接在卡片下面，顺序才对 */
export function insertCard(ix) {
  if (S.items.some((i) => i.type === "ix" && i.id === ix.id)) return;
  if (S.turnAi && !S.turnAi.done) {
    S.turnAi.done = true;
    S.turnAi.segment = true;
    updateItem(S.turnAi);
    S.turnAi = null;
  }
  addItem({ type: "ix", id: ix.id, ix });
}

/** 已处理：「已回答 · 已在 Web 处理」。从会话记录里还原的不知道是谁处理的，只写结果 */
const settledText = (s) => [SETTLE_LABEL[s.settlement] ?? s.settlement, s.by].filter(Boolean).join(" · ");

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
        ? h("div", { class: "ix-meta" }, settledText(settled))
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
  // 提问：选项是一排按钮，第一个（Claude 会把推荐的放第一个）是黑色主按钮，⌘↵ 直接选它
  const needsSubmit = spec.questions.some((q) => q.multiSelect);
  const shortcut = settled ? null : primaryAction(ix);
  return h(
    "div",
    { class: `ix-card ask${settled ? " settled" : ""}` },
    settled
      ? null
      : h("button", { class: "icon-btn ix-close", title: "跳过，让 Claude 按它的判断继续", onclick: () => ixOp(ix.id, "skip") }, icon("x")),
    spec.questions.map((q, qi) => {
      const picked = ix.selections[qi] ?? [];
      const free = ix.freeText?.[qi];
      // 单选还没答：第一个是主按钮；答过了就只有选中的那个是黑的
      const lead = !settled && !q.multiSelect && picked.length === 0 && !free ? 0 : -1;
      return h(
        "div",
        { class: "ix-q" },
        q.header ? h("div", { class: "q-header" }, q.header) : null,
        h("div", { class: "q-text" }, q.question, q.multiSelect ? h("span", { class: "q-hint" }, "（可多选）") : null),
        h(
          "div",
          // 带说明的选项竖着排，一行一个，说明才放得下
          { class: `q-opts${q.options.some((o) => o.description) ? " stack" : ""}` },
          q.options.map((opt, oi) => {
            const on = picked.includes(oi);
            return h(
              "button",
              {
                class: `opt${on ? " on" : oi === lead ? " primary" : ""}`,
                disabled: !!settled,
                onclick: () => ixOp(ix.id, "select", { q: qi, o: oi, v: q.multiSelect ? !on : true }),
              },
              h("span", { class: "opt-label" }, q.multiSelect && on ? "✓ " : "", opt.label, shortcut?.q === qi && shortcut.o === oi ? kbdHint() : null),
              opt.description ? h("small", {}, opt.description) : null,
            );
          }),
        ),
        free ? h("div", { class: "ix-meta" }, `→ ${free}`) : null,
      );
    }),
    settled
      ? h("div", { class: "ix-meta" }, settledText(settled))
      : h(
          "div",
          { class: "ix-buttons" },
          needsSubmit ? h("button", { class: "opt primary", onclick: () => ixOp(ix.id, "submit") }, h("span", { class: "opt-label" }, "提交", shortcut?.submit ? kbdHint() : null)) : null,
          h("span", { class: "ix-meta" }, "都不合适？直接在下面输入框里回答"),
        ),
  );
}

// ---------- ⌘↵ / Ctrl+↵：选主按钮 ----------

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function kbdHint() {
  if (isTouch) return null;
  return h("span", { class: "kbd-hint" }, h("kbd", {}, isMac ? "⌘" : "Ctrl"), h("kbd", {}, "↵"));
}

/** 这张卡按 ⌘↵ 做什么：有多选就是提交，否则选第一个还没答的问题的第一个选项 */
function primaryAction(ix) {
  const qs = ix.spec.questions;
  if (qs.some((q) => q.multiSelect)) return { submit: true };
  const qi = qs.findIndex((_, i) => !(ix.selections[i]?.length) && !ix.freeText?.[i]);
  return qi < 0 ? null : { q: qi, o: 0 };
}

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.isComposing) return;
    // 正在输入框里打字：那是要发消息（直接在输入框里回答也算作答），不抢
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable) && el.value?.trim()) return;
    // 当前对话里最新的一张没处理的提问卡
    const item = S.items.findLast((i) => i.type === "ix" && i.ix.spec.kind === "question" && !i.ix.settled);
    const act = item && primaryAction(item.ix);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    if (act.submit) void ixOp(item.ix.id, "submit");
    else void ixOp(item.ix.id, "select", { q: act.q, o: act.o, v: true });
  },
  true,
);
