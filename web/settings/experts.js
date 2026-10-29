import { agentIcon, fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { confirmDialog, modal, showMenu } from "../lib/overlay.js";
import { S } from "../state.js";
import { expertIcon, reloadExperts } from "../views/experts.js";
import { agentCatalog } from "../views/topbar.js";

// ---------- 专家（设置里的一页） ----------
// 专家 = 一份配置：引擎、提示词、权限、技能、MCP、子智能体。新建对话、定时任务时选，对话中途不能换。
// 内置的 Claude Code / Codex 不在这里改（就是 agent 原装的样子）。

const ENGINE_LABEL = { claude: "Claude", codex: "Codex" };
/** 权限的几项勾选。读文件 → 改文件 → 跑命令一级包含一级（跑命令就等于能改任何文件） */
const PERMS = [
  { id: "webSearch", label: "联网搜索", hint: "用搜索引擎查资料" },
  { id: "webFetch", label: "读网页", hint: "打开网址读内容", claudeOnly: true },
  { id: "read", label: "读文件", hint: "读工作目录里的文件，不能改" },
  { id: "edit", label: "改文件", hint: "读写工作目录里的文件，不能跑命令（Codex 改文件也要跑命令，只能改工作目录里的）" },
  { id: "exec", label: "跑命令", hint: "执行命令，等于能改任何文件；需要授权时会弹卡" },
];
const FILE_LEVELS = ["read", "edit", "exec"];

export async function expertsTab(panel) {
  const box = h("div", { class: "experts-page" }, h("span", { class: "spinner" }));
  fill(panel, box);
  const load = async () => {
    let data;
    try {
      data = await api("/api/experts");
    } catch (err) {
      fill(box, h("div", { class: "error-text" }, err.message));
      return;
    }
    if (!box.isConnected) return;
    render(box, data, load);
  };
  await load();
}

function render(box, data, reload) {
  const add = h("button", { class: "btn primary", onclick: () => openEditor(data, null, reload) }, icon("plus"), "新建");
  fill(
    box,
    h(
      "div",
      { class: "skills-head" },
      h(
        "p",
        { class: "skill-note" },
        "专家是一份配置：用哪个引擎、什么提示词、能做什么（联网 / 读文件 / 改文件 / 跑命令）、带哪些技能和 MCP、能把活派给哪些子智能体。新建对话、定时任务时选一个专家，对话从头到尾都是它。内置的 Claude Code、Codex 就是原装的样子。",
      ),
      h("div", { class: "skill-head-btns" }, add),
    ),
    h(
      "div",
      { class: "task-list" },
      data.builtin.map((b) =>
        h(
          "div",
          { class: "task-card skill-card" },
          h("div", { class: "task-top" }, h("span", { class: "task-title" }, agentIcon(b.engine, "expert-card-icon"), b.name), h("span", { class: "badge" }, "内置")),
          h("div", { class: "task-prompt" }, `${b.name} 原装的样子：原装提示词、机器上的技能和 MCP（成员只有自己的技能）、所有工具。`),
        ),
      ),
      data.experts.map((e) => expertCard(data, e, reload)),
    ),
    data.experts.length ? null : h("div", { class: "tasks-empty" }, h("div", { class: "t" }, "还没有自己的专家"), h("div", { class: "s" }, "点「新建」建一个。")),
  );
}

function expertCard(data, e, reload) {
  const access = data.access.find((a) => a.id === e.access)?.label ?? e.access;
  const more = h("button", { class: "icon-btn", title: "更多" }, icon("more"));
  more.onclick = () =>
    showMenu(more, [
      { label: "编辑…", onclick: () => openEditor(data, e, reload) },
      { label: "复制一份…", onclick: () => openEditor(data, null, reload, { ...e, name: `${e.name} 副本` }) },
      "sep",
      { label: "删除", danger: true, onclick: () => removeExpert(e, reload) },
    ]);
  const extras = [
    e.skills.length ? `${e.skills.length} 个技能` : null,
    e.mcp.length ? `${e.mcp.length} 个 MCP` : null,
    e.subagents.length ? `${e.subagents.length} 个子智能体` : null,
    e.memory ? null : "不带记忆",
  ].filter(Boolean);
  return h(
    "div",
    { class: "task-card skill-card" },
    h(
      "div",
      { class: "task-top" },
      h("button", { class: "task-title skill-name", title: "编辑", onclick: () => openEditor(data, e, reload) }, expertIcon(e, "expert-card-icon"), e.name),
      more,
    ),
    h("div", { class: "task-meta" }, h("span", {}, ENGINE_LABEL[e.engine]), h("span", {}, access), e.model ? h("span", {}, e.model) : null, extras.map((x) => h("span", {}, x))),
    e.description ? h("div", { class: "task-prompt" }, e.description) : null,
  );
}

async function removeExpert(e, reload) {
  const sure = await confirmDialog({
    title: `删除专家「${e.name}」？`,
    message: "用它的对话还能看，但不能再发消息；用它的定时任务会暂停，要换个专家再启用。",
    confirmText: "删除",
    danger: true,
  });
  if (!sure) return;
  try {
    await api(`/api/experts/${e.id}`, { method: "DELETE" });
    toast("已删除");
    void reload();
    void reloadExperts();
  } catch (err) {
    toast(err.message);
  }
}

function field(label, input, hint) {
  return h("div", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}

/** 一组勾选框：items [{ id, label, hint }]，返回 { el, value() } */
function checkList(items, picked, empty) {
  const boxes = items.map((it) => {
    const box = h("input", { type: "checkbox", checked: picked.includes(it.id) });
    return { id: it.id, box, el: h("label", { class: "check-item", title: it.hint ?? "" }, box, h("span", {}, it.label), it.hint ? h("small", {}, it.hint) : null) };
  });
  return {
    el: boxes.length ? h("div", { class: "check-list" }, boxes.map((b) => b.el)) : h("div", { class: "muted" }, empty),
    value: () => boxes.filter((b) => b.box.checked).map((b) => b.id),
  };
}

/** e：编辑这个；preset：新建时预填（模板、复制） */
function openEditor(data, e, reload, preset) {
  const src = e ?? preset ?? {};
  const name = h("input", { value: src.name ?? "", maxlength: "40", placeholder: "比如：证券观察员" });
  const avatar = avatarPicker(src, () => engine.value, !e);
  const desc = h("input", { value: src.description ?? "", maxlength: "500", placeholder: "一句话说它是干什么的（选专家时、当子智能体时都看这句）" });
  const engine = h(
    "select",
    { disabled: !!e },
    data.engines.map((id) => h("option", { value: id, selected: id === (src.engine ?? data.engines[0]) }, ENGINE_LABEL[id] ?? id)),
  );
  const models = modelPicker(src);
  const prompt = h("textarea", { rows: 10, class: "skill-body-input", maxlength: "20000", placeholder: "人设、规则、输出格式。比如：每个数字都必须来自实时查询，查不到就说查不到……" });
  prompt.value = src.prompt ?? "";
  const basePrompt = h(
    "select",
    {},
    h("option", { value: "lean", selected: (src.basePrompt ?? "lean") === "lean" }, "只用上面的提示词（省 token，推荐）"),
    h("option", { value: "claude_code", selected: src.basePrompt === "claude_code" }, "追加在 Claude Code 原装提示词后面（写代码、干活更稳，每轮多约 1.6 万 token）"),
  );
  const perms = permChecks(src);
  const cwd = h("input", { value: src.cwd ?? "", placeholder: `留空就是工作区根目录（${S.workspaceRoot ?? ""}）`, spellcheck: "false" });
  const memory = h("input", { type: "checkbox", checked: src.memory !== false });
  const welcome = h("input", { value: src.welcome ?? "", maxlength: "500", placeholder: "新对话页上的那句话，比如：想了解哪只股票？" });
  const quick = h("textarea", { rows: 4, placeholder: "一行一个，新对话页上点一下就填进输入框。可以写成「标题｜提示词」，提示词里的 ___ 是要用户填的空" });
  quick.value = (src.quickPrompts ?? []).map((q) => (q.title && q.title !== q.prompt.slice(0, 20) ? `${q.title}｜${q.prompt}` : q.prompt)).join("\n");

  const skills = checkList(
    data.skills.map((s) => ({ id: s.id, label: s.name, hint: s.description })),
    src.skills ?? [],
    "还没有启用的技能（设置 → 技能）",
  );
  const mcpBox = h("div");
  const subBox = h("div");
  let mcp = { value: () => src.mcp ?? [] };
  let subs = { value: () => src.subagents ?? [] };
  const renderEngineParts = () => {
    const eng = engine.value;
    const machine = (data.machineMcp?.[eng] ?? []).map((n) => ({ id: `${data.machinePrefix}${n}`, label: `${n}（本机）`, hint: "机器上配的 MCP，只有管理员能选" }));
    const keep = mcp.value();
    mcp = checkList(
      [...data.mcp.map((m) => ({ id: m.id, label: m.name, hint: m.description || (m.type === "http" ? "HTTP" : "本机进程") })), ...machine],
      keep,
      "还没有 MCP（设置 → MCP 里添加）",
    );
    fill(mcpBox, mcp.el);
    const keepSubs = subs.value();
    // 子智能体只有 Claude：自己的 Claude 专家，不能是自己
    subs = checkList(
      data.experts.filter((x) => x.engine === "claude" && x.id !== e?.id).map((x) => ({ id: x.id, label: !x.avatar && x.icon ? `${x.icon} ${x.name}` : x.name, hint: x.description })),
      keepSubs,
      "还没有别的 Claude 专家可以当子智能体",
    );
    fill(subBox, subs.el);
    subField.hidden = eng !== "claude";
    baseField.hidden = eng !== "claude";
    perms.setEngine(eng);
    avatar.refresh();
    void models.load(eng);
  };
  const sync = () => (cwdField.hidden = perms.access() === "web");
  const cwdField = field("默认工作目录", cwd, "新建对话、定时任务时默认在这个目录里（可以再改）。相对路径按工作区根目录算");
  const baseField = field("基础提示词", basePrompt);
  const subField = field("子智能体", subBox, "主专家可以把子任务派给它们（Agent 工具）。子智能体的权限不能超过主专家，只支持 Claude 专家");
  engine.onchange = renderEngineParts;
  perms.onchange = sync;

  const body = h(
    "div",
    { class: "modal-body task-form expert-form" },
    h("div", { class: "row-fields avatar-row" }, field("头像", avatar.el), field("名字", name)),
    field("说明", desc),
    h("div", { class: "row-fields" }, field("引擎", engine, e ? "建好后不能换" : null), field("模型", models.model), field("思考程度", models.effort)),
    field("提示词", prompt, "agent-loft 会在后面自动补上：这个专家能做什么、不能做什么，今天的日期，记忆"),
    baseField,
    field("权限", perms.el, "改文件包含读文件，跑命令包含改文件。什么都不勾就是只能聊天"),
    cwdField,
    field("技能", skills.el, "只给选中的技能；没选就不挂技能（省 token）"),
    field("MCP", mcpBox, "选中的 MCP 的工具直接可用（MCP 设了「调用前询问」的会弹授权）"),
    subField,
    field("记忆", h("label", { class: "check-item" }, memory, h("span", {}, "带上我的个人记忆（设置 → 记忆）"))),
    field("欢迎语", welcome),
    field("快捷提问", quick),
  );
  renderEngineParts();
  sync();
  const save = h("button", { class: "btn primary" }, e ? "保存" : "创建");
  const close = modal({ title: e ? `编辑 ${e.name}` : "新建专家", wide: true, tall: true, body, foot: h("div", { class: "modal-foot" }, save) });
  name.focus();
  save.onclick = async () => {
    const quickPrompts = quick.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("｜") >= 0 ? l.indexOf("｜") : l.indexOf("|");
        return i > 0 ? { title: l.slice(0, i).trim(), prompt: l.slice(i + 1).trim() } : { title: "", prompt: l };
      });
    const payload = {
      name: name.value,
      ...avatar.payload(),
      description: desc.value,
      engine: engine.value,
      model: models.model.value,
      effort: models.effort.value,
      prompt: prompt.value,
      basePrompt: basePrompt.value,
      access: perms.access(),
      cwd: cwd.value,
      webSearch: perms.checked("webSearch"),
      webFetch: perms.checked("webFetch"),
      skills: skills.value(),
      mcp: mcp.value(),
      subagents: engine.value === "claude" ? subs.value() : [],
      memory: memory.checked,
      welcome: welcome.value,
      quickPrompts,
    };
    save.disabled = true;
    try {
      if (e) await api(`/api/experts/${e.id}`, { method: "PATCH", body: payload });
      else await api("/api/experts", { method: "POST", body: payload });
      close();
      toast(e ? "已保存，用它的对话下一条消息起生效" : "已创建，新建对话时就能选");
      void reload();
      void reloadExperts();
    } catch (err) {
      save.disabled = false;
      toast(err.message);
    }
  };
}

