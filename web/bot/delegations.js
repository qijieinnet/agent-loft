import { api, button, field, h, icon, requestId } from "./client.js";
import { action, closePanel, currentPanel, note, panel, run } from "./panel.js";

const stages = { proposed: "等你确认", queued: "正在排队", running: "正在处理", done: "已完成", failed: "未完成", cancelled: "已取消" };
export const delegationPath = (thread) => "/api/bots/threads/" + encodeURIComponent(thread) + "/delegations";
const audience = (ctx) => ctx.shared ? "结果会回到共享对话，当前成员都能查看。" : "结果会回到这段私聊，仅你可见。";

export function delegationCard(ctx, item) {
  const control = button(h("span", { class: "record-summary" }, h("small", {}, stages[item.status]),
    h("strong", {}, item.targetName), h("span", {}, item.task)), () => showDelegation(ctx, item), "handoff-card");
  control.prepend(h("span", { class: "record-icon" }, icon("handoff")));
  control.append(h("span", { class: "disclose", "aria-hidden": "true" }, "›"));
  return control;
}
export function showDelegation(ctx, item) {
  const edited = item.canConfirm && h("textarea", { id: "delegate-preview", required: true, maxlength: 4000, rows: 4 }, item.task);
  async function transition(kind) {
    const active = currentPanel();
    if (kind === "confirm" && !edited.value.trim()) {
      edited.focus();
      throw new Error("请写下要发送的内容。");
    }
    const { delegation } = await api(ctx.path + "/" + encodeURIComponent(item.id) + "/" + kind, "POST", {
      attempt: item.attempt, ...(kind === "confirm" ? { task: edited.value.trim() } : {}),
    });
    if (!ctx.live()) return;
    ctx.update(delegation);
    if (active()) {
      if (kind === "confirm" || kind === "retry" || kind === "cancel") closePanel();
      else showDelegation(ctx, delegation);
    }
  }
  const canSend = item.canConfirm || item.canRetry;
  panel(canSend ? "确认交给 " + item.targetName + "？" : item.targetName + " · " + stages[item.status],
    h("div", { class: "route" }, icon("handoff"), h("span", {}, ctx.bot.name), h("span", { "aria-hidden": "true" }, "→"), h("strong", {}, item.targetName)),
    edited ? field("交给对方的完整内容", edited) :
      h("article", { class: "record" }, h("small", {}, "交给对方的完整内容"), h("p", {}, item.task)),
    note(audience(ctx)), item.error && note(item.error),
    canSend && action(item.canRetry ? "确认重新发送" : "确认发送", () => transition(item.canRetry ? "retry" : "confirm"), "primary"),
    item.resultMessageId && button("查看对话中的结果", () => {
      closePanel();
      ctx.focus(item.resultMessageId);
    }, "primary"),
    item.canCancel && action("取消这次协作", () => transition("cancel"), "secondary"),
    (item.status === "queued" || item.status === "running") && action("刷新进度", async () => {
      const valid = currentPanel();
      const { delegations } = await api(ctx.path);
      const fresh = delegations.find((d) => d.id === item.id);
      if (fresh && valid() && ctx.live()) {
        ctx.update(fresh);
        showDelegation(ctx, fresh);
      }
    }, "secondary"));
}
export async function openDelegations(ctx) {
  const valid = currentPanel();
  const { targets, delegations } = await api(ctx.path);
  if (!ctx.live() || !valid()) return;
  function create() {
    const target = h("select", { id: "delegate-target", required: true }, ...targets.map((b) => h("option", { value: b.id }, b.name)));
    const task = h("textarea", { id: "delegate-task", required: true, rows: 4, maxlength: 4000, autofocus: true,
      placeholder: "写下希望对方完成的事，带上必要信息。" });
    const save = h("button", { type: "submit", class: "primary" }, "预览发送内容");
    let id = requestId();
    const form = h("form", { class: "sheet-form", oninput: () => { id = requestId(); }, onsubmit: (event) => {
      event.preventDefault();
      if (!task.value.trim()) { task.focus(); return; }
      const active = currentPanel();
      run(save, async () => {
        const { delegation } = await api(ctx.path, "POST", { targetId: target.value, task: task.value.trim(), requestId: id });
        if (!ctx.live()) return;
        ctx.update(delegation);
        if (active()) showDelegation(ctx, delegation);
      });
    } }, field("交给哪个 Bot", target), field("任务内容", task), note("对方只会收到你确认的任务文字。"), save);
    panel("请其他 Bot 帮忙", form);
  }
  if (targets.length && !delegations.length) { create(); return; }
  panel("Bot 协作", !ctx.enabled ? note("这个 Bot 已关闭协作。已完成的结果可以在对话中查看。") : targets.length ? button("发起协作", create, "primary") :
    note("还没有可协作的 Bot。你可以再建一个 Bot，并在它的资料中开启协作。"),
    ctx.enabled && !targets.length && button("新建私人 Bot", ctx.createBot, "secondary"),
    ...delegations.map((item) => delegationCard(ctx, item)));
}
