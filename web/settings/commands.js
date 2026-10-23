import { fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { agentLabel } from "../views/sidebar.js";
import { confirmDialog, modal } from "../lib/overlay.js";
import { commandUsage, currentAgentId, oneLine, slash } from "../views/slash.js";
import { field, saveConfig } from "./common.js";

/**
 * 默认模型 + 默认思考程度的联动下拉框。
 * 模型列表从 agent 实时拿（Claude 要起一次进程，可能要几秒），拿到前先显示当前值；
 * 拿不到就退回文本框手填，不挡住保存。思考程度的选项跟着所选模型变。
 * 已保存但不在列表里的值（比如手填过的完整模型名）会作为「当前值」保留，不会被悄悄清掉。
 */
export function modelPicker(agent, model, effort, defaultLabel) {
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
  api(`/api/agents/${agent}/models`)
    .then((data) => (data?.models?.length ? asSelect(data.models) : asText("没读到模型列表，请手填")))
    .catch((err) => asText(err.status === 409 ? err.message : `读取模型列表失败，请手填：${err.message ?? err}`));

  return { modelEl: modelSlot, effortEl: effortSlot, model: () => getModel(), effort: () => getEffort() };
}

/** agent-loft 内置命令名（和服务端 BUILTIN_COMMANDS 一致），自定义命令不能用 */
const BUILTIN_NAMES = ["new", "status", "stop", "model", "effort", "sessions", "resume", "fork", "agent", "claude", "codex", "cd", "pwd", "autoedit", "web", "detach", "approve", "help"];

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
 * 用户可以自己添加命令（一段预设的提示词），自己加的可以编辑、删除，增删改后立即保存。
 */
export function commandsTab(cfg, panel) {
  const agentIds = Object.keys(cfg.agents);
  let agent = currentAgentId();
  if (!agentIds.includes(agent)) agent = agentIds[0];
  let list = [];
  let filter = "";
  let dragFrom = -1;

  const tabs = h("div", { class: "row" });
  const search = h("input", {
    class: "input",
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
  };

  const renderTabs = () =>
    fill(
      tabs,
      ...agentIds.map((id) =>
        h(
          "button",
          { class: `btn small${id === agent ? " primary" : ""}`, onclick: () => id !== agent && load(id) },
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
          c.source === "custom"
            ? [
                h("button", { class: "icon-btn", title: "编辑", onclick: () => editCustom(c) }, icon("edit")),
                h("button", { class: "icon-btn danger", title: "删除", onclick: () => deleteCustom(c) }, icon("trash")),
              ]
            : null,
          h("button", { class: "icon-btn", title: "置顶", onclick: () => move(i, 0) }, "⤒"),
          h("button", { class: "icon-btn", title: "上移", onclick: () => move(i, i - 1) }, "↑"),
          h("button", { class: "icon-btn", title: "下移", onclick: () => move(i, i + 1) }, "↓"),
        );
        return row;
      }),
    );
  };

  const save = async (prefs) => {
    const ok = await saveConfig(cfg, { commands: { [agent]: prefs } });
    slash.cache.clear();
    // 服务端 3 秒防抖后才开始同步，稍等再看状态
    if (ok) setTimeout(() => void refreshFeishu(), 3500);
    return ok;
  };
  const prefsOf = (rows) => ({
    order: rows.map((c) => c.name),
    hidden: rows.filter((c) => c.hidden).map((c) => c.name),
    custom: rows.filter((c) => c.source === "custom").map(({ name, description, prompt }) => ({ name, description, prompt })),
  });

  // ---- 自定义命令：增删改都立即保存（连同当前的排序和显示），保存失败就不动列表 ----
  const commit = async (rows) => {
    if (!(await save(prefsOf(rows)))) return false;
    list = rows;
    renderList();
    return true;
  };
  const addCustom = () =>
    customDialog({ agent, taken: list.map((c) => c.name) }, async (entry) => {
      // 新命令放在已有的自定义命令后面；还没有的话放在 agent-loft 内置命令后面
      const rows = [...list];
      const lastCustom = rows.findLastIndex((c) => c.source === "custom");
      const at = lastCustom >= 0 ? lastCustom + 1 : rows.findLastIndex((c) => c.source === "agent-loft") + 1;
      rows.splice(at, 0, { ...entry, source: "custom", runnable: true, hidden: false });
      return commit(rows);
    });
  const editCustom = (c) =>
    customDialog({ agent, entry: c, taken: list.filter((x) => x !== c).map((x) => x.name) }, (entry) =>
      commit(list.map((x) => (x === c ? { ...x, ...entry } : x))),
    );
  const deleteCustom = async (c) => {
    const sure = await confirmDialog({
      title: `删除 /${c.name}？`,
      message: "删除后在「/」列表和飞书指令面板里都不再出现。",
      confirmText: "删除",
      danger: true,
    });
    if (sure) await commit(list.filter((x) => x !== c));
  };

  // ---- 飞书指令面板同步状态 ----
  const feishuBox = h("div", { class: "cmd-feishu" });
  let feishuTimer = null;
  const describeSlash = (st) => {
    if (st.state === "syncing") return "同步中…（重建时每条间隔 1 秒，命令多要一两分钟）";
    if (st.state === "error") return `同步失败：${st.error}`;
    if (st.state === "done") {
      const when = new Date(st.at).toLocaleTimeString();
      const skipped = st.skipped?.length
        ? `；${st.skipped.length} 个名字不符合飞书规则（只能小写字母、数字、- _，最长 32）没注册：${st.skipped.slice(0, 8).join("、")}${st.skipped.length > 8 ? " 等" : ""}`
        : "";
      return `${when} ${st.changed ? "已同步" : "已是最新"}，共 ${st.registered} 条${skipped}。飞书端约 5～8 分钟后生效。`;
    }
    return "等待首次同步";
  };
  async function refreshFeishu() {
    let data;
    try {
      data = await api("/api/feishu/slash");
    } catch (err) {
      fill(feishuBox, h("div", { class: "error-text" }, err.message));
      return;
    }
    fill(
      feishuBox,
      data.bots.length === 0
        ? h("div", { class: "muted" }, "没有运行中的飞书机器人。")
        : data.bots.map((b) =>
            h(
              "div",
              { class: `muted${b.status.state === "error" ? " error-text" : ""}` },
              h("b", {}, b.name),
              "：",
              describeSlash(b.status),
            ),
          ),
    );
    clearTimeout(feishuTimer);
    feishuTimer = data.bots.some((b) => b.status.state === "syncing") ? setTimeout(() => feishuBox.isConnected && void refreshFeishu(), 2000) : null;
  }

  async function load(id) {
    agent = id;
    renderTabs();
    fill(listBox, h("span", { class: "spinner" }));
    try {
      const data = await api(`/api/agents/${id}/commands`);
      list = data.commands;
      renderList();
    } catch (err) {
      fill(listBox, h("div", { class: "error-text" }, err.message));
    }
  }

  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "命令列表"),
      h(
        "div",
        { class: "muted" },
        "在输入框里打「/」时弹出的命令，按这里的顺序排列；保存后会自动同步到飞书机器人的指令面板。取消勾选的不会出现在列表里，但照样可以手动输入。带 agent 名标记的是 agent 自己的命令（skills 等），默认不勾选，需要的话勾上并保存；它们会原样转给 agent。",
      ),
      tabs,
      h(
        "div",
        { class: "row cmd-tools" },
        search,
        h("button", { class: "btn", onclick: () => addCustom() }, icon("plus"), "添加命令"),
      ),
      listBox,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: () => save(prefsOf(list)),
          },
          "保存",
        ),
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              if (!(await confirmDialog({ title: "恢复默认？", message: `把 ${agentLabel(agent)} 的命令顺序和显示恢复成默认（自定义命令保留）。`, confirmText: "恢复默认" }))) return;
              await save({ order: [], hidden: [] });
              await load(agent);
            },
          },
          "恢复默认",
        ),
      ),
    ),
    h(
      "div",
      { class: "section" },
      h(
        "h4",
        {},
        "飞书指令面板",
        h("span", { class: "grow" }),
        h(
          "button",
          {
            class: "btn small",
            onclick: async () => {
              try {
                await api("/api/feishu/slash/sync", { method: "POST" });
                setTimeout(() => void refreshFeishu(), 500);
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "立即同步",
        ),
      ),
      h(
        "div",
        { class: "muted" },
        "飞书输入框打「/」看到的指令。面板是每个机器人一份：默认 agent 的命令在前，其它 agent 的命令接在后面。启动时、保存命令设置后、以及每 6 小时会自动同步。",
      ),
      feishuBox,
    ),
  );
  void load(agent);
  void refreshFeishu();
}