/**
 * 权限勾选：联网搜索、读网页、读文件、改文件、跑命令。
 * 文件那三项一级包含一级：勾上高的，低的跟着勾上；取消低的，高的跟着取消。读网页只有 Claude 能单独开关
 */
function permChecks(src) {
  const rank = FILE_LEVELS.indexOf(src.access ?? "web");
  const boxes = new Map();
  const api = { onchange: null };
  const items = PERMS.map((p) => {
    const checked = p.id === "webSearch" || p.id === "webFetch" ? src[p.id] !== false : FILE_LEVELS.indexOf(p.id) <= rank;
    const box = h("input", { type: "checkbox", checked });
    boxes.set(p.id, box);
    box.onchange = () => {
      const i = FILE_LEVELS.indexOf(p.id);
      if (i >= 0) {
        FILE_LEVELS.forEach((id, n) => {
          if (box.checked && n < i) boxes.get(id).checked = true;
          if (!box.checked && n > i) boxes.get(id).checked = false;
        });
      }
      api.onchange?.();
    };
    const el = h("label", { class: "check-item" }, box, h("span", {}, p.label), h("small", {}, p.hint));
    return { p, el };
  });
  return Object.assign(api, {
    el: h("div", { class: "check-list perm-list" }, items.map((x) => x.el)),
    // 藏起来的（Codex 的读网页）照旧按勾选状态存，和以前一样
    checked: (id) => boxes.get(id).checked,
    access: () => [...FILE_LEVELS].reverse().find((id) => boxes.get(id).checked) ?? "web",
    setEngine: (engine) => {
      for (const x of items) x.el.hidden = !!x.p.claudeOnly && engine !== "claude";
    },
  });
}

