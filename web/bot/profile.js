import { api, button, field, h, icon } from "./client.js";
import { action, currentPanel, note, panel, panelError, run } from "./panel.js";

const roles = [
  ["生活助手", "帮我安排日常事项、整理清单，记下需要跟进的事。", "简洁亲切，先说下一步。"],
  ["学习搭档", "陪我理解新知识，用例子解释难点，再带我练习。", "耐心讲解，每次聚焦一个问题。"],
  ["写作伙伴", "和我一起整理思路、推敲措辞，保留我的写作风格。", "先给可用的修改，再简要说明原因。"],
];
const capabilityNames = { memory: "记住偏好", reminders: "设置提醒", followups: "跟进事情", delegation: "请其他 Bot 帮忙" };

export async function openProfile({ bot, owner, onChange, back }) {
  const path = "/api/bots/" + encodeURIComponent(bot.id);
  const active = currentPanel();
  const { profile, engines } = await api(path + "/profile");
  if (!active()) return;
  if (!owner) {
    panel("Bot 资料", h("h3", {}, bot.name), note(profile.responsibility || "日常对话助手"),
      profile.style && note(profile.style), h("div", { class: "tags" }, ...profile.capabilities.map((c) => h("span", {}, capabilityNames[c]))),
      button("返回", back, "secondary"));
    return;
  }
  const duty = h("textarea", { id: "bot-duty", rows: 3, maxlength: 1400, placeholder: "希望它帮你做什么？" }, profile.responsibility);
  const style = h("textarea", { id: "bot-style", rows: 2, maxlength: 600, placeholder: "例如：简明直接，先给结论" }, profile.style);
  const presets = roles.map(([label, responsibility, voice]) => button(label, () => {
    duty.value = responsibility;
    style.value = voice;
    duty.focus();
  }, "chip"));
  const engineNames = { pi: "pi", codex: "Codex", claude: "Claude Code" };
  const engine = h("select", { id: "bot-engine", name: "engine" },
    engines.map(e => h("option", { value: e.id }, e.label)));
  if (!engines.some(e => e.id === profile.engine)) engine.append(h("option", { value: profile.engine }, engineNames[profile.engine] + " · 暂不可用"));
  engine.value = profile.engine;
  const model = h("select", { id: "bot-model", name: "model" });
  function resetModels() {
    model.replaceChildren(h("option", { value: "" }, "跟随引擎默认模型"));
    if (engine.value === profile.engine && profile.model) {
      model.append(h("option", { value: profile.model }, profile.model));
      model.value = profile.model;
    }
  }
  resetModels();
  const checks = Object.entries(capabilityNames).map(([key, label]) => {
    const check = h("input", { type: "checkbox", value: key, checked: profile.capabilities.includes(key) });
    return h("label", { class: "check-row" }, label, check);
  });
  const modelStatus = note("");
  let modelRequest = 0, requestedEngine;
  async function loadModels() {
    const selected = engine.value;
    if (requestedEngine === selected) return;
    requestedEngine = selected;
    const request = ++modelRequest;
    modelStatus.hidden = true;
    try {
      const { models } = await api(path + "/models?engine=" + encodeURIComponent(selected));
      if (!model.isConnected || request !== modelRequest) return;
      const missing = selected === profile.engine && profile.model && !models.some((m) => m.id === profile.model);
      if (missing) model.querySelectorAll("option")[1].textContent = profile.model + " · 暂不可用";
      for (const m of models) {
        const current = Array.from(model.options).find((option) => option.value === m.id);
        const label = m.label + (m.vision == null ? "" : m.vision ? " · 可读图" : " · 仅文字");
        if (current) current.textContent = label;
        else model.append(h("option", { value: m.id }, label));
      }
      modelStatus.textContent = models.length ? "" : "暂时没有可用模型，请联系管理员连接。";
      modelStatus.hidden = selected !== "pi" || !!models.length;
    } catch (err) {
      if (model.isConnected && request === modelRequest) {
        requestedEngine = undefined;
        modelStatus.hidden = false;
        modelStatus.replaceChildren(err.message, button("重试", loadModels, "text-action"));
      }
    }
  }
  engine.addEventListener("change", () => { resetModels(); loadModels(); });
  const advanced = h("details", { class: "advanced" }, h("summary", {}, "引擎、模型与能力"),
    h("div", { class: "field-pair" }, field("使用的引擎", engine), field("使用的模型", model)),
    modelStatus, h("fieldset", { class: "checks" }, h("legend", {}, "允许这个 Bot"), ...checks));
  modelStatus.hidden = true;
  advanced.addEventListener("toggle", () => { if (advanced.open) loadModels(); });
  const save = h("button", { type: "submit", class: "primary" }, "保存资料");
  const reload = button("重新载入资料", () => run(reload, () => openProfile({ bot, owner, onChange, back })), "secondary");
  reload.hidden = true;
  const form = h("form", { class: "sheet-form", onsubmit: (event) => {
    event.preventDefault();
    const stillHere = currentPanel();
    run(save, async () => {
      try {
        const { profile: updated } = await api(path + "/profile", "PATCH", {
          revision: profile.revision, responsibility: duty.value.trim(), style: style.value.trim(), engine: engine.value, model: model.value,
          capabilities: checks.map((label) => label.querySelector("input")).filter((el) => el.checked).map((el) => el.value),
        });
        onChange(updated);
        if (stillHere()) back();
      } catch (err) {
        if (err.status === 409 && stillHere()) {
          reload.hidden = false;
          panelError("资料刚被修改。你可以先复制编辑的内容，再重新载入。");
          return;
        }
        throw err;
      }
    });
  } }, h("div", { class: "presets" }, h("span", { class: "caption" }, "快速填入"), h("div", { class: "chips" }, ...presets)),
  field("主要职责", duty), field("说话风格", style), advanced, save, reload);
  panel("Bot 资料", form);
}

