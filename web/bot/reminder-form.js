import { api, h, requestId } from "./client.js";
import { closePanel, formPanel, note, panelError, run } from "./panel.js";

function localDateTime(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function timeLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "选择时间";
  const today = new Date(), tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === today.toDateString() ? "今天" : date.toDateString() === tomorrow.toDateString() ? "明天" :
    new Intl.DateTimeFormat("zh-CN", { year: date.getFullYear() === today.getFullYear() ? undefined : "numeric", month: "long", day: "numeric" }).format(date);
  return day + " " + value.slice(11, 16);
}

export function newReminder(threadId, shared, onSaved) {
  const now = new Date(), tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const text = h("input", { id: "reminder-text", type: "text", required: true, maxlength: 500, "aria-label": "内容", placeholder: "提醒我做什么？" });
  const time = h("input", { id: "reminder-time", type: "datetime-local", required: true, "aria-label": "时间", min: localDateTime(now), value: localDateTime(tomorrow) });
  const readableTime = h("span", { class: "date-value", "aria-hidden": "true" }, timeLabel(time.value));
  const date = h("label", { class: "date-row" }, "时间", h("span", { class: "date-control" }, readableTime, time));
  time.addEventListener("click", event => {
    if (event.detail && time.showPicker) {
      try { time.showPicker(); } catch { /* Keep the built-in date editor when the browser owns the picker. */ }
    }
  });
  const save = h("button", { type: "submit", disabled: true }, "添加");
  const form = h("form", { class: "reminder-form" }, text, date,
    note(shared ? "仅你可见，提醒会保存在你与这个助手的私聊中。" : "此提醒仅你可见。"));
  const stillHere = formPanel("新提醒", form, save);
  const id = requestId();
  form.oninput = () => {
    readableTime.textContent = timeLabel(time.value);
    save.disabled = !text.value.trim() || !time.validity.valid;
  };
  form.onsubmit = event => {
    event.preventDefault();
    const dueAt = new Date(time.value).getTime();
    if (!(dueAt > Date.now())) { panelError("请选择将来的时间。"); return; }
    if (!text.value.trim()) return;
    run(save, async () => {
      const { threadId: savedIn } = await api("/api/bot-reminders", "POST", {
        kind: "create", threadId, requestId: id, text: text.value.trim(), dueAt,
      });
      if (stillHere()) closePanel();
      onSaved(savedIn);
    });
  };
}
