import { agentIcon, fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { S, ui } from "../state.js";
import { agentLabel, convTitle, renderSidebar } from "./sidebar.js";
import { agentCatalog, baseName, catalogDefaults, draftPick, modelName, renderContext, renderTopbar, saveDraftPick, visibleModels } from "./topbar.js";
import { closeMenu, confirmDialog, modal, placePopover, showPopover } from "../lib/overlay.js";
import { newDraft, openConversation, renderEmpty } from "./messages.js";

// ---------- 会话操作 ----------

export async function doAction(action, value, extra = {}) {
  if (!S.current) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(S.current)}/action`, {
      method: "POST",
      body: { action, value, ...extra },
    });
    S.convs.set(res.info.key, res.info);
    renderTopbar();
    toast(res.text);
    if (["new", "fork", "resume", "agent", "cd"].includes(action)) await openConversation(S.current);
    return res;
  } catch (err) {
    toast(err.message);
  }
}

/** 分叉成一条新对话（anchor 给了就到那条回复为止），然后切过去。原对话不动 */
export async function forkConversation(anchor, key = S.current) {
  if (!key) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(key)}/fork`, {
      method: "POST",
      body: anchor ? { anchor } : {},
    });
    S.convs.set(res.info.key, res.info);
    toast("已分叉成新对话，原对话保留");
    await openConversation(res.info.key);
  } catch (err) {
    toast(err.message);
  }
}

export async function switchAgent(id) {
  if (!S.current) {
    S.draftAgent = id;
    localStorage.setItem("aim.agent", id);
    renderTopbar();
    renderEmpty();
    return;
  }
  await doAction("agent", id);
}

/** 模型 / 思考程度选择：已有会话直接切，新对话先记下，发第一条消息时带过去 */
export async function openModelPicker(anchor = ui.modelSlot) {
  if (!anchor) return;
  if (ui.menu?.dataset.for === "model") return closeMenu();
  const pop = showPopover(anchor);
  pop.dataset.for = "model";
  pop.classList.add("model-pop");
  fill(pop, h("div", { class: "pop-loading" }, h("span", { class: "spinner" })));
  placePopover(pop, anchor);

  const conv = S.current ? S.convs.get(S.current) : null;
  let models;
  let current;
  let currentEffort;
  let effortSupported = true;
  try {
    if (conv) {
      // 顺便把这个 agent 的默认模型 / 显示名准备好（缓存过就不会再请求）
      const [data] = await Promise.all([
        api(`/api/conversations/${encodeURIComponent(S.current)}/models`),
        agentCatalog(conv.agent).catch(() => []),
      ]);
      ({ models, current, currentEffort, effortSupported } = data);
    } else {
      models = await agentCatalog(S.draftAgent);
      const pick = draftPick();
      current = pick.model ?? (models.find((m) => m.isDefault) ?? models.find((m) => m.id === "default"))?.id;
      currentEffort = pick.effort;
    }
  } catch (err) {
    if (ui.menu === pop) fill(pop, h("div", { class: "pop-error" }, err.message));
    return;
  }
  if (ui.menu !== pop) return;

  const choose = async (kind, value) => {
    if (kind === "model") current = value;
    else currentEffort = value;
    if (conv) {
      await doAction(kind, value);
    } else {
      draftPick()[kind] = value;
      saveDraftPick();
      renderContext();
    }
    if (kind === "effort") closeMenu();
    else if (ui.menu === pop) render();
  };

  const agent = conv ? conv.agent : S.draftAgent;
  // 当前值可能是别名、完整名或空（默认）：先按 id 对，对不上再按显示名对，只勾一项
  const currentItem = (list) => {
    const byId = list.find((m) => m.id === current);
    if (byId) return byId;
    const name = modelName(agent, current);
    return list.find((m) => m.id !== "default" && (m.label || m.id) === name) ?? null;
  };

  function render() {
    const shown = visibleModels(agent, models);
    const on = currentItem(shown);
    const efforts = (on ?? currentItem(models))?.efforts ?? models.find((m) => m.efforts?.length)?.efforts ?? [];
    if (!currentEffort) currentEffort = catalogDefaults.get(agent)?.effort;
    fill(
      pop,
      h("div", { class: "pop-head" }, "模型"),
      shown.map((m) =>
        h(
          "button",
          { class: `pop-item${m === on ? " on" : ""}`, onclick: () => void choose("model", m.id) },
          h("span", { class: "grow" }, h("span", { class: "t" }, m.label || m.id), m.description ? h("span", { class: "s" }, m.description) : null),
          m === on ? h("span", { class: "check" }, "✓") : null,
        ),
      ),
      effortSupported && efforts.length
        ? [
            h("div", { class: "sep" }),
            h("div", { class: "pop-head" }, "思考程度"),
            h(
              "div",
              { class: "effort-seg" },
              efforts.map((e) => h("button", { class: e === currentEffort ? "on" : "", onclick: () => void choose("effort", e) }, e)),
            ),
          ]
        : null,
    );
    placePopover(pop, anchor);
  }
  render();
}