/** 头像图片缩成这么大的正方形（显示时最大 56px，留够高清屏的余量） */
const AVATAR_PX = 128;

/**
 * 头像：点一下选图片，居中裁成正方形、缩到 128px 再上传。没传就用引擎的图标（以前设过 emoji 的还显示 emoji）。
 * src.avatar 是已有头像的地址；isNew（复制一份）时把它读成 data URL 一起带上。
 * payload()：没动过就不带 avatar（服务端沿用），去掉了带空字符串
 */
function avatarPicker(src, engineOf, isNew) {
  let value; // undefined = 没动过；"" = 去掉；data URL = 新的
  let shown = src.avatar || "";
  const preview = h("button", { type: "button", class: "avatar-preview", title: "上传头像" });
  const file = h("input", { type: "file", accept: "image/*", hidden: true });
  const remove = h("button", { type: "button", class: "btn small" }, "去掉");
  const refresh = () => {
    fill(preview, shown ? h("img", { src: shown, alt: "" }) : !value && value !== "" && src.icon ? h("span", { class: "avatar-emoji" }, src.icon) : agentIcon(engineOf()));
    remove.hidden = !shown;
  };
  preview.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    try {
      value = shown = await squareImage(f, AVATAR_PX);
      refresh();
    } catch (err) {
      toast(err.message);
    }
  };
  remove.onclick = () => {
    value = "";
    shown = "";
    refresh();
  };
  // 复制一份：头像也带过去（新专家还没有自己的头像地址）
  if (src.avatar && isNew) {
    void fetch(src.avatar)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => b && readDataUrl(b))
      .then((url) => {
        if (url && value === undefined) value = shown = url;
        refresh();
      })
      .catch(() => {});
  }
  return {
    el: h("div", { class: "avatar-field" }, preview, h("div", { class: "avatar-btns" }, h("button", { type: "button", class: "btn small", onclick: () => file.click() }, "上传"), remove), file),
    refresh,
    payload: () => (value === undefined ? {} : { avatar: value }),
  };
}

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读不了这张图片"));
    r.readAsDataURL(blob);
  });
}

