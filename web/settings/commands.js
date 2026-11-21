import { fill, h, icon, toast } from "../lib/dom.js";
import { ui } from "../state.js";
import { api } from "../lib/api.js";
import { agentLabel } from "../views/sidebar.js";
import { confirmDialog, modal, showMenu } from "../lib/overlay.js";
import { clearCommandCache, commandUsage, currentAgentId, oneLine, preloadCommands } from "../views/slash.js";
import { field, hasDirty, markClean, markDirty, saveButton, saveConfig } from "./common.js";

/**
 * 默认模型 + 默认思考程度的联动下拉框。
 * 模型列表从 agent 实时拿（Claude 要起一次进程，可能要几秒），拿到前先显示当前值；
 * 拿不到就退回文本框手填，不挡住保存。思考程度的选项跟着所选模型变。
 * 已保存但不在列表里的值（比如手填过的完整模型名）会作为「当前值」保留，不会被悄悄清掉。
 */
export function modelPicker(agent, model, effort, defaultLabel, modelList = api(`/api/agents/${agent}/models`)) {
  const modelSlot = h("div", { class: "picker" });
  const effortSlot = h("div", { class: "picker" });
  let getModel = () => model;
  let getEffort = () => effort;

  const option = (value, label, selected) => h("option", { value, selected: value === selected }, label);
  const withCurrent = (values, current) => (current && !values.includes(current) ? [current] : []);

  const asText = (reason) => {
    const m = h("input", { value: getModel(), placeholder: `留空${defaultLabel}` });
    const e = h("input", { value: getEffort(), placeholder: "low / medium / high …，留空默认" });
    fill(modelSlot, m, reason ? h("small", {}, reason) : null);
    effortSlot.replaceChildren(e);
    getModel = () => m.value.trim();
    getEffort = () => e.value.trim();
  };

  const loading = (text) => {
    modelSlot.replaceChildren(h("select", { disabled: true }, option("", text, "")));
    effortSlot.replaceChildren(h("select", { disabled: true }, option("", effort || "默认", "")));
  };

  const asSelect = (models) => {
    // Claude 自带一项 "default"，和「留空」是一回事，不重复列
    const listed = models.filter((m) => m.id !== "default");
    const fallback = models.find((m) => m.id === "default" || m.isDefault);
    const modelSel = h(
      "select",
      {},
      option("", `默认（${defaultLabel.replace(/^跟随\s*/, "")}）`, model),
      withCurrent(listed.map((m) => m.id), model).map((v) => option(v, `${v}（当前值，不在列表中）`, model)),
      listed.map((m) => option(m.id, m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id, model)),
    );
    const effortSel = h("select", {});
    const renderEfforts = () => {
      const picked = modelSel.value ? models.find((m) => m.id === modelSel.value) : fallback;
      const efforts = picked?.efforts ?? [];
      const keep = effortSel.value || effort;
      // 子项里有数组：replaceChildren 不展开数组，会把它变成文本节点（select 里直接被忽略）
      fill(
        effortSel,
        option("", "默认", keep),
        withCurrent(efforts, keep).map((v) => option(v, `${v}（当前值，该模型可能不支持）`, keep)),
        efforts.map((v) => option(v, v, keep)),
      );
    };
    modelSel.addEventListener("change", renderEfforts);
    renderEfforts();
    modelSlot.replaceChildren(modelSel);
    effortSlot.replaceChildren(effortSel);
    getModel = () => modelSel.value;
    getEffort = () => effortSel.value;
  };

  loading(model ? `${model}（正在读取模型列表…）` : "正在读取模型列表…");
  modelList.then((data) => (data?.models?.length ? asSelect(data.models) : asText("没读到模型列表，请手填")))
    .catch((err) => asText(err.status === 409 ? err.message : `读取模型列表失败，请手填：${err.message ?? err}`));

  return { modelEl: modelSlot, effortEl: effortSlot, model: () => getModel(), effort: () => getEffort() };
}

/** agent-loft 内置命令名（和服务端 BUILTIN_COMMANDS 一致），自定义命令不能用 */
const BUILTIN_NAMES = ["new", "status", "stop", "model", "effort", "sessions", "resume", "fork", "agent", "claude", "codex", "workbuddy", "pi", "dsh", "cd", "pwd", "permission", "planmode", "autoedit", "web", "detach", "approve", "help"];

/**
 * 添加 / 编辑一条自定义命令。onSave 返回 true 才关窗；失败（比如服务端校验没过）留着让用户改。
 * 规则和服务端一致：名字只能小写字母、数字、- _（飞书指令同款规则），不能和其它命令重名。
 */
