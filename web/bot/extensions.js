import { api, button, field, h } from "./client.js";
import { action, currentPanel, formPanel, note, panel, run } from "./panel.js";
import { directoryPicker } from "./directory-picker.js";

const identifier = { autocapitalize: "none", autocorrect: "off", spellcheck: "false" };

export async function openExtensions(bot, back) {
  const path = "/api/bots/" + encodeURIComponent(bot.id) + "/extensions";
  const active = currentPanel();
  const { entries, canUseLocal, codex, claude } = await api(path);
  if (!active()) return;
  const list = () => openExtensions(bot, back);

  function editor(title, controls, onSave, cancel = list) {
    const save = h("button", { type: "submit" }, "保存");
    const form = h("form", { class: "sheet-form", method: "post", onsubmit: event => {
      event.preventDefault();
      const here = currentPanel();
      run(save, async () => {
        const next = await onSave();
        if (next !== false && here()) await (next || list)();
      });
    } }, controls);
    formPanel(title, form, save, cancel);
  }

  const saveEntry = (entry, data) => entry
    ? api(path + "/" + entry.id, "PATCH", { revision: entry.revision, ...data })
    : api(path, "POST", data);
  function remove(entry) {
    panel("移除「" + entry.name + "」？", note("移除后，这个 Bot 将无法再使用它。"),
      action("确认移除", async () => {
        const here = currentPanel();
        await api(path + "/" + entry.id, "DELETE", { revision: entry.revision });
        if (here()) await list();
      }, "primary"), button("取消", list, "secondary"));
  }

  function skill(entry) {
    const name = h("input", { id: "skill-name", name: "name", required: true, maxlength: 80, value: entry?.name });
    const text = h("textarea", { id: "skill-text", name: "instructions", required: true, maxlength: 96000, rows: 8 }, entry?.instructions);
    const enabled = h("input", { type: "checkbox", name: "enabled", checked: entry?.enabled ?? true });
    const file = h("input", { id: "skill-file", name: "file", type: "file", accept: ".md,text/markdown,text/plain" });
    file.onchange = async () => {
      const selected = file.files[0];
      if (!selected) return;
      file.setCustomValidity("");
      try {
        if (selected.size > 384000) throw new Error();
        const md = await selected.text();
        if (md.length > 96000 || !md.trim() || md.includes("\0")) throw new Error();
        text.value = md;
        if (!name.value) name.value = (md.match(/^name:\s*(.+)$/m)?.[1] || selected.name.replace(/\.md$/i, "")).slice(0, 80);
      } catch {
        file.value = "";
        file.setCustomValidity("请选择不超过 96000 字的 Markdown 文本。");
        file.reportValidity();
        file.setCustomValidity("");
      }
    };
    editor(entry ? "编辑技能" : "添加技能", [field("技能名称（必填）", name), field("导入 Markdown（可选）", file),
      field("技能说明（必填）", text), h("label", { class: "check-row" }, "在这个 Bot 的聊天中启用", enabled)], async () => {
      await saveEntry(entry, { kind: "skill", name: name.value, instructions: text.value, enabled: enabled.checked });
    });
  }

  async function importPackage() {
    const here = currentPanel();
    const url = "/api/bots/" + encodeURIComponent(bot.id) + "/skill-packages";
    const { sources } = await api(url);
    if (!here()) return;
    const file = h("input", { type: "file", id: "skill-package", accept: ".zip,.skill" });
    const select = h("select", { id: "skill-source" }, h("option", { value: "" }, "请选择"),
      sources.map(s => h("option", { value: s.id }, s.name + " · " + s.origin)));
    file.onchange = () => { if (file.files.length) select.value = ""; };
    select.onchange = () => { if (select.value) file.value = ""; };
    editor("导入技能包", [field("选择 ZIP 或 .skill 文件", file), sources.length > 0 && field("或复制现有技能", select),
      note("此 Bot 保存独立副本，包含脚本、模板和参考文件。启用后，Bot 成员的对话也可使用这些资料。")], async () => {
      if (select.value) { await api(url, "POST", { source: select.value }); return; }
      const selected = file.files[0];
      if (!selected || selected.size > 5 * 1024 * 1024 + 65536) throw new Error("请选择不超过 5 MB 的技能包。");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("无法读取技能包。"));
        reader.readAsDataURL(selected);
      });
      await api(url, "POST", { zip: data, name: selected.name.replace(/\.(zip|skill)$/i, "") });
    });
  }

  function connection(kind, entry) {
    const local = kind === "stdio";
    const name = h("input", { id: "mcp-name", name: "name", required: true, maxlength: 80, value: entry?.name });
    const endpoint = h("input", { id: "mcp-endpoint", name: "endpoint", type: local ? "text" : "url", required: true,
      ...identifier, maxlength: 2048, value: entry?.endpoint, placeholder: local ? "例如 node" : "https://example.com/mcp" });
    const args = h("textarea", { id: "mcp-args", name: "args", rows: 3, ...identifier }, entry?.args?.join("\n"));
    const secret = h("input", { id: "mcp-secret", name: "secret", type: "password", autocomplete: "new-password", ...identifier, maxlength: 8192 });
    const clear = h("input", { type: "checkbox", name: "clearSecret" });
    const fields = [field("连接名称（必填）", name), field(local ? "可执行命令（必填）" : "Streamable HTTP 地址（必填）", endpoint),
      local && field("启动参数（每行一个）", args),
      field(local ? "环境变量（可选，JSON 对象）" : "Bearer 令牌（可选）", secret),
      entry?.hasSecret && h("label", { class: "check-row" }, "清除已保存的凭据", clear),
      entry && note("凭据留空可沿用。更换目标或凭据后，需重新读取工具并授权。")];
    editor(entry ? "编辑 MCP 连接" : "添加 MCP 连接", fields, async () => {
      const saved = await saveEntry(entry, { kind, name: name.value, endpoint: endpoint.value,
        args: local && args.value ? args.value.split(/\r?\n/) : [], secret: clear.checked ? "" : secret.value || undefined });
      return () => permissions(saved);
    });
  }

  function permissions(entry) {
    const controls = [];
    const choices = entry.catalog.map(tool => {
      const mode = h("select", { name: tool.name, id: "tool-" + controls.length },
        h("option", { value: "" }, "关闭"), h("option", { value: "private" }, "仅所有者私聊"), h("option", { value: "members" }, "所有成员可用"),
        h("option", { value: "ask-private" }, "仅所有者私聊 · 每次询问"), h("option", { value: "ask-members" }, "所有成员 · 每次询问发起人"));
      mode.value = Object.hasOwn(entry.grants, tool.name) ? entry.grants[tool.name] : "";
      controls.push(h("div", {}, field(tool.name, mode), tool.description && note(tool.description)));
      return [tool.name, mode];
    });
    const discover = action(entry.catalog.length ? "重新读取工具列表" : "读取工具列表", async () => {
      const here = currentPanel();
      const refreshed = await api(path + "/" + entry.id + "/discover", "POST", { revision: entry.revision });
      if (here()) permissions(refreshed);
    }, "secondary");
    editor("工具授权 · " + entry.name, [note("成员可用的工具会使用本连接的凭据。仅所有者私聊的工具只在你与这个 Bot 的私聊中可用。"),
      discover, entry.catalog.length ? h("fieldset", { class: "checks" }, h("legend", {}, "按工具设置使用范围"), ...controls)
        : note("暂无可授权的工具。请读取列表，或检查连接设置。"),
      button("编辑连接", () => connection(entry.kind, entry), "text-action")], async () => {
      await api(path + "/" + entry.id + "/grants", "PATCH", {
        revision: entry.revision, grants: Object.fromEntries(choices.filter(([, mode]) => mode.value).map(([name, mode]) => [name, mode.value])),
      });
    });
    // Reading the server catalog replaces the form. Preserve edited grants until explicitly saved.
    for (const [, mode] of choices) mode.onchange = () => {
      discover.disabled = choices.some(([name, el]) => el.value !== (Object.hasOwn(entry.grants, name) ? entry.grants[name] : ""));
    };
  }

  async function nativeTools() {
    const here = currentPanel();
    const url = "/api/bots/" + encodeURIComponent(bot.id) + "/codex-tools";
    let options = [], error = "";
    try { ({ options } = await api(url)); } catch (err) { error = err.message; }
    if (!here()) return;
    const extras = (options || []).map(o => {
      const input = h("input", { type: "checkbox", checked: (codex.extra || []).includes(o.id), disabled: !o.available || !canUseLocal });
      return { ...o, input };
    });
    const scope = h("select", { name: "webSearch", id: "codex-web-search" },
      h("option", { value: "off" }, "关闭"), h("option", { value: "private" }, "仅所有者私聊"),
      h("option", { value: "members" }, "所有成员可用"));
    scope.value = codex.webSearch;
    const terminal = h("input", { type: "checkbox", name: "terminal", checked: canUseLocal && codex.terminal });
    const edit = h("input", { type: "checkbox", name: "edit", checked: canUseLocal && codex.edit });
    const directory = directoryPicker(url, codex.directory);
    const needsDirectory = () => canUseLocal && (terminal.checked || edit.checked ||
      extras.some(o => o.id === "view_image" && o.input.checked) || Boolean(error && codex.extra?.includes("view_image")));
    const syncDirectory = () => directory.enabled(needsDirectory());
    terminal.onchange = edit.onchange = syncDirectory;
    for (const o of extras) o.input.onchange = syncDirectory;
    syncDirectory();
    editor("Codex 自带工具", [field("联网搜索", scope), error && note(error),
      extras.length > 0 && h("fieldset", { class: "checks" }, h("legend", {}, "当前 Codex 版本的扩展能力 · 管理员私聊"),
        ...extras.map(o => h("label", { class: "check-row" }, o.label + (o.available ? "" : "（" + o.reason + "）"), o.input)),
        note("浏览器、桌面和应用使用引擎账号现有的连接。实际可用性还取决于模型和宿主环境。")), canUseLocal && h("fieldset", { class: "checks" },
      h("legend", {}, "本机工具 · 仅所有者私聊"), h("label", { class: "check-row" }, "执行终端命令", terminal),
      h("label", { class: "check-row" }, "编辑文件", edit),
      directory.node, note("终端默认只读；启用文件编辑后可在所选文件夹中写入。"))], async () => {
        if (needsDirectory() && !directory.validate()) return false;
        await api(url, "PATCH", {
          revision: codex.revision, extra: error ? undefined : extras.filter(o => o.available && o.input.checked).map(o => o.id), webSearch: scope.value, terminal: terminal.checked, edit: edit.checked, directory: directory.value,
        });
    });
  }

  function claudeTools() {
    const controls = Object.keys(claude.settings).map(id => {
      const select = h("select", { id: "native-" + id }, h("option", { value: "off" }, "关闭"),
        h("option", { value: "private" }, "仅所有者私聊"), h("option", { value: "members" }, "所有成员可用"));
      select.value = claude.settings[id];
      return { id, select, field: field(id === "WebSearch" ? "联网搜索 · WebSearch" : "读取网页 · WebFetch", select) };
    });
    editor("Claude Code 自带工具", controls.map(c => c.field), async () => {
      await api("/api/bots/" + encodeURIComponent(bot.id) + "/claude-tools", "PATCH", {
        revision: claude.revision, settings: Object.fromEntries(controls.map(c => [c.id, c.select.value])),
      });
    });
  }

  function record(entry) {
    const isSkill = entry.kind === "skill";
    const detail = isSkill ? (entry.enabled ? "已启用" : "已停用") : Object.keys(entry.grants).length + " 个工具已授权";
    return h("article", { class: "record" }, h("strong", {}, entry.name), note(detail), entry.files?.length > 0 && h("details", {}, h("summary", {}, entry.files.length + " 个附带文件"), ...entry.files.map(f => h("div", {}, f.path))), h("div", { class: "record-controls" },
      button(isSkill ? "编辑技能" : "管理工具", () => isSkill ? skill(entry) : permissions(entry), "chip"),
      button("移除", () => remove(entry), "text-action")));
  }
  panel("技能与工具", note("配置仅用于「" + bot.name + "」。"),
    claude && button("Claude Code 自带工具", claudeTools, "secondary"),
    codex && action("Codex 自带工具", nativeTools, "secondary"),
    h("h3", {}, "技能"), ...entries.filter(e => e.kind === "skill").map(record), button("添加技能", () => skill(), "secondary"), action("导入技能包", importPackage, "secondary"),
    h("h3", {}, "MCP 连接"), ...entries.filter(e => e.kind !== "skill").map(record),
    button("添加 HTTP 连接", () => connection("http"), "secondary"),
    canUseLocal && button("添加本机进程连接", () => connection("stdio"), "secondary"), button("返回设置", back, "text-action"));
}