/** 图片居中裁成正方形、缩到 size，转成 data URL（优先 WebP，浏览器不支持就是 PNG） */
async function squareImage(f, size) {
  if (!f.type.startsWith("image/")) throw new Error("请选一张图片");
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("读不了这张图片"));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(size, side) || size;
    canvas.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL("image/webp", 0.9);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 模型、思考程度：下拉选，选项是引擎的模型列表（和输入框里选模型的一样）。
 * 第一项「默认」= 不指定；已经存的值不在列表里（模型下线、手写的）也留着一项，不会被悄悄改掉
 */
function modelPicker(src) {
  const model = h("select", {});
  const effort = h("select", {});
  let modelVal = src.model ?? "";
  let effortVal = src.effort ?? "";
  let list = [];
  let engineLoaded = null;
  const opt = (value, label, selected) => h("option", { value, selected }, label);
  const renderEffort = () => {
    const picked = list.find((m) => m.id === modelVal) ?? list.find((m) => m.isDefault) ?? list.find((m) => m.efforts?.length);
    const efforts = picked?.efforts ?? [];
    const extra = effortVal && !efforts.includes(effortVal) ? effortVal : null;
    fill(
      effort,
      opt("", "默认", !effortVal),
      efforts.map((x) => opt(x, x, x === effortVal)),
      extra ? opt(extra, list.length ? `${extra}（不在列表里）` : extra, true) : null,
    );
    effort.disabled = !efforts.length && !extra;
  };
  const render = () => {
    const shown = list.filter((m) => m.id !== "default");
    const def = list.find((m) => m.isDefault) ?? list.find((m) => m.id === "default");
    const known = !modelVal || shown.some((m) => m.id === modelVal);
    fill(
      model,
      opt("", def ? `默认（${def.label || def.id}）` : "默认", !modelVal),
      shown.map((m) => opt(m.id, m.label && m.label !== m.id ? `${m.label}（${m.id}）` : m.id, m.id === modelVal)),
      known ? null : opt(modelVal, `${modelVal}（不在列表里）`, true),
    );
    renderEffort();
  };
  model.onchange = () => {
    modelVal = model.value;
    // 换了模型：原来的思考程度这个模型不支持就回到默认
    const picked = list.find((m) => m.id === modelVal) ?? list.find((m) => m.isDefault);
    if (effortVal && !(picked?.efforts ?? []).includes(effortVal)) effortVal = "";
    renderEffort();
  };
  effort.onchange = () => (effortVal = effort.value);
  return {
    model,
    effort,
    async load(engine) {
      if (engine === engineLoaded) return;
      // 换了引擎（只有新建时能换）：原来选的对不上了
      if (engineLoaded) modelVal = effortVal = "";
      engineLoaded = engine;
      list = [];
      fill(model, opt(modelVal, "加载中…", true));
      model.disabled = true;
      renderEffort();
      try {
        list = await agentCatalog(engine);
      } catch {
        // 拿不到列表：只能选默认（已经存的值也留着）
      }
      if (engineLoaded !== engine) return;
      model.disabled = false;
      render();
    },
  };
}