function customDialog({ agent, entry, taken }, onSave) {
  const name = h("input", { value: entry?.name ?? "", placeholder: "比如 review", autocomplete: "off", spellcheck: "false" });
  const desc = h("input", { value: entry?.description ?? "", placeholder: "在命令列表里显示的一句话说明（可选）", maxlength: 200 });
  const prompt = h("textarea", { rows: 8, placeholder: "发送这条命令时，实际发给 agent 的内容" });
  prompt.value = entry?.prompt ?? "";
  const err = h("div", { class: "error-text" });
  const ok = h("button", { class: "btn primary" }, entry ? "保存" : "添加");
  const builtin = new Set(BUILTIN_NAMES);
  const submit = async () => {
    const n = name.value.trim().replace(/^[/／]/, "").toLowerCase();
    const p = prompt.value.trim();
    let problem = "";
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n)) problem = "命令名只能用小写字母、数字、- 和 _，以字母或数字开头，最长 32 个字符";
    else if (builtin.has(n)) problem = `/${n} 是 agent-loft 内置命令，换个名字`;
    else if (taken.includes(n)) problem = `已经有 /${n} 这条命令了，换个名字`;
    else if (!p) problem = "提示词不能为空";
    err.textContent = problem;
    if (problem) return;
    ok.disabled = true;
    const saved = await onSave({ name: n, description: desc.value.trim(), prompt: p });
    ok.disabled = false;
    if (saved) close();
  };
  ok.onclick = () => void submit();
  const close = modal({
    editor: true,
    title: entry ? `编辑 /${entry.name}` : `添加命令 · ${agentLabel(agent)}`,
    body: h(
      "div",
      { class: "modal-body" },
      field("命令名", h("div", { class: "cmd-name-input" }, h("span", {}, "/"), name), "小写字母、数字、- 和 _，最长 32 个字符（和飞书指令规则一致，才能同步到飞书）"),
      field("说明", desc),
      field(
        "提示词",
        prompt,
        "发送「/命令名 参数」时，把这段话发给 agent。提示词里写 $ARGUMENTS 会换成参数；不写的话，参数接在提示词后面。",
      ),
      err,
    ),
    foot: h("div", { class: "modal-foot" }, ok),
  });
  setTimeout(() => (entry ? prompt : name).focus(), 0);
}

/**
 * 设置 → 命令：每个 agent 一张表，拖动或用箭头排序，取消勾选就不在「/」列表里出现。
 * 默认 agent-loft 内置命令按常用程度排在最前，agent 自己的命令排在后面且默认不勾（服务端 buildCatalog 决定）。
 * 保存时把整张表的顺序存下来；以后新装的 skill 不在表里，会自动接在最后、默认不勾。
 * 管理员可以增删改自定义提示词，与排序统一保存。
 * 保存后服务端会同步到飞书机器人的指令面板，同步状态在「飞书」页里看。
 */
