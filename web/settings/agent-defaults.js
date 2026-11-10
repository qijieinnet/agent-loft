import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { modal, confirmDialog } from "../lib/overlay.js";
import { isAdmin, S } from "../state.js";
import { renderContext } from "../views/topbar.js";
import { DEFAULT_LEVELS, engineSupports, PERMISSIONS } from "../lib/permission.js";
import { field, hasDirty, markDirty, saveButton, saveConfig } from "./common.js";
import { modelPicker } from "./commands.js";

// ---------- 内置 Agent 的默认设置（设置 → 专家 → 内置卡片上的「设置」） ----------
// 默认模型 / 思考程度：整台服务器的（config），只有管理员能改；
// 默认权限、默认加载的技能和 MCP：每个人自己的（/api/agents/defaults），单独保存，互不覆盖。

/** 设置里的默认权限「跟随」时实际是什么 */
const FOLLOW_LABEL = { claude: "跟随 Claude Code（逐次询问）", codex: "跟随沙箱设置", workbuddy: "跟随 WorkBuddy（逐次询问）", dsh: "跟随 dsh（工作区可写，越界才问）", pi: "跟随 pi（逐次询问）" };
const DEFAULT_MODEL_LABEL = { claude: "跟随 Claude Code 默认", codex: "跟随 config.toml", workbuddy: "跟随 WorkBuddy 默认", dsh: "跟随 dsh 默认", pi: "pi 自动挑一个能用的" };

/** 技能 / MCP：「跟随」或者「指定加载」+ 勾选 */
function loadPicker(label, items, selected, inheritLabel) {
  const mode = h(
    "select",
    { "aria-label": label },
    ...(inheritLabel ? [h("option", { value: "inherit", selected: selected === null }, inheritLabel)] : []),
    h("option", { value: "pick", selected: selected !== null }, "指定加载（可全部取消）"),
  );
  const known = new Set(items.map((item) => item.id));
  const missing = (selected ?? []).filter((id) => !known.has(id)).map((id) => ({ id, name: `${id}（暂不可用，可取消）` }));
  const inputs = [...items, ...missing].map((item) => ({ id: item.id, input: h("input", { type: "checkbox", checked: (selected ?? []).includes(item.id) }), item }));
  const list = h(
    "div",
    { class: "check-list" },
    inputs.length
      ? inputs.map(({ input, item }) => h("label", { class: "check-item tool-check-item", title: item.description ?? item.name }, input, h("span", {}, item.name)))
      : h("small", {}, "暂无可选项，请先在设置中添加"),
  );
  const sync = () => {
    list.hidden = mode.value !== "pick";
  };
  mode.addEventListener("change", sync);
  sync();
  return {
    el: h("div", { class: "field" }, h("span", {}, label), mode, list),
    value: () => (mode.value === "inherit" ? null : inputs.filter((x) => x.input.checked).map((x) => x.id)),
  };
}