// ---------- MCP（设置里的一页） ----------

export async function mcpTab(panel) {
  const box = h("div", { class: "experts-page" }, h("span", { class: "spinner" }));
  fill(panel, box);
  const load = async () => {
    let data;
    try {
      data = await api("/api/mcp");
    } catch (err) {
      fill(box, h("div", { class: "error-text" }, err.message));
      return;
    }
    if (!box.isConnected) return;
    renderMcp(box, data, load);
  };
  await load();
}

function renderMcp(box, data, reload) {
  fill(
    box,
    h(
      "div",
      { class: "skills-head" },
      h(
        "p",
        { class: "skill-note" },
        "MCP 服务给专家提供工具（查数据、调接口）。这里加好，再到「专家」里给专家勾上。只给你自己的专家用；内置的 Claude Code / Codex 照旧用机器上配的。",
      ),
      h("div", { class: "skill-head-btns" }, h("button", { class: "btn primary", onclick: () => openMcpEditor(null, reload) }, icon("plus"), "添加")),
    ),
    data.servers.length
      ? h(
          "div",
          { class: "task-list" },
          data.servers.map((s) => {
            const more = h("button", { class: "icon-btn", title: "更多" }, icon("more"));
            more.onclick = () =>
              showMenu(more, [
                { label: "编辑…", onclick: () => openMcpEditor(s, reload) },
                "sep",
                { label: "删除", danger: true, onclick: () => removeMcp(s, reload) },
              ]);
            return h(
              "div",
              { class: "task-card skill-card" },
              h("div", { class: "task-top" }, h("button", { class: "task-title skill-name", onclick: () => openMcpEditor(s, reload) }, s.name), more),
              h(
                "div",
                { class: "task-meta" },
                h("span", {}, s.type === "http" ? "HTTP" : "本机进程"),
                h("span", { class: "mono" }, s.type === "http" ? s.url : [s.command, ...s.args].join(" ")),
                s.ask ? h("span", {}, "调用前询问") : null,
                h("span", {}, s.usedBy.length ? `${s.usedBy.join("、")} 在用` : "还没有专家用它"),
              ),
              s.description ? h("div", { class: "task-prompt" }, s.description) : null,
            );
          }),
        )
      : h("div", { class: "tasks-empty" }, h("div", { class: "t" }, "还没有 MCP"), h("div", { class: "s" }, "点「添加」：本机进程（比如 npx -y some-mcp、python -m server）或者 HTTP 地址。")),
  );
}