export function commandsTab(cfg, page) {
  const agentIds = Object.keys(cfg.agents);
  let agent = currentAgentId();
  if (!agentIds.includes(agent)) agent = agentIds[0];
  let list = [];
  let filter = "";
  let dragFrom = -1;

  const tabs = h("div", { class: "row" });
  const search = h("input", {
    class: "input",
    "data-nodirty": "",
    placeholder: "筛选命令（只影响显示，排序仍按整张表）",
    oninput: () => {
      filter = search.value.trim().toLowerCase();
      renderList();
    },
  });
  const listBox = h("div", { class: "cmd-list" });

  const move = (from, to) => {
    if (to < 0 || to >= list.length || from === to) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    renderList();
    markDirty(form);
  };

  const renderTabs = () =>
    fill(
      tabs,
      ...agentIds.map((id) =>
        h(
          "button",
          { class: `btn small${id === agent ? " primary" : ""}`, onclick: () => void switchAgent(id) },
          agentLabel(id),
        ),
      ),
    );

  const renderList = () => {
    const rows = list
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !filter || c.name.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter));
    fill(
      listBox,
      ...rows.map(({ c, i }) => {
        const shown = h("input", {
          type: "checkbox",
          checked: !c.hidden,
          title: "在「/」列表里显示",
          onchange: () => {
            c.hidden = !shown.checked;
            row.classList.toggle("off", c.hidden);
          },
        });
        const row = h(
          "div",
          {
            class: `cmd-row${c.hidden ? " off" : ""}`,
            draggable: filter ? false : "true",
            ondragstart: (e) => {
              dragFrom = i;
              e.dataTransfer.effectAllowed = "move";
              row.classList.add("dragging");
            },
            ondragend: () => row.classList.remove("dragging"),
            ondragover: (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            },
            ondrop: (e) => {
              e.preventDefault();
              if (dragFrom >= 0) move(dragFrom, i);
              dragFrom = -1;
            },
          },
          h("span", { class: "cmd-grip", title: filter ? "筛选时不能拖动" : "拖动排序" }, "⋮⋮"),
          shown,
          h(
            "div",
            { class: "grow" },
            h(
              "div",
              { class: "t" },
              h("code", {}, commandUsage(c)),
              c.source === "agent" ? h("span", { class: "badge" }, agentLabel(agent)) : null,
              c.source === "custom" ? h("span", { class: "badge custom" }, "自定义") : null,
            ),
            h("div", { class: "s" }, oneLine(c.description || c.prompt || "", 100) || "（无说明）"),
          ),
          h("button", { class: "icon-btn", "aria-label": "/" + c.name + " 更多操作", onclick: e => showMenu(e.currentTarget, [
            ...(c.source === "custom" ? [{ label: "编辑", onclick: () => editCustom(c) }, { label: "删除", danger: true, onclick: () => deleteCustom(c) }] : []),
            { label: "置顶", onclick: () => move(i, 0) },
            { label: "上移", onclick: () => move(i, i - 1) },
            { label: "下移", onclick: () => move(i, i + 1) },
          ]) }, icon("more")),
        );
        return row;
      }),
    );
  };

  const save = async (prefs) => {
    const ok = await saveConfig(cfg, { commands: { [agent]: prefs } });
    if (ok) {
      clearCommandCache();
      preloadCommands();
    }
    return ok;
  };
  const prefsOf = (rows) => ({
    order: rows.map((c) => c.name),
    hidden: rows.filter((c) => c.hidden).map((c) => c.name),
    custom: rows.filter((c) => c.source === "custom").map(({ name, description, prompt }) => ({ name, description, prompt })),
  });

  const stage = rows => {
    list = rows;
    renderList();
    markDirty(form);
    return true;
  };
  const addCustom = () =>
    customDialog({ agent, taken: list.map((c) => c.name) }, async (entry) => {
      // 新命令放在已有的自定义命令后面；还没有的话放在 agent-loft 内置命令后面
      const rows = [...list];
      const lastCustom = rows.findLastIndex((c) => c.source === "custom");
      const at = lastCustom >= 0 ? lastCustom + 1 : rows.findLastIndex((c) => c.source === "agent-loft") + 1;
      rows.splice(at, 0, { ...entry, source: "custom", runnable: true, hidden: false });
      return stage(rows);
    });
  const editCustom = (c) =>
    customDialog({ agent, entry: c, taken: list.filter((x) => x !== c).map((x) => x.name) }, (entry) =>
      stage(list.map((x) => (x === c ? { ...x, ...entry } : x))),
    );
  const deleteCustom = async (c) => {
    const sure = await confirmDialog({
      title: `删除 /${c.name}？`,
      message: "保存命令后在「/」列表和飞书指令面板里都不再出现。",
      confirmText: "删除",
      danger: true,
    });
    if (sure) stage(list.filter((x) => x !== c));
  };

  /** 换一个 agent 的表：这张表还有没保存的改动就先问 */
  const switchAgent = async (id) => {
    if (id === agent) return;
    if (
      hasDirty(page) &&
      !(await confirmDialog({ title: "命令还没保存", message: `${agentLabel(agent)} 的命令改动还没保存，切过去就不保存了。`, confirmText: "不保存", danger: true }))
    )
      return;
    markClean(form);
    void load(id);
  };

  async function load(id) {
    agent = id;
    renderTabs();
    fill(listBox, h("span", { class: "spinner" }));
    try {
      const data = await api(`/api/agents/${id}/commands`);
      if (id !== agent) return;
      list = data.commands;
      renderList();
    } catch (err) {
      fill(listBox, h("div", { class: "error-text" }, err.message));
    }
  }

  const form = h(
    "div",
    { class: "section", "data-form": "" },
    h("h4", {}, "命令列表"),
    h(
      "div",
      { class: "muted" },
      "在输入框里打「/」时弹出的命令，按这里的顺序排列；保存后会自动同步到飞书机器人的指令面板（同步状态在「飞书」里看）。取消勾选的不会出现在列表里，但照样可以手动输入。带 agent 名标记的是 agent 自己的命令（skills 等），默认不勾选，需要的话勾上并保存；它们会原样转给 agent。",
    ),
    h("button", { class: "btn small", onclick: () => ui.settings.selectTab("feishu/slash") }, "查看飞书同步状态"),
    tabs,
    h("div", { class: "row cmd-tools" }, search, h("button", { class: "btn", onclick: () => addCustom() }, icon("plus"), "添加命令")),
    listBox,
    h(
      "div",
      { class: "row" },
      saveButton(() => save(prefsOf(list)), "保存快捷命令"),
      h(
        "button",
        {
          class: "btn",
          onclick: async () => {
            if (!(await confirmDialog({ title: "恢复默认？", message: `把 ${agentLabel(agent)} 的命令顺序和显示恢复成默认（自定义命令保留）。`, confirmText: "恢复默认" }))) return;
            const selected = agent;
            try {
              const { commands } = await api("/api/agents/" + agent + "/commands?defaults=1");
              if (agent !== selected || !form.isConnected) return;
              const custom = list.filter(c => c.source === "custom").map(c => ({ ...c, hidden: false }));
              const names = new Set(custom.map(c => c.name));
              stage([...commands.filter(c => c.source === "agent-loft"), ...custom,
                ...commands.filter(c => c.source === "agent" && !names.has(c.name))]);
            } catch (err) { toast(err.message); }
          },
        },
        "恢复默认",
      ),
    ),
  );
  page.append(form);
  void load(agent);
}
