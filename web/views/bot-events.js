import { api } from "../lib/api.js";
import { fill, h, toast } from "../lib/dom.js";
import { confirmDialog, modal } from "../lib/overlay.js";
import { openConversation } from "./messages.js";

const path = "/api/bot-events";
const state = { inbox: "已记入事件记录", pending: "等待投递", sent: "已投递", failed: "投递失败", cancelled: "已取消" };
const option = (value, label) => h("option", { value }, label);
const button = (label, onclick) => h("button", { class: "btn", type: "button", onclick }, label);

function credentials(token) {
  const field = h("input", { "aria-label": "Webhook 令牌", type: "password", readonly: true, value: token, autocomplete: "off" });
  const reveal = button("显示令牌", () => {
    field.type = field.type === "password" ? "text" : "password";
    reveal.textContent = field.type === "password" ? "显示令牌" : "隐藏令牌";
    field.select();
  });
  modal({ title: "接入备份作业", body: h("div", { class: "modal-body assistant-list" },
    h("label", {}, "上报地址", h("input", { readonly: true, value: location.origin + path + "/receive" })),
    h("label", {}, "Webhook 令牌（仅本次可查看）", field), reveal,
    h("small", {}, "作业结束时用 POST 提交 JSON，请求头使用 Authorization: Bearer <令牌>。同一次运行重试时沿用 runId。"),
    h("code", {}, '{"runId":"backup-001","status":"failed","reason":"disk_full"}')) });
}

function addForm(settings, reload) {
  const name = h("input", { required: true, maxlength: 60, placeholder: "例如：NAS 夜间备份" });
  const source = h("select", {}, option("webhook", "外部备份 Webhook"), settings.admin ? option("backup", "本机数据库备份") : null);
  const destination = h("select", {}, option("inbox", "只写入事件记录"), option("web", "Web 系统推送"),
    settings.feishu.map((b) => option("feishu:" + b.id, "飞书 · " + b.name)));
  const analyze = h("input", { type: "checkbox" });
  const save = h("button", { class: "btn primary", type: "submit" }, "创建监听");
  const form = h("form", { class: "modal-body assistant-list" },
    h("label", {}, "名称", name), h("label", {}, "来源", source), h("label", {}, "发现新失败时", destination),
    h("label", {}, analyze, " 同时让 bot 分析故障"), save);
  const close = modal({ title: "新增事件监听", body: form });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      const { token } = await api(path, { method: "POST", body: { key: settings.key, name: name.value, source: source.value, destination: destination.value, analyze: analyze.checked } });
      close();
      if (token) credentials(token);
      void reload();
    } catch (err) { toast(err.message); save.disabled = false; }
  });
}

export function openBotEvents(query) {
  const body = h("div", { class: "modal-body assistant-list", "aria-live": "polite" }, "正在读取事件…");
  const controller = new AbortController();
  const dismiss = modal({ title: "bot 事件监听", body, beforeClose: () => controller.abort() });
  let generation = 0;
  async function retry(w, e) {
    try { await api(path + "/" + w.id + "/retry/" + e.id, { method: "POST" }); await load(); }
    catch (err) { toast(err.message); }
  }
  function incident(w, e) {
    return h("div", { class: "assistant-task" }, h("div", { class: "grow" },
      h("strong", {}, e.reason), h("small", {}, new Date(e.at).toLocaleString() + " · " + e.run),
      h("small", {}, [state[e.delivery], e.error, e.analysis === "error" ? "分析启动失败" : null].filter(Boolean).join(" · "))),
      e.analysisKey ? button("查看分析", () => { controller.abort(); dismiss(); void openConversation(e.analysisKey); }) : null,
      e.delivery === "failed" ? button("重试投递", () => void retry(w, e)) : null);
  }
  async function remove(w, key) {
    if (!await confirmDialog({ title: "删除监听？", message: "会停止接收这项作业的结果，并清除该监听的事件记录。", confirmText: "删除" })) return;
    try {
      await api(path + "/" + w.id, { method: "DELETE" });
      query = { key };
      await load();
    } catch (err) { toast(err.message); }
  }
  async function load() {
    const current = ++generation;
    try {
      const data = await api(path + "?" + new URLSearchParams(query));
      if (current !== generation || !body.isConnected) return;
      const watches = data.watches.slice().sort((a, b) => Number(b.id === query.watch) - Number(a.id === query.watch));
      fill(body, data.unavailable ? h("p", {}, data.unavailable) : button("新增监听", () => addForm(data, load)),
        watches.length ? watches.map((w) => {
          const dest = w.destination === "web" ? "Web 系统推送" : w.destination === "inbox" ? "只记入事件记录" :
            "飞书 · " + (data.feishu.find((b) => "feishu:" + b.id === w.destination)?.name || "绑定不可用");
          const latest = w.lastSeen ? "最近上报" + (w.lastStatus === "ok" ? "成功" : "失败") + " · " + new Date(w.lastSeen).toLocaleString() : "尚未收到上报";
          return h("section", { class: "assistant-card" }, h("div", { class: "assistant-row" },
            h("strong", { class: "grow" }, w.name), button("删除监听", () => void remove(w, data.key))),
            h("small", {}, [w.source === "backup" ? "本机数据库备份" : "外部备份 Webhook", dest, w.analyze ? "自动分析" : null].filter(Boolean).join(" · ")),
            h("small", {}, latest), w.events.map((e) => incident(w, e)));
        }) : h("p", {}, "暂无监听。添加备份作业后，可以在这里查看最近的失败记录。"),
        button("刷新记录", load));
    } catch (err) {
      if (body.isConnected && current === generation) fill(body, h("p", {}, err.message), button("重新加载", load));
    }
  }
  document.addEventListener("aim:bot-events", load, { signal: controller.signal });
  void load();
}