export async function openSessions(all) {
  const body = h("div", { class: "modal-body" }, h("span", { class: "spinner" }));
  const close = modal({ title: "历史会话", body });
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(S.current)}/sessions${all ? "?all=1" : ""}`);
    fill(body, 
      h(
        "div",
        { class: "muted" },
        data.allDirs ? (data.fellBack ? `${data.cwd} 下没有历史会话，已列出所有目录的` : "所有目录的最近会话") : `目录 ${data.cwd}`,
        !data.allDirs
          ? h(
              "button",
              {
                class: "btn small",
                style: { marginLeft: "8px" },
                onclick: () => {
                  close();
                  void openSessions(true);
                },
              },
              "看所有目录",
            )
          : null,
      ),
      ...(data.sessions.length === 0
        ? [h("div", { class: "muted" }, "还没有历史会话")]
        : data.sessions.map((s) =>
            h(
              "button",
              {
                class: `list-item${s.id === data.current ? " on" : ""}`,
                onclick: async () => {
                  if (s.id === data.current) return;
                  close();
                  await doAction("resume", s.id, s.cwd ? { cwd: s.cwd } : {});
                },
              },
              h(
                "div",
                { class: "grow" },
                h("div", { class: "t" }, s.title),
                h("div", { class: "s" }, `${relTime(s.updatedAt)}${data.allDirs && s.cwd ? ` · ${s.cwd}` : ""}`),
              ),
              s.id === data.current ? "当前" : null,
            ),
          )),
    );
  } catch (err) {
    fill(body, h("div", { class: "error-text" }, err.message));
  }
}

/** 目录选择器：一层层点进去选，也能手动输入。只能在 workspaceRoot 之内 */
export async function changeCwd() {
  // 还没发消息的新对话：只记下选择，创建会话时带过去
  const draft = !S.current;
  const conv = draft ? null : S.convs.get(S.current);
  const current = draft ? (S.draftCwd ?? S.workspaceRoot ?? "") : (conv?.cwd ?? "");
  const goLabel = draft ? "使用此目录" : "切换到此目录";
  let showHidden = localStorage.getItem("aim.cwdHidden") === "1";
  let listing = null;
  let seq = 0;

  const crumbs = h("div", { class: "dir-crumbs" });
  const list = h("div", { class: "dir-list" });
  const hiddenBox = h("input", { type: "checkbox", checked: showHidden });
  hiddenBox.onchange = () => {
    showHidden = hiddenBox.checked;
    localStorage.setItem("aim.cwdHidden", showHidden ? "1" : "0");
    renderList();
  };
  const manual = h("input", { class: "dir-manual", placeholder: "或直接输入路径（相对工作区，回车跳转）" });
  manual.onkeydown = (e) => {
    if (e.key === "Enter" && manual.value.trim()) {
      e.preventDefault();
      void load(manual.value.trim());
    }
  };
  const body = h(
    "div",
    { class: "modal-body" },
    crumbs,
    h("div", { class: "row", style: { gap: "8px", alignItems: "center" } }, manual, h("label", { class: "check" }, hiddenBox, "显示隐藏")),
    list,
  );
  const go = h("button", { class: "btn primary", disabled: true }, goLabel);
  const note = h("span", { class: "muted grow" }, draft ? "发送第一条消息时在这个目录开会话" : "切换后开新会话");
  const close = modal({
    title: draft ? "选择工作目录" : "切换工作目录",
    body,
    foot: h("div", { class: "modal-foot", style: { alignItems: "center" } }, note, go),
  });

  go.onclick = async () => {
    if (!listing) return;
    close();
    if (draft) {
      S.draftCwd = listing.path === listing.root ? null : listing.path;
      if (!S.current) renderEmpty();
      return;
    }
    await doAction("cd", listing.path);
  };

  function renderCrumbs() {
    const parts = listing.rel ? listing.rel.split(/[\\/]/) : [];
    const rootName = listing.root.split(/[\\/]/).filter(Boolean).pop() || listing.root;
    const items = [h("button", { class: "crumb", title: listing.root, onclick: () => load("") }, rootName)];
    parts.forEach((name, i) => {
      items.push(h("span", { class: "crumb-sep" }, "/"));
      const rel = parts.slice(0, i + 1).join("/");
      items.push(h("button", { class: "crumb", onclick: () => load(rel) }, name));
    });
    fill(crumbs, items);
  }

  function renderList() {
    if (!listing) return;
    const join = (name) => (listing.rel ? `${listing.rel}/${name}` : name);
    const dirs = listing.dirs.filter((d) => showHidden || !d.hidden);
    const hiddenCount = listing.dirs.length - dirs.length;
    fill(
      list,
      listing.rel
        ? h(
            "button",
            { class: "list-item dir-item", onclick: () => load(listing.rel.split(/[\\/]/).slice(0, -1).join("/")) },
            h("span", { class: "dir-icon" }, "↩"),
            h("div", { class: "grow" }, h("div", { class: "t" }, "..")),
          )
        : null,
      dirs.length === 0 ? h("div", { class: "muted" }, hiddenCount ? `没有子目录（${hiddenCount} 个隐藏目录未显示）` : "没有子目录") : null,
      dirs.map((d) => {
        const abs = `${listing.path.replace(/[\\/]+$/, "")}/${d.name}`;
        const isCurrent = abs === current;
        return h(
          "button",
          { class: `list-item dir-item${isCurrent ? " on" : ""}`, onclick: () => load(join(d.name)) },
          h("span", { class: "dir-icon" }, "📁"),
          h("div", { class: "grow" }, h("div", { class: "t" }, d.name)),
          isCurrent ? h("span", { class: "muted" }, "当前") : current.startsWith(`${abs}/`) ? h("span", { class: "muted" }, "当前在内") : null,
          h("span", { class: "dir-chev" }, "›"),
        );
      }),
      listing.truncated ? h("div", { class: "muted" }, "子目录太多，只列出了一部分，可以手动输入路径") : null,
    );
  }

  async function load(rel) {
    const my = ++seq;
    go.disabled = true;
    fill(list, h("span", { class: "spinner" }));
    try {
      const data = await api(`/api/dirs?path=${encodeURIComponent(rel)}`);
      if (my !== seq) return;
      listing = data;
      manual.value = "";
      go.disabled = false;
      go.textContent = data.path === current ? "已是当前目录" : goLabel;
      if (data.path === current) go.disabled = true;
      renderCrumbs();
      renderList();
    } catch (err) {
      if (my !== seq) return;
      if (!listing) {
        fill(list, h("div", { class: "error-text" }, err.message));
        return;
      }
      // 进不去就留在原地
      toast(err.message);
      go.disabled = listing.path === current;
      renderList();
    }
  }

  // 从当前目录开始（在工作区之内的话），否则从根目录开始
  const root = S.workspaceRoot ?? "";
  const startRel = root && (current === root || current.startsWith(`${root.replace(/[\\/]+$/, "")}/`)) ? current.slice(root.replace(/[\\/]+$/, "").length + 1) : "";
  await load(startRel);
}

/** 重命名：小弹窗，回车保存、Esc 取消，打开时全选原名 */
export function renameConv(key = S.current) {
  const c = S.convs.get(key);
  if (!c) return;
  const input = h("input", { class: "rename-input", value: convTitle(c), maxlength: "120", spellcheck: "false" });
  const save = h("button", { class: "btn primary" }, "保存");
  const cancel = h("button", { class: "btn ghost" }, "取消");
  const close = () => {
    overlay.classList.add("leaving");
    setTimeout(() => overlay.remove(), 120);
    document.removeEventListener("keydown", onKey, true);
  };
  const submit = async () => {
    const title = input.value.trim();
    if (!title || title === convTitle(c)) return close();
    save.disabled = true;
    try {
      const info = await api(`/api/conversations/${encodeURIComponent(key)}`, { method: "PATCH", body: { title } });
      S.convs.set(info.key, info);
      renderSidebar();
      if (key === S.current) renderTopbar();
      close();
    } catch (err) {
      save.disabled = false;
      toast(err.message);
    }
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && !e.isComposing && document.activeElement === input) {
      e.preventDefault();
      void submit();
    }
  };
  save.onclick = () => void submit();
  cancel.onclick = close;
  const overlay = h(
    "div",
    { class: "overlay dialog-overlay", onclick: (e) => e.target === overlay && close() },
    h(
      "div",
      { class: "dialog" },
      h("h3", {}, "重命名会话"),
      h("p", { class: "dialog-sub" }, agentIcon(c.agent), h("span", {}, `${agentLabel(c.agent)} · ${baseName(c.cwd)}`)),
      input,
      h("div", { class: "dialog-foot" }, cancel, save),
    ),
  );
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  input.focus();
  input.select();
}

export async function deleteConv(key = S.current) {
  if (!key) return;
  const c = S.convs.get(key);
  const sure = await confirmDialog({
    title: "删除会话？",
    sub: c ? [agentIcon(c.agent), h("span", {}, `${convTitle(c)} · ${baseName(c.cwd)}`)] : null,
    message: "只从列表里移除，agent 那边的会话记录还在。",
    confirmText: "删除",
    danger: true,
  });
  if (!sure) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (c) c.hidden = true;
    if (key === S.current) newDraft();
    else renderSidebar();
  } catch (err) {
    toast(err.message);
  }
}