async function removeMcp(s, reload) {
  const sure = await confirmDialog({
    title: `删除 MCP「${s.name}」？`,
    message: s.usedBy.length ? `${s.usedBy.join("、")} 正在用它，删了以后这些专家就没有它的工具了。` : "删除后找不回来。",
    confirmText: "删除",
    danger: true,
  });
  if (!sure) return;
  try {
    await api(`/api/mcp/${s.id}`, { method: "DELETE" });
    toast("已删除");
    void reload();
  } catch (err) {
    toast(err.message);
  }
}

/** 环境变量 / 请求头：一行一个，名字、值、是不是密钥。已经填过的密钥不回显，留空就是不改 */
function pairsEditor(list, what) {
  const rows = h("div", { class: "pairs" });
  const add = (p = {}) => {
    const name = h("input", { value: p.name ?? "", placeholder: what === "env" ? "变量名" : "请求头", spellcheck: "false" });
    const value = h("input", { value: p.secret ? "" : (p.value ?? ""), placeholder: p.secret && p.set ? "已填，留空不改" : "值", type: p.secret ? "password" : "text", spellcheck: "false" });
    const secret = h("input", { type: "checkbox", checked: !!p.secret });
    secret.onchange = () => (value.type = secret.checked ? "password" : "text");
    const del = h("button", { class: "icon-btn", title: "删除", type: "button" }, icon("x"));
    const row = h("div", { class: "pair-row" }, name, value, h("label", { class: "check-item", title: "密钥：网页上不回显" }, secret, h("span", {}, "密钥")), del);
    row.read = () => ({ name: name.value.trim(), value: value.value, secret: secret.checked });
    del.onclick = () => row.remove();
    rows.append(row);
  };
  for (const p of list ?? []) add(p);
  return {
    el: h("div", {}, rows, h("button", { class: "btn small", type: "button", onclick: () => add() }, icon("plus"), what === "env" ? "加环境变量" : "加请求头")),
    value: () => [...rows.children].map((r) => r.read()).filter((p) => p.name),
  };
}