export function openAgentDefaults(engine, label) {
  const form = h("div", { class: "modal-body builtin-agent-defaults" }, h("span", { class: "spinner" }));
  const foot = h("div", { class: "modal-foot" });
  // 改了没保存就关：问一句（和设置页切标签一样）
  const close = modal({
    title: `${label} 默认设置`,
    body: form,
    foot,
    beforeClose: () =>
      !hasDirty(root.parentElement) ||
      confirmDialog({ title: "有修改还没保存", message: "现在关掉，刚才改的内容不会保存。", confirmText: "不保存", danger: true }),
  });
  // 保存按钮在底栏、不在 body 里：整个弹窗当成一张表单
  const root = form.closest(".modal");
  root.dataset.form = "";
  const onEdit = (e) => {
    if (!e.target.closest("[data-nodirty]")) markDirty(root);
  };
  form.addEventListener("input", onEdit);
  form.addEventListener("change", onEdit);

  const load = async () => {
    let data;
    let cfg = null;
    try {
      [data, cfg] = await Promise.all([api("/api/agents/defaults"), isAdmin() ? api("/api/config") : null]);
    } catch (err) {
      fill(form, h("div", { class: "error-text" }, err.message), h("button", { class: "btn small", onclick: load }, "重试"));
      return;
    }
    const prefs = data.agents[engine];
    if (!prefs) {
      fill(form, h("p", { class: "muted" }, `没有 ${label} 的使用权限，请联系管理员。`));
      return;
    }
    const server = cfg?.agents?.[engine];
    const pick = server ? modelPicker(engine, server.defaultModel ?? "", server.defaultEffort ?? "", DEFAULT_MODEL_LABEL[engine] ?? "跟随默认") : null;

    const skills = loadPicker(`${label} 技能`, data.skills, prefs.skills, "全部已启用的个人技能（含以后新增）");
    const machine = (data.machineMcp?.[engine] ?? []).map((name) => ({ id: `${data.machinePrefix}${name}`, name: `${name}（本机）` }));
    const mcp = loadPicker(`${label} MCP`, [...data.mcp, ...machine], prefs.mcp, data.machineMcp ? "沿用机器上的 MCP 配置" : null);
    const machineSkills = h("input", { type: "checkbox", checked: prefs.machineSkills });
    // 成员最高到自动改文件；自动判断只有 Claude 有
    const levels = DEFAULT_LEVELS.filter((l) => engineSupports(engine, l) && (l !== "auto" || isAdmin()));
    const permission = h(
      "select",
      { "aria-label": `${label} 默认权限` },
      h("option", { value: "", selected: !prefs.permission }, FOLLOW_LABEL[engine] ?? "跟随默认"),
      levels.map((l) => h("option", { value: l, selected: l === prefs.permission }, `${PERMISSIONS[l].label}：${PERMISSIONS[l].desc}`)),
    );

    fill(
      form,
      pick
        ? [
            h("h4", {}, "默认模型"),
            h("p", { class: "skill-note" }, "整台服务器的默认值，对所有成员生效；对话里可以随时换。自定义专家自己选了模型的按专家的来。"),
            h("div", { class: "row-fields" }, field("模型", pick.modelEl), engine === "workbuddy" ? null : field("思考程度", pick.effortEl)),
          ]
        : null,
      h("h4", {}, "默认权限"),
      field(
        "新对话的权限",
        permission,
        "没单独选过权限的对话都按这一级（输入框里的盾牌按钮可以随时改）。自定义专家也按它，但不会超过专家自己的权限；定时任务的专用对话按任务里设的。",
      ),
      h("h4", {}, "默认加载"),
      h("p", { class: "skill-note" }, "只影响你自己的账号用这个内置 Agent 时，自定义专家用各自的配置。"),
      skills.el,
      data.machineMcp ? h("label", { class: "check-item" }, machineSkills, "同时加载机器上的技能") : null,
      mcp.el,
      h("small", {}, "技能和 MCP 可分别全部取消。记忆、定时任务、技能管理等系统工具仍按功能设置提供。"),
    );
    fill(
      foot,
      saveButton(async () => {
        const res = await api("/api/agents/defaults", {
          method: "PUT",
          body: { agents: { [engine]: { permission: permission.value || null, skills: skills.value(), machineSkills: machineSkills.checked, mcp: mcp.value() } } },
        });
        S.defaultPermission = { ...S.defaultPermission, [engine]: res.agents?.[engine]?.permission ?? null };
        const changed = pick && (pick.model() !== (server.defaultModel ?? "") || pick.effort() !== (server.defaultEffort ?? ""));
        if (changed && !(await saveConfig(cfg, { agents: { [engine]: { defaultModel: pick.model(), defaultEffort: pick.effort() } } }))) return false;
        renderContext();
        toast("已保存，下次发消息生效");
        close();
      }, `保存 ${label} 默认设置`),
    );
  };
  void load();
}
