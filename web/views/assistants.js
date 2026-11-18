import { api } from "../lib/api.js";
import { fill, h, toast } from "../lib/dom.js";
import { confirmDialog, modal } from "../lib/overlay.js";
import { expertChoices, expertIcon } from "./experts.js";
import { openConversation } from "./messages.js";
import { closeSide } from "./sidebar.js";
import { openBotEvents } from "./bot-events.js";
import { editTaskById, openTaskForm, runStatusText } from "./tasks.js";

/** 每次打开读取本账号的联系人。多设备改变任务时刷新正在查看的列表。 */
export function openAssistants() {
  closeSide();
  const body = h("div", { class: "modal-body assistant-list", "aria-live": "polite" });
  const controller = new AbortController();
  const dismiss = modal({ title: "bot", body, beforeClose: () => controller.abort() });
  const close = () => { controller.abort(); dismiss(); };
  let generation = 0;

  const open = (key) => { close(); void openConversation(key); };
  const button = (label, action, disabled = false) => h("button", { class: "btn", disabled, onclick: action }, label);

  async function remove(assistant) {
    if (!await confirmDialog({ title: "移除这个 bot？", message: "将删除这个 bot 的事件监听和事件记录。已有定时任务继续运行，聊天记录会保留。重新添加这个专家可以接着聊。", confirmText: "移除" })) return;
    try {
      await api("/api/assistants", { method: "DELETE", body: { key: assistant.key } });
      await load();
    } catch (err) { toast(err.message); }
  }

  function taskRow(t) {
    const state = t.pending ? "待你处理" : t.last ? runStatusText(t.last.status) : "尚未运行";
    const next = t.enabled && t.nextRunAt ? "下次 " + new Date(t.nextRunAt).toLocaleString() : "已停用";
    return h("div", { class: "assistant-task" },
      h("div", { class: "grow" }, h("strong", {}, t.title), h("small", {}, state + " · " + next),
        t.last?.preview || t.last?.note ? h("small", {}, t.last.preview || t.last.note) : null),
      t.resultKey ? button("查看对话", () => open(t.resultKey)) : null,
      button("编辑", () => { close(); void editTaskById(t.id); }));
  }

  function contact(a) {
    const label = a.expert.missing ? a.title || "已失效的 bot" : a.expert.name;
    return h("section", { class: "assistant-card" },
      h("div", { class: "assistant-row" }, expertIcon({ ...a.expert, engine: a.agent }),
        h("strong", { class: "grow" }, label),
        button(a.pending ? "待你处理 · " + a.pending : a.unavailable ? "查看历史" : "打开对话", () => open(a.key)),
        button("移除", () => void remove(a))),
      a.unavailable || a.busy ? h("small", {}, a.unavailable || "正在回复") : null,
      h("div", { class: "assistant-row" }, h("span", { class: "grow" }, "定时任务（" + a.tasks.length + "）"),
        button("事件监听", () => { close(); openBotEvents({ key: a.key }); }),
        button("新建任务", () => {
          close();
          openTaskForm(null, { assistantKey: a.key, expert: a.expert.id, cwd: a.cwd, target: { kind: "conv", key: a.key }, convKey: a.key, convTitle: label, convExpert: { ...a.expert, engine: a.agent }, convCwd: a.cwd, convPermission: a.permission, convPermissionMax: a.permissionMax });
        }, !!a.unavailable)),
      a.tasks.map(taskRow));
  }

  async function load() {
    const current = ++generation;
    try {
      const { assistants } = await api("/api/assistants");
      if (current !== generation || !body.isConnected) return;
      const choices = expertChoices().filter((e) => !assistants.some((a) => a.expert.id === e.id));
      const select = h("select", { "aria-label": "选择 bot 专家" }, choices.map((e) => h("option", { value: e.id }, e.name)));
      if (!choices.length) select.append(h("option", {}, "没有更多可添加的专家"));
      const add = button("添加 bot", async () => {
        add.disabled = true;
        try {
          await api("/api/assistants", { method: "POST", body: { expert: select.value } });
          await load();
        } catch (err) { toast(err.message); add.disabled = false; }
      }, !choices.length);
      fill(body, h("div", { class: "assistant-row" }, select, add),
        assistants.length ? assistants.map(contact) : h("p", {}, "选一个专家作为 bot，即可在这里找到它的对话和定时任务。"),
        h("small", {}, "在已绑定账号的飞书私聊发送 /bot，可接着和 bot 聊。"));
    } catch (err) {
      if (body.isConnected && current === generation) fill(body, h("p", {}, err.message), button("重试", load));
    }
  }

  for (const event of ["aim:tasks", "aim:experts"]) document.addEventListener(event, load, { signal: controller.signal });
  void load();
}
