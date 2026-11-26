import { api, field, h, requestId } from "./client.js";
import { closePanel, formPanel, note, panelError, run } from "./panel.js";

function localDateTime(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function newReminder(threadId, shared, onSaved) {
  const now = new Date(), tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const text = h("input", { id: "reminder-text", type: "text", required: true, maxlength: 500, placeholder: "提醒我做什么？" });
  const time = h("input", { id: "reminder-time", type: "datetime-local", required: true, min: localDateTime(now), value: localDateTime(tomorrow) });
  const save = h("button", { type: "submit", disabled: true }, "添加");
  const form = h("form", { class: "sheet-form" }, field("内容", text), field("时间", time),
    note(shared ? "仅你可见，提醒会保存在你与这个助手的私聊中。" : "此提醒仅你可见。"));
  const stillHere = formPanel("新提醒", form, save);
  const id = requestId();
  form.oninput = () => { save.disabled = !text.value.trim() || !time.validity.valid; };
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