export function memoryEditor(ctx, initial = "", afterSave) {
  const { shared, owner } = ctx;
  const suggest = shared && !owner;
  const text = h("textarea", { id: "memory-text", maxlength: 420, required: true, rows: 4,
    placeholder: "想让它下次也记得什么？" }, initial);
  const save = h("button", { type: "submit", class: "primary" }, suggest ? "提交给所有者" : shared ? "保存共享记忆" : "保存私人记忆");
  const scope = shared
    ? (suggest ? "所有者同意后，这个 Bot 的所有成员都可以使用这条记忆。" : "这个 Bot 的所有成员都可以查看，并在各自对话中使用。")
    : "只在你和「" + ctx.bot.name + "」的私聊中使用。";
  const form = h("form", { class: "sheet-form", onsubmit: (event) => {
    event.preventDefault();
    const valid = currentPanel();
    if (!text.value.trim()) { text.focus(); return; }
    run(save, async () => {
      await api(ctx.path, "POST", { scope: shared ? "shared" : "private", text: text.value.trim() });
      if (valid() && ctx.live()) {
        if (afterSave) afterSave();
        else await openMemories(ctx);
      }
    });
  } }, note(scope), field("记住的内容", text), save);
  panel(suggest ? "建议一条共享记忆" : shared ? "记到共享 Bot" : "让 Bot 记住", form);
}

export async function openMemories(ctx) {
  const active = currentPanel();
  const { memories, proposals = [] } = await api(ctx.path);
  if (!ctx.live() || !active()) return;
  function entry(item, pending) {
    const url = ctx.path + "/" + encodeURIComponent(item.id);
    const subject = pending ? (item.canApprove ? "待你确认" : "已提交，等所有者确认") : item.scope === "private" ? "你的私人记忆" : "成员共享";
    const card = h("article", { class: "record" }, h("small", {}, subject), h("p", {}, item.text));
    const controls = h("div", { class: "record-controls" });
    const change = async (approve) => {
      const valid = currentPanel();
      await api(approve ? url + "/approve" : url, approve ? "POST" : "DELETE", approve ? { scope: "shared" } : undefined);
      if (ctx.live() && valid()) await openMemories(ctx);
    };
    if (item.canApprove && ctx.enabled) controls.append(action("同意加入", () => change(true), "chip"));
    if (item.canDelete) {
      const label = pending ? (item.canApprove ? "拒绝" : "撤回") : "删除";
      controls.append(button(label, () =>
        panel(label + "这条" + (pending ? "建议" : "记忆") + "？", note(item.text),
          action("确认" + label, () => change(false), "primary"), action("返回", () => openMemories(ctx), "secondary")), "text-action"));
    }
    if (controls.childElementCount) card.append(controls);
    return card;
  }
  panel("记住的事", ctx.enabled ? action(ctx.shared && !ctx.owner ? "建议共享记忆" : "添加记忆", () => memoryEditor(ctx), "primary") :
    note("这个 Bot 已关闭记忆。你仍可以管理之前保存的内容。"),
    !memories.length && !proposals.length && h("div", { class: "empty-records" }, icon("bookmark"), note("这里会留下你明确保存的偏好和约定。")),
    ...proposals.map((item) => entry(item, true)), ...memories.map((item) => entry(item, false)));
}