function openMcpEditor(s, reload) {
  const name = h("input", { value: s?.name ?? "", disabled: !!s, placeholder: "小写字母、数字、- 和 _，比如 akshare", spellcheck: "false" });
  const desc = h("input", { value: s?.description ?? "", maxlength: "500", placeholder: "它提供什么工具（给自己看）" });
  const type = h(
    "select",
    { disabled: !!s },
    h("option", { value: "stdio", selected: (s?.type ?? "stdio") === "stdio" }, "本机进程（stdio）"),
    h("option", { value: "http", selected: s?.type === "http" }, "HTTP 地址"),
  );
  const command = h("input", { value: s?.command ?? "", placeholder: "比如 npx、python、/usr/local/bin/xxx-mcp", spellcheck: "false" });
  const args = h("textarea", { rows: 3, placeholder: "一行一个参数，比如：\n-y\n@modelcontextprotocol/server-fetch", spellcheck: "false" });
  args.value = (s?.args ?? []).join("\n");
  const url = h("input", { value: s?.url ?? "", placeholder: "https://example.com/mcp", spellcheck: "false" });
  const env = pairsEditor(s?.env, "env");
  const headers = pairsEditor(s?.headers, "header");
  const ask = h("input", { type: "checkbox", checked: !!s?.ask });
  const stdioPart = h("div", { class: "field-group" }, field("命令", command), field("参数", args), field("环境变量", env.el, "比如 API 密钥。标成密钥的网页上不回显，只交给这个 MCP 进程，agent 看不到"));
  const httpPart = h("div", { class: "field-group" }, field("地址", url), field("请求头", headers.el, "比如 Authorization: Bearer xxx。标成密钥的网页上不回显"));
  const sync = () => {
    stdioPart.hidden = type.value !== "stdio";
    httpPart.hidden = type.value !== "http";
  };
  type.onchange = sync;
  sync();
  const body = h(
    "div",
    { class: "modal-body task-form" },
    field("名字", name, s ? "建好后不能改" : "工具在 agent 里叫 mcp__名字__工具名"),
    field("说明", desc),
    field("类型", type),
    stdioPart,
    httpPart,
    field("授权", h("label", { class: "check-item" }, ask, h("span", {}, "调用它的工具前先问我（不勾就直接用：这是你自己给专家挂的）"))),
  );
  const save = h("button", { class: "btn primary" }, s ? "保存" : "添加");
  const close = modal({ title: s ? `编辑 ${s.name}` : "添加 MCP", wide: true, body, foot: h("div", { class: "modal-foot" }, save) });
  (s ? desc : name).focus();
  save.onclick = async () => {
    const payload = {
      description: desc.value,
      ask: ask.checked,
      ...(type.value === "stdio"
        ? {
            command: command.value,
            args: args.value
              .split("\n")
              .map((a) => a.trim())
              .filter(Boolean),
            env: env.value(),
          }
        : { url: url.value, headers: headers.value() }),
    };
    save.disabled = true;
    try {
      if (s) await api(`/api/mcp/${s.id}`, { method: "PATCH", body: payload });
      else await api("/api/mcp", { method: "POST", body: { name: name.value.trim().toLowerCase(), type: type.value, ...payload } });
      close();
      toast(s ? "已保存，用它的专家下一条消息起生效" : "已添加，到「专家」里给专家勾上");
      void reload();
    } catch (err) {
      save.disabled = false;
      toast(err.message);
    }
  };
}
