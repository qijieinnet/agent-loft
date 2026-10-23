import { fill, h, icon, starsLoader, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { renderMarkdown } from "../lib/markdown.js";
import { confirmDialog, modal, showMenu } from "../lib/overlay.js";
import { S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { closeSide, renderSidebar } from "./sidebar.js";
import { renderTopbar } from "./topbar.js";

// ---------- 技能页 ----------
// 三块：我的技能（自己建的 + 装了的，可以停用、填变量）、技能广场（别人分享给我、公开的，点安装）、
// 本机技能（机器上原有的，只有管理员看得到、用得到）。
// 装的是作者那一份本身：作者改了，装了的人跟着用新的。技能有变化时服务端推 { t: "skills" }，这里重新拉。

const K = { data: null, tab: "mine", query: "", token: 0, reloadTimer: 0 };

const VISIBILITY = { private: "仅自己", users: "指定的人", all: "所有人" };

export async function openSkills() {
  if (S.current) WS.raw({ t: "unsub", key: S.current });
  S.current = null;
  S.view = "skills";
  S.items = [];
  S.turnAi = null;
  history.replaceState(null, "", "#skills");
  WS.presence();
  ui.spacer.style.height = "0px";
  ui.follow = false;
  // 和定时任务页一样：藏起输入框（css/tasks.css 的 .tasks-view）
  ui.main.classList.add("tasks-view");
  closeSide();
  renderTopbar();
  renderSidebar();
  fill(ui.msgInner, h("div", { class: "empty" }, starsLoader("lg")));
  await reload();
  ui.messages.scrollTop = 0;
}

async function reload() {
  const my = ++K.token;
  try {
    const data = await api("/api/skills");
    if (my !== K.token || S.view !== "skills") return;
    K.data = data;
    render();
  } catch (err) {
    if (my === K.token && S.view === "skills") fill(ui.msgInner, h("div", { class: "empty" }, err.message));
  }
}

document.addEventListener("aim:skills", () => {
  if (S.view !== "skills") return;
  clearTimeout(K.reloadTimer);
  K.reloadTimer = setTimeout(() => void reload(), 300);
});

function mine() {
  return K.data.skills.filter((s) => s.installed).sort((a, b) => a.name.localeCompare(b.name));
}

function plaza() {
  return K.data.skills.filter((s) => !s.mine).sort((a, b) => b.updatedAt - a.updatedAt);
}

function matches(s) {
  const q = K.query.trim().toLowerCase();
  return !q || s.name.includes(q) || s.description.toLowerCase().includes(q) || (s.ownerName ?? "").toLowerCase().includes(q);
}

function render() {
  const tabs = [
    ["mine", `我的技能 ${mine().length}`],
    ["plaza", `技能广场 ${plaza().length}`],
    ...(K.data.machine ? [["machine", `本机技能 ${K.data.machine.length}`]] : []),
  ];
  const search = h("input", { class: "skill-search", type: "search", placeholder: "搜索名字、说明、作者", value: K.query });
  search.oninput = () => {
    K.query = search.value;
    fill(listBox, renderList());
  };
  const listBox = h("div", { class: "skill-list-box" }, renderList());
  fill(
    ui.msgInner,
    h(
      "div",
      { class: "tasks-page skills-page" },
      h(
        "div",
        { class: "tasks-head" },
        h(
          "div",
          { class: "grow" },
          h("h2", {}, "技能"),
          h(
            "p",
            {},
            "技能是一份写给 agent 的做事方法（SKILL.md），可以带脚本和资料，Claude 和 Codex 都能用。工作模式下 agent 遇到对得上的事会自己用；在输入框或定时任务里输入 @ 可以点名用哪个。",
          ),
        ),
        h(
          "div",
          { class: "skill-head-btns" },
          h("button", { class: "btn", onclick: () => pickUpload() }, "上传"),
          h("button", { class: "btn primary", onclick: () => openEditor() }, icon("plus"), "新建"),
        ),
      ),
      h(
        "div",
        { class: "skill-tabs" },
        h(
          "div",
          { class: "seg" },
          tabs.map(([id, label]) =>
            h(
              "button",
              {
                class: K.tab === id ? "on" : "",
                onclick: () => {
                  K.tab = id;
                  render();
                },
              },
              label,
            ),
          ),
        ),
        search,
      ),
      listBox,
    ),
  );
}

function renderList() {
  if (K.tab === "machine") {
    const list = K.data.machine.filter((m) => matches({ ...m, ownerName: "" }));
    return [
      h("p", { class: "skill-note" }, "这台机器上原有的技能（~/.claude/skills、~/.agents/skills 等）。只有管理员的会话能用，其他人的会话里看不到、也调不了。要分给别人用，请复制内容新建一个 agent-loft 技能再分享。"),
      list.length ? h("div", { class: "task-list" }, list.map(machineCard)) : h("div", { class: "skill-empty" }, "没有找到"),
    ];
  }
  if (K.tab === "plaza") {
    const list = plaza().filter(matches);
    return list.length
      ? h("div", { class: "task-list" }, list.map(plazaCard))
      : h("div", { class: "skill-empty" }, K.query ? "没有找到" : "还没有人分享技能给你。自己建的技能可以设成「所有人」或者分享给指定的人。");
  }
  const list = mine().filter(matches);
  if (list.length) return h("div", { class: "task-list" }, list.map(mineCard));
  if (K.query) return h("div", { class: "skill-empty" }, "没有找到");
  return h(
    "div",
    { class: "tasks-empty" },
    h("div", { class: "t" }, "还没有技能"),
    h(
      "div",
      { class: "s" },
      "点「新建」写一个，「上传」一个技能包（.zip / .skill / SKILL.md / 文件夹），去「技能广场」装别人分享的，或者在对话里让 agent「把刚才的做法存成技能」。",
    ),
  );
}

// ---------- 卡片 ----------

/** 变量：几个、缺几个必填的 */
function varsState(s) {
  if (!s.vars.length) return null;
  const missing = s.vars.filter((v) => v.required && !K.data.vars[v.name]?.set);
  const pending = s.vars.filter((v) => K.data.vars[v.name]?.pending);
  if (missing.length) return h("span", { class: "skill-warn" }, `${missing.length} 个变量没填`);
  if (pending.length) return h("span", { class: "skill-warn" }, "密钥的发送地址待确认");
  return h("span", {}, `${s.vars.length} 个变量`);
}

/** 要去「填写变量」处理的：必填的没填，或者受保护密钥的地址待确认 */
function varsNeedAttention(s) {
  return s.vars.some((v) => (v.required && !K.data.vars[v.name]?.set) || K.data.vars[v.name]?.pending);
}

function mineCard(s) {
  const toggle = h("input", { type: "checkbox", checked: s.enabled });
  toggle.onchange = async () => {
    try {
      await api(`/api/skills/${s.id}/enable`, { method: "POST", body: { on: toggle.checked } });
      toast(toggle.checked ? "已启用" : "已停用");
      void reload();
    } catch (err) {
      toggle.checked = !toggle.checked;
      toast(err.message);
    }
  };
  const more = h("button", { class: "icon-btn", title: "更多" }, icon("more"));
  more.onclick = () =>
    showMenu(more, [
      { label: "查看", onclick: () => openDetail(s) },
      ...(s.vars.length ? [{ label: "填写变量…", onclick: () => openVars(s) }] : []),
      ...(s.mine
        ? [
            { label: "编辑…", onclick: () => openEditor(s) },
            { label: "用文件替换…", onclick: () => pickUpload(s) },
          ]
        : []),
      "sep",
      s.mine
        ? { label: "删除", danger: true, onclick: () => removeSkill(s) }
        : { label: "卸载", danger: true, onclick: () => install(s, false) },
    ]);
  return h(
    "div",
    { class: `task-card skill-card${s.enabled ? "" : " off"}` },
    h(
      "div",
      { class: "task-top" },
      h("button", { class: "task-title skill-name", title: "查看", onclick: () => openDetail(s) }, s.name),
      h("label", { class: "switch", title: s.enabled ? "已启用，点击停用" : "已停用，点击启用" }, toggle, h("span", { class: "slider" })),
      more,
    ),
    h(
      "div",
      { class: "task-meta" },
      h("span", {}, s.mine ? "我建的" : `${s.ownerName} 建的`),
      s.mine ? h("span", {}, `${VISIBILITY[s.visibility]}可见${s.visibility === "users" ? `（${s.sharedWith.length} 人）` : ""}`) : null,
      s.mine && s.installs ? h("span", {}, `${s.installs} 人安装`) : null,
      s.source === "agent" ? h("span", {}, "agent 生成") : null,
      varsState(s),
    ),
    h("div", { class: "task-prompt" }, s.description),
    varsNeedAttention(s)
      ? h("button", { class: "task-run", onclick: () => openVars(s) }, s.vars.some((v) => v.required && !K.data.vars[v.name]?.set) ? "填写变量后才能正常使用 →" : "确认密钥的发送地址 →")
      : null,
  );
}

function plazaCard(s) {
  const btn = s.installed
    ? h("button", { class: "btn", onclick: () => install(s, false) }, "已安装")
    : h("button", { class: "btn primary", onclick: () => install(s, true) }, "安装");
  const more = s.canDelete ? h("button", { class: "icon-btn", title: "更多" }, icon("more")) : null;
  if (more) more.onclick = () => showMenu(more, [{ label: "下架（删除）", danger: true, onclick: () => removeSkill(s) }]);
  return h(
    "div",
    { class: "task-card skill-card" },
    h("div", { class: "task-top" }, h("button", { class: "task-title skill-name", title: "查看", onclick: () => openDetail(s) }, s.name), btn, more),
    h(
      "div",
      { class: "task-meta" },
      h("span", {}, `${s.ownerName} 建的`),
      h("span", {}, s.visibility === "all" ? "公开" : "分享给你"),
      h("span", {}, `更新于 ${new Date(s.updatedAt).toLocaleDateString()}`),
      s.vars.length ? h("span", {}, `要填 ${s.vars.length} 个变量`) : null,
    ),
    h("div", { class: "task-prompt" }, s.description),
  );
}

function machineCard(m) {
  return h(
    "div",
    { class: "task-card skill-card" },
    h("div", { class: "task-top" }, h("button", { class: "task-title skill-name", onclick: () => openMachine(m) }, m.name), h("span", { class: "badge" }, m.agents.map((a) => (a === "claude" ? "Claude" : "Codex")).join(" · "))),
    h("div", { class: "task-meta" }, h("span", { title: m.dir }, m.dir)),
    h("div", { class: "task-prompt" }, m.description || "（没有说明）"),
  );
}

// ---------- 操作 ----------

async function install(s, on) {
  try {
    await api(`/api/skills/${s.id}/install`, { method: "POST", body: { on } });
    toast(on ? `已安装 ${s.name}，新消息起可用` : `已卸载 ${s.name}`);
    await reload();
    if (on && s.vars.some((v) => v.required)) openVars(K.data.skills.find((x) => x.id === s.id) ?? s);
  } catch (err) {
    toast(err.message);
  }
}

async function removeSkill(s) {
  const sure = await confirmDialog({
    title: s.mine ? `删除技能「${s.name}」？` : `下架「${s.name}」？`,
    message: s.mine
      ? `删除后找不回来${s.installs ? `，装了它的 ${s.installs} 个人也用不了了` : ""}。`
      : `这是 ${s.ownerName} 建的技能，下架会直接删除它，装了的人都用不了了。`,
    confirmText: s.mine ? "删除" : "下架",
    danger: true,
  });
  if (!sure) return;
  try {
    await api(`/api/skills/${s.id}`, { method: "DELETE" });
    toast("已删除");
    void reload();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 查看 ----------

async function openDetail(s) {
  const body = h("div", { class: "modal-body skill-detail" }, starsLoader());
  modal({ title: s.name, body, wide: true });
  let d;
  try {
    d = await api(`/api/skills/${s.id}`);
  } catch (err) {
    fill(body, h("div", { class: "error-text" }, err.message));
    return;
  }
  const filePreview = h("div", { class: "skill-file-preview" });
  fill(
    body,
    h(
      "div",
      { class: "task-meta" },
      h("span", {}, d.mine ? "我建的" : `${d.ownerName} 建的`),
      h("span", {}, `${VISIBILITY[d.visibility]}可见`),
      h("span", {}, `更新于 ${new Date(d.updatedAt).toLocaleString()}`),
    ),
    h("p", { class: "skill-desc" }, d.description),
    d.vars.length
      ? h(
          "div",
          { class: "skill-section" },
          h("h4", {}, "变量"),
          h(
            "ul",
            { class: "skill-vars" },
            d.vars.map((v) =>
              h(
                "li",
                {},
                h("code", {}, v.name),
                v.required ? h("span", { class: "badge" }, "必填") : null,
                v.secret ? h("span", { class: "badge" }, v.hosts?.length ? `受保护：只发往 ${v.hosts.join("、")}` : "密钥") : null,
                K.data.vars[v.name]?.set ? h("span", { class: "badge ok" }, "已填") : null,
                v.description ? h("span", { class: "skill-var-desc" }, v.description) : null,
              ),
            ),
          ),
          d.installed ? h("button", { class: "btn", onclick: () => openVars(d) }, "填写变量…") : null,
        )
      : null,
    h("div", { class: "skill-section" }, h("h4", {}, "SKILL.md"), h("div", { class: "skill-md" }, renderMarkdown(d.body))),
    d.files.length
      ? h(
          "div",
          { class: "skill-section" },
          h("h4", {}, `附带文件（${d.files.length}）`),
          h(
            "div",
            { class: "skill-files" },
            d.files.map((f) =>
              h(
                "button",
                {
                  class: "skill-file",
                  onclick: async () => {
                    try {
                      const r = await api(`/api/skills/${s.id}/file?path=${encodeURIComponent(f.path)}`);
                      fill(filePreview, h("div", { class: "skill-file-name" }, f.path), r.text === null ? h("div", { class: "skill-note" }, "二进制文件，不预览") : h("pre", {}, r.text));
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                },
                h("code", {}, f.path),
                h("span", {}, sizeText(f.size)),
              ),
            ),
          ),
          filePreview,
        )
      : null,
  );
}

async function openMachine(m) {
  const body = h("div", { class: "modal-body skill-detail" }, starsLoader());
  modal({ title: m.name, body, wide: true });
  try {
    const d = await api(`/api/skills/machine?name=${encodeURIComponent(m.name)}`);
    fill(body, h("div", { class: "task-meta" }, h("span", {}, d.dir)), h("pre", { class: "skill-raw" }, d.skillMd));
  } catch (err) {
    fill(body, h("div", { class: "error-text" }, err.message));
  }
}

function sizeText(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 变量 ----------

/** 填这个技能要用的变量。值按名字存，几个技能用同一个名字就共用一个值 */
function openVars(s) {
  const rows = s.vars.map((v) => {
    const cur = K.data.vars[v.name];
    const input = h("input", {
      type: v.secret ? "password" : "text",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: cur?.set ? (v.secret ? "已填写（不显示），留空不改" : "") : v.required ? "必填" : "可不填",
      value: cur?.value ?? "",
    });
    const clear = cur?.set ? h("button", { type: "button", class: "btn ghost", onclick: () => ((input.value = ""), (input.dataset.clear = "1"), (clear.hidden = true)) }, "清除") : null;
    // 受保护的密钥：agent 看不到值，只能经 agent-loft 发往这些地址；作者改了地址要这里再确认
    const guard = v.secret && v.hosts?.length
      ? h("small", { class: "skill-guard" }, `受保护：agent 看不到这个值，只能通过 agent-loft 代发请求，发往 ${(cur?.hosts?.length ? cur.hosts : v.hosts).join("、")}。填写即表示同意发往这些地址。`)
      : null;
    const r = { v, input, approve: false };
    const pending = cur?.pending?.length
      ? h(
          "div",
          { class: "skill-pending" },
          `作者新加了发送地址：${cur.pending.join("、")}。确认之前，这个密钥不会发往新地址。`,
          h("button", { type: "button", class: "btn small", onclick: (e) => ((r.approve = true), (e.currentTarget.textContent = "保存后生效"), (e.currentTarget.disabled = true)) }, "确认"),
        )
      : null;
    r.el = h("div", { class: "field" }, h("span", {}, h("code", {}, v.name), v.required ? " *" : ""), h("div", { class: "skill-var-row" }, input, clear), v.description ? h("small", {}, v.description) : null, guard, pending);
    return r;
  });
  const save = h("button", { class: "btn primary" }, "保存");
  const close = modal({
    title: `${s.name} 的变量`,
    body: h(
      "div",
      { class: "modal-body task-form" },
      h(
        "p",
        { class: "skill-note" },
        "只给你自己的会话用。普通变量在工作模式下作为环境变量注入，agent 能读到值；标了「受保护」的密钥 agent 看不到，只能让 agent-loft 代发到指定地址。几个技能用同一个变量名时共用一个值。",
      ),
      rows.map((r) => r.el),
    ),
    foot: h("div", { class: "modal-foot" }, save),
  });
  rows[0]?.input.focus();
  save.onclick = async () => {
    const values = {};
    for (const r of rows) {
      const val = r.input.value;
      if (r.input.dataset.clear === "1" && !val) values[r.v.name] = null;
      else if (val || !r.v.secret) {
        // 密钥留空 = 不改；普通变量留空 = 删掉
        if (val !== (K.data.vars[r.v.name]?.value ?? "")) values[r.v.name] = val || null;
      }
    }
    const approve = rows.filter((r) => r.approve).map((r) => r.v.name);
    // 什么都没改：别去存（存一次会让会话重新加载）
    if (!Object.keys(values).length && !approve.length) return close();
    save.disabled = true;
    try {
      await api("/api/skills/vars", { method: "PUT", body: { values, approve } });
      close();
      toast("已保存，新消息起生效");
      void reload();
    } catch (err) {
      save.disabled = false;
      toast(err.message);
    }
  };
}

// ---------- 新建 / 编辑 ----------

/** 谁能看到：仅自己 / 指定的人 / 所有人 */
function visibilityPicker(cur) {
  const state = { visibility: cur?.visibility ?? "private", sharedWith: new Set(cur?.sharedWith ?? []) };
  const users = K.data.users;
  const select = h(
    "select",
    {},
    Object.entries(VISIBILITY).map(([v, label]) =>
      h("option", { value: v, selected: v === state.visibility, disabled: v === "users" && users.length === 0 }, v === "all" ? "所有人（出现在技能广场）" : label),
    ),
  );
  const people = h(
    "div",
    { class: "skill-people" },
    users.map((u) => {
      const box = h("input", { type: "checkbox", checked: state.sharedWith.has(u.id) });
      box.onchange = () => (box.checked ? state.sharedWith.add(u.id) : state.sharedWith.delete(u.id));
      return h("label", { class: "skill-person" }, box, u.name);
    }),
  );
  const sync = () => {
    state.visibility = select.value;
    people.hidden = select.value !== "users";
  };
  select.onchange = sync;
  sync();
  return {
    el: h("div", { class: "skill-visibility" }, select, people),
    value: () => ({ visibility: state.visibility, sharedWith: [...state.sharedWith] }),
  };
}

/** 变量声明的编辑器：一行一个 */
function varsEditor(list) {
  const rows = [];
  const box = h("div", { class: "skill-var-edit" });
  const add = (v = {}) => {
    const name = h("input", { value: v.name ?? "", placeholder: "变量名，如 WEATHER_API_KEY", spellcheck: "false" });
    name.oninput = () => (name.value = name.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"));
    const desc = h("input", { value: v.description ?? "", placeholder: "说明：是什么、去哪拿" });
    const secret = h("input", { type: "checkbox", checked: !!v.secret });
    const required = h("input", { type: "checkbox", checked: !!v.required });
    // 密钥才有：填了允许的地址就是受保护的密钥
    const hosts = h("input", {
      value: (v.hosts ?? []).join(", "),
      placeholder: "可不填。填了就受保护，比如 api.example.com, 192.168.8.2:8080",
      spellcheck: "false",
      title: "填了就受保护：不进环境变量，agent 看不到值，只能让 agent-loft 代发到这些地址",
    });
    const hostsLine = h("label", { class: "skill-var-hosts" }, h("span", {}, "只允许发往"), hosts);
    const syncHosts = () => (hostsLine.hidden = !secret.checked);
    secret.onchange = syncHosts;
    syncHosts();
    const row = h(
      "div",
      { class: "skill-var-item" },
      h(
        "div",
        { class: "skill-var-line" },
        name,
        desc,
        h("label", {}, secret, "密钥"),
        h("label", {}, required, "必填"),
        h("button", { type: "button", class: "icon-btn", title: "删掉", onclick: () => (row.remove(), rows.splice(rows.indexOf(r), 1)) }, icon("x")),
      ),
      hostsLine,
    );
    const r = { name, desc, secret, required, hosts };
    rows.push(r);
    box.append(row);
  };
  for (const v of list ?? []) add(v);
  return {
    el: h("div", {}, box, h("button", { type: "button", class: "btn ghost", onclick: () => add() }, icon("plus"), "加一个变量")),
    value: () =>
      rows
        .filter((r) => r.name.value.trim())
        .map((r) => ({
          name: r.name.value.trim(),
          description: r.desc.value.trim(),
          secret: r.secret.checked,
          required: r.required.checked,
          ...(r.secret.checked && r.hosts.value.trim() ? { hosts: r.hosts.value.split(/[\s,，、]+/).filter(Boolean) } : {}),
        })),
  };
}

const BODY_TEMPLATE = `## 什么时候用

（用户要做什么的时候用这个技能）

## 怎么做

1. 第一步……
2. 调接口的例子：\`curl -H "Authorization: Bearer $MY_API_KEY" https://example.com/api\`

## 注意

- 不要把密钥打印出来`;

/** s：编辑这个（自己的）；不给就是新建。preset：上传后预填 */
async function openEditor(s) {
  let d = null;
  if (s) {
    try {
      d = await api(`/api/skills/${s.id}`);
    } catch (err) {
      return toast(err.message);
    }
  }
  const name = h("input", { value: d?.name ?? "", placeholder: "小写字母、数字和 -，比如 weather-report", spellcheck: "false", disabled: !!d });
  const desc = h("textarea", { rows: 2, maxlength: "1024", placeholder: "一两句话说清什么时候用它。agent 靠这句话判断要不要用这个技能。" });
  desc.value = d?.description ?? "";
  const body = h("textarea", { rows: 14, class: "skill-body-input", spellcheck: "false", placeholder: "写给 agent 的操作说明（Markdown）" });
  body.value = d?.body ?? (s ? "" : BODY_TEMPLATE);
  const vars = varsEditor(d?.vars);
  const vis = visibilityPicker(d);
  const save = h("button", { class: "btn primary" }, d ? "保存" : "创建");
  const close = modal({
    title: d ? `编辑 ${d.name}` : "新建技能",
    wide: true,
    tall: true,
    body: h(
      "div",
      { class: "modal-body task-form" },
      field("名字", name, d ? "建好后不能改。输入框里用 @名字 点名使用。" : "全站唯一，建好后不能改。输入框里用 @名字 点名使用。"),
      field("说明", desc),
      field("正文（SKILL.md）", body, d?.files?.length ? `另有 ${d.files.length} 个附带文件，要改的话用「用文件替换」上传整个包。` : "可以引用同目录下的脚本、资料（上传技能包时一起带上）。"),
      field(
        "变量",
        vars.el,
        "要调的接口地址、密钥之类，每个人填自己的值。普通变量注入到他自己的会话环境里，正文里用 $变量名 引用；密钥再填上「只允许发往」的地址就受保护：agent 看不到值，正文里写成让 agent 用 skill_request 工具发请求、在地址或请求头里写 {{变量名}}。",
      ),
      field("谁能看到", vis.el, "看得到的人可以在技能广场安装。你以后改了，装了的人也跟着用新的。"),
    ),
    foot: h("div", { class: "modal-foot" }, save),
  });
  (d ? desc : name).focus();
  save.onclick = async () => {
    const payload = { description: desc.value, body: body.value, vars: vars.value(), ...vis.value() };
    save.disabled = true;
    try {
      if (d) await api(`/api/skills/${d.id}`, { method: "PATCH", body: payload });
      else await api("/api/skills", { method: "POST", body: { name: name.value.trim().toLowerCase(), ...payload } });
      close();
      toast(d ? "已保存" : "已创建");
      if (S.view === "skills") void reload();
      else void openSkills();
    } catch (err) {
      save.disabled = false;
      toast(err.message);
    }
  };
}

function field(label, input, hint) {
  return h("div", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}

// ---------- 上传 ----------

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * 上传技能：压缩包（.zip / .skill）、单个 SKILL.md，或者整个文件夹。target 给了就是替换那个技能的内容。
 * 新建的先设成「仅自己」，传完打开编辑框让人确认说明、变量和分享范围。
 */
function pickUpload(target) {
  const choose = (folder) => {
    const input = h("input", { type: "file", style: { display: "none" }, ...(folder ? { webkitdirectory: true, multiple: true } : { accept: ".zip,.skill,.md" }) });
    input.onchange = () => {
      const files = [...input.files];
      input.remove();
      if (files.length) void upload(files, target);
    };
    document.body.append(input);
    input.click();
  };
  const close = modal({
    title: target ? `用文件替换 ${target.name}` : "上传技能",
    body: h(
      "div",
      { class: "modal-body" },
      h("p", { class: "skill-note" }, "技能包里要有 SKILL.md（开头的 frontmatter 写 name 和 description），可以带脚本、模板等文件。要声明变量的话，放一个 agent-loft.json：{ \"vars\": [{ \"name\": \"MY_API_KEY\", \"secret\": true, \"required\": true }] }。"),
      target ? h("p", { class: "skill-note" }, "替换后名字不变，包里写的 name 会被忽略；装了它的人会跟着用新的。") : null,
      h(
        "div",
        { class: "skill-upload-btns" },
        h("button", { class: "btn primary", onclick: () => (close(), choose(false)) }, "选压缩包或 SKILL.md"),
        h("button", { class: "btn", onclick: () => (close(), choose(true)) }, "选文件夹"),
      ),
    ),
  });
}

async function upload(files, target) {
  let payload;
  try {
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > 10 * 1024 * 1024) throw new Error("太大了（最多 10MB）");
    const one = files.length === 1 ? files[0] : null;
    if (one && /\.(zip|skill)$/i.test(one.name)) payload = { zip: toBase64(await one.arrayBuffer()) };
    else {
      const list = [];
      for (const f of files) {
        // 选文件夹时带相对路径；单个 SKILL.md 就叫 SKILL.md
        const rel = f.webkitRelativePath || (one ? "SKILL.md" : f.name);
        list.push({ path: rel, data: toBase64(await f.arrayBuffer()) });
      }
      payload = { files: list };
    }
  } catch (err) {
    return toast(err.message);
  }
  toast("上传中…", 1500);
  try {
    if (target) {
      await api(`/api/skills/${target.id}`, { method: "PATCH", body: { upload: payload } });
      toast(`已替换 ${target.name}`);
      void reload();
      return;
    }
    const s = await api("/api/skills", { method: "POST", body: { upload: payload, visibility: "private" } });
    toast(`已导入 ${s.name}，现在只有你自己看得到`);
    if (S.view === "skills") await reload();
    else await openSkills();
    await openEditor(s);
  } catch (err) {
    toast(err.message);
  }
}

