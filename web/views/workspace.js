// 工作区面板：对话右边的一栏（手机上全屏），看和改工作目录里的文件，看 Git 改动。
//
// 三个页签：「文件」是一棵按需展开的树，「改动」是 git status 的结果（能暂存、丢弃、提交、切分支），
// 「历史」是提交记录。点进去都是详情页（预览 / 编辑 / diff），有返回键：面板不宽，树和内容放不下并排。
//
// 编辑：保存时带着读出来时的 hash，文件被 agent 或别人改过就不覆盖，让用户选（见 saveEdit）。
// 没保存的内容随时存一份在本机（见「草稿」），换会话、刷新页面都不丢，再打开这个文件时恢复。
// 接口见 channels/web/workspace-api.ts；分支标记和状态刷新在 views/workspace-entry.js。
import { fill, h, icon, starsLoader, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { closeMenu, confirmDialog, modal, placePopover, showMenu, showPopover } from "../lib/overlay.js";
import { relTime } from "../lib/time.js";
import { S, ui } from "../state.js";
import { editableName, fmtSize, renderFileView, textPreview } from "./file-preview.js";
import { renderDiff } from "./diff-view.js";
import { createEditor } from "./file-editor.js";
import { git, refreshGit, rememberOpen } from "./workspace-entry.js";

const WIDTH_KEY = "aim.wsW";
const MODE_KEY = "aim.wsDiffMode";
const MIN_WIDTH = 300;
/** 面板比这窄就不给并排了 */
const SPLIT_MIN_WIDTH = 640;

const P = {
  open: false,
  tab: "files",
  /** 这份状态是哪条会话、哪个目录的；换了就清空 */
  id: null,
  /** 相对路径 → 目录内容（已经加载的） */
  tree: new Map(),
  expanded: new Set([""]),
  treeError: null,
  /** 详情页：null / { kind: "file", path, from } / { kind: "edit", path, from } / { kind: "turn", changes, turnState, from } / { kind: "commit", commit, files, from } / { kind: "diff", path, staged, oldPath, turn, commit, from } */
  detail: null,
  /** 正在编辑：{ key, path, name, hash, saved, editor, host, previewEl, saving, loadError } */
  edit: null,
  /** 提交历史：{ commits, more, error }，切到页签时才拉 */
  log: null,
  /** 详情页的内容：diff 接口的结果 */
  diff: null,
  diffError: null,
  diffMode: localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified",
  loadToken: 0,
};

const base = () => `/api/conversations/${encodeURIComponent(S.current)}`;
const fileUrl = (rel) => `${base()}/workspace-file?path=${encodeURIComponent(rel)}`;
const pageUrl = (rel) => `${base()}/workspace-html?path=${encodeURIComponent(rel)}`;
const usable = () => !!S.current && !S.view;
const conversationId = () => (usable() ? `${S.current}\n${S.convs.get(S.current)?.cwd ?? ""}` : null);

// ---------- 面板 ----------

function ensurePanel() {
  if (ui.wsPanel) return;
  ui.wsTabs = h("div", { class: "ws-tabs", role: "tablist" });
  ui.wsBody = h("div", { class: "ws-body" });
  ui.wsPanel = h(
    "aside",
    { class: "ws-panel", hidden: true, "aria-label": "工作区" },
    h("div", { class: "ws-resizer", title: "拖动调整宽度，双击恢复默认", onpointerdown: startResize, ondblclick: () => setWidth(null) }),
    h(
      "div",
      { class: "ws-head" },
      ui.wsTabs,
      h("span", { class: "grow" }),
      h("button", { class: "icon-btn", title: "刷新", "aria-label": "刷新", onclick: () => void reload() }, icon("refresh")),
      h("button", { class: "icon-btn", title: "关闭", "aria-label": "关闭工作区", onclick: () => hidePanel() }, icon("x")),
    ),
    ui.wsBody,
  );
  ui.layout.append(ui.wsPanel);
  bindPanelDrop(ui.wsPanel);
  setWidth(Number(localStorage.getItem(WIDTH_KEY)) || null);
}

function setWidth(px) {
  if (px) {
    ui.wsPanel.style.setProperty("--ws-w", `${Math.round(px)}px`);
    localStorage.setItem(WIDTH_KEY, String(Math.round(px)));
  } else {
    ui.wsPanel.style.removeProperty("--ws-w");
    localStorage.removeItem(WIDTH_KEY);
  }
}

function startResize(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const right = ui.wsPanel.getBoundingClientRect().right;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("side-resizing");
  const move = (ev) => setWidth(Math.max(MIN_WIDTH, right - ev.clientX));
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    document.body.classList.remove("side-resizing");
    // 宽窄变了，并排还能不能用要重新判断
    if (P.detail?.kind === "diff") renderBody();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

export async function showPanel(tab) {
  ensurePanel();
  P.open = true;
  rememberOpen(true);
  const fresh = syncPanel();
  // 换页签会离开编辑页，没保存的要问一下。留下的话页签就不换了
  if (tab && tab !== P.tab && (await leaveEdit())) {
    P.tab = tab;
    P.detail = null;
  }
  render();
  if (!fresh && !P.tree.has("")) void loadTree("");
}

function hidePanel() {
  P.open = false;
  rememberOpen(false);
  syncPanel();
}

export function togglePanel() {
  if (P.open && usable()) hidePanel();
  else void showPanel();
}

/** 打开工作目录里的一个文件（相对路径） */
export async function openFile(rel) {
  await showPanel();
  if (!(await leaveEdit())) return;
  P.tab = "files";
  renderTabs();
  openDetail({ kind: "file", path: rel, from: null });
}

/** 打开某一轮的改动。file：直接看这个文件的 diff，返回时是这一轮的文件列表 */
export async function openTurn(changes, file) {
  await showPanel();
  if (!(await leaveEdit())) return;
  P.tab = "changes";
  renderTabs();
  const list = { kind: "turn", changes, from: null };
  if (file) openDetail(turnDiffDetail(changes, file, list));
  else openDetail(list);
}

/** 换了会话、切到别的页面：内容清掉重新来，面板跟着显示 / 藏起来。重新加载了返回 true */
export function syncPanel() {
  if (!ui.wsPanel) return false;
  ui.wsPanel.hidden = !P.open || !usable();
  const id = conversationId();
  if (id && id !== P.id) {
    if (P.edit) {
      if (editDirty()) {
        flushDraft();
        toast("没保存的修改已留在这台设备上，回到这条对话打开文件时会恢复");
      }
      dropEditor();
    }
    P.id = id;
    P.tree = new Map();
    P.expanded = new Set([""]);
    P.treeError = null;
    P.detail = null;
    P.diff = null;
    P.log = null;
    // 写给上一个仓库的提交说明，不能留着提交到这一个
    if (commitUi.message) commitUi.message.value = "";
    if (P.open) {
      void loadTree("");
      render();
      return true;
    }
  }
  return false;
}

/** 手动刷新：文件树、Git 状态，打开着的详情也重新拿 */
async function reload() {
  P.log = null;
  await Promise.all([reloadTree(), refreshGit()]);
  if (P.detail?.kind === "file") render();
}

async function reloadTree() {
  await Promise.all([...P.expanded].map((dir) => loadTree(dir)));
}

// 一轮结束、Git 状态刷新了：跟着更新看得到的东西
document.addEventListener("aim:git", () => {
  if (!P.open || !usable()) return;
  void reloadTree();
  if (P.tab === "log" && !git.status?.repo) P.tab = "changes";
  renderTabs();
  // 某一轮、某个提交的 diff 是定死的，不用重新拿
  if (P.detail?.kind === "diff" && !P.detail.turn && !P.detail.commit) void loadDiff();
  // 撤销状态看的是工作区现在的样子
  else if (P.detail?.kind === "turn") void loadTurnState(P.detail);
  // 正在看的文件不自动重画：视频、网页会从头开始。要看新内容点刷新
  else if (!P.detail) renderBody();
});

// ---------- 画 ----------

function renderTabs() {
  const count = git.status?.repo ? git.status.files.length : 0;
  fill(ui.wsTabs, tabButton("files", "文件"), tabButton("changes", "改动", count), git.status?.repo ? tabButton("log", "历史") : null);
}

function render() {
  if (!ui.wsPanel || ui.wsPanel.hidden) return;
  renderTabs();
  renderBody();
}

function tabButton(id, label, count = 0) {
  return h(
    "button",
    {
      class: `ws-tab${P.tab === id ? " on" : ""}`,
      role: "tab",
      "aria-selected": P.tab === id ? "true" : "false",
      onclick: async () => {
        if (!(await leaveEdit())) return;
        P.tab = id;
        P.detail = null;
        render();
      },
    },
    label,
    count ? h("span", { class: "ws-tab-count" }, count) : null,
  );
}

function renderBody() {
  if (P.detail) return renderDetail();
  if (P.tab === "files") return renderTree();
  if (P.tab === "log") return renderLog();
  renderChanges();
}

// ---------- 小弹窗 ----------

/** 输入名字的弹窗。submit 抛错就提示、弹窗留着；selectStem：选中时不带后缀，改名时直接打字不会把后缀改掉 */
function promptName({ title, value = "", confirmText = "确定", selectStem = false, submit }) {
  const input = h("input", { class: "rename-input", value, maxlength: "255", spellcheck: "false", autocapitalize: "off", autocomplete: "off" });
  const ok = h("button", { class: "btn primary" }, confirmText);
  const go = async () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    ok.disabled = true;
    try {
      await submit(name);
      close();
    } catch (err) {
      ok.disabled = false;
      toast(err.message);
      input.focus();
    }
  };
  ok.onclick = () => void go();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void go();
    }
  });
  const close = modal({
    title,
    body: h("div", { class: "modal-body" }, input),
    foot: h("div", { class: "modal-foot" }, h("button", { class: "btn ghost", onclick: () => close() }, "取消"), ok),
  });
  input.focus();
  const dot = value.lastIndexOf(".");
  input.setSelectionRange(0, selectStem && dot > 0 ? dot : value.length);
}

const loading = () => h("div", { class: "ws-empty" }, starsLoader());
const emptyNote = (...text) => h("div", { class: "ws-empty" }, ...text);

// ---------- 文件树 ----------

async function loadTree(rel) {
  const id = P.id;
  try {
    const listing = await api(`${base()}/workspace-tree?path=${encodeURIComponent(rel)}`);
    if (id !== P.id) return;
    P.tree.set(rel, listing);
    if (!rel) P.treeError = null;
  } catch (err) {
    if (id !== P.id) return;
    P.tree.delete(rel);
    // 目录没了：不再当它展开着
    if (rel) P.expanded.delete(rel);
    else P.treeError = err.message;
  }
  if (!P.detail && P.tab === "files") renderTree();
}

function toggleDir(rel) {
  if (P.expanded.has(rel)) P.expanded.delete(rel);
  else {
    P.expanded.add(rel);
    if (!P.tree.has(rel)) void loadTree(rel);
  }
  renderTree();
}

const parentOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/** 改了文件之后：这一层重新列出来，Git 状态也变了（刷新 Git 时整棵树都会跟着对一遍） */
async function afterChange(dir) {
  await loadTree(dir);
  void refreshGit();
}

function newEntry(dir, type) {
  promptName({
    title: type === "dir" ? "新建文件夹" : "新建文件",
    confirmText: "新建",
    submit: async (name) => {
      const created = await api(`${base()}/workspace-new`, { method: "POST", body: { dir, name, type } });
      if (dir) P.expanded.add(dir);
      await afterChange(dir);
      if (type === "dir") P.expanded.add(created.path);
      else openEditor(created.path, null);
    },
  });
}

function renameEntry(entry) {
  promptName({
    title: "重命名",
    value: entry.name,
    confirmText: "重命名",
    selectStem: entry.type !== "dir",
    submit: async (name) => {
      if (name === entry.name) return;
      const renamed = await api(`${base()}/workspace-rename`, { method: "POST", body: { path: entry.path, name } });
      // 展开着的目录跟着换名字
      for (const dir of [...P.expanded]) {
        if (dir === entry.path || dir.startsWith(`${entry.path}/`)) {
          P.expanded.delete(dir);
          P.tree.delete(dir);
          P.expanded.add(renamed.path + dir.slice(entry.path.length));
        }
      }
      await afterChange(parentOf(entry.path));
    },
  });
}

async function deleteEntry(entry) {
  const dir = entry.type === "dir" && !entry.link;
  const sure = await confirmDialog({
    title: `删除「${entry.name}」？`,
    message: dir
      ? "文件夹里的所有内容都会被删除，包括面板里看不到的隐藏文件、敏感文件和 .git 目录。删除后不能恢复。"
      : entry.link
        ? "只删除这个链接，它指向的内容不受影响。"
        : "删除后不能恢复。被 Git 跟踪的文件可以用 Git 找回最后一次提交的版本。",
    confirmText: "删除",
    danger: true,
  });
  if (!sure) return;
  try {
    await api(`${base()}/workspace-delete`, { method: "POST", body: { path: entry.path } });
  } catch (err) {
    return toast(err.message);
  }
  for (const open of [...P.expanded]) {
    if (open === entry.path || open.startsWith(`${entry.path}/`)) {
      P.expanded.delete(open);
      P.tree.delete(open);
    }
  }
  await afterChange(parentOf(entry.path));
}

function pickFiles(dir) {
  const input = h("input", { type: "file", multiple: true });
  input.onchange = () => void uploadFiles(dir, [...input.files]);
  input.click();
}

async function uploadFiles(dir, files) {
  let done = 0;
  for (const file of files) {
    const url = (overwrite) => `${base()}/workspace-upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}${overwrite ? "&overwrite=1" : ""}`;
    try {
      await api(url(false), { method: "POST", body: file });
      done++;
    } catch (err) {
      if (err.data?.conflict !== "exists") {
        toast(`「${file.name}」上传失败：${err.message}`);
        continue;
      }
      const sure = await confirmDialog({ title: `「${file.name}」已经存在，要覆盖吗？`, message: "原来的文件会被替换，不能恢复。", confirmText: "覆盖", danger: true });
      if (!sure) continue;
      try {
        await api(url(true), { method: "POST", body: file });
        done++;
      } catch (again) {
        toast(`「${file.name}」上传失败：${again.message}`);
      }
    }
  }
  if (done) toast(`已上传 ${done} 个文件`);
  if (dir) P.expanded.add(dir);
  await afterChange(dir);
}

function entryMenu(entry, at) {
  const items = [];
  if (entry.type === "dir") {
    items.push(
      { label: "新建文件", onclick: () => newEntry(entry.path, "file") },
      { label: "新建文件夹", onclick: () => newEntry(entry.path, "dir") },
      { label: "上传到这里", onclick: () => pickFiles(entry.path) },
    );
  } else {
    if (editableName(entry.name)) items.push({ label: "编辑", onclick: () => openEditor(entry.path, null) });
    items.push({ label: "下载", onclick: () => h("a", { href: `${fileUrl(entry.path)}&download=1`, download: entry.name }).click() });
  }
  items.push("sep", { label: "重命名", onclick: () => renameEntry(entry) }, { label: "删除", danger: true, onclick: () => void deleteEntry(entry) });
  showMenu(at, items);
}

function treeRows(rel, depth) {
  const listing = P.tree.get(rel);
  if (!listing) return [h("div", { class: "ws-row ws-row-note", style: { paddingLeft: `${12 + depth * 16}px` } }, "加载中…")];
  const rows = [];
  for (const entry of listing.entries) {
    const dir = entry.type === "dir";
    const open = dir && P.expanded.has(entry.path);
    rows.push(
      h(
        "div",
        {
          class: "ws-entry",
          ...(dir ? { "data-dir": entry.path } : {}),
          oncontextmenu: (e) => {
            e.preventDefault();
            entryMenu(entry, { x: e.clientX, y: e.clientY });
          },
        },
        h(
          "button",
          {
            class: `ws-row${entry.name.startsWith(".") ? " faint" : ""}`,
            style: { paddingLeft: `${12 + depth * 16}px` },
            title: entry.path,
            ...(dir ? { "aria-expanded": open ? "true" : "false" } : {}),
            onclick: () => (dir ? toggleDir(entry.path) : openDetail({ kind: "file", path: entry.path, from: null })),
          },
          h("span", { class: "ws-icon" }, icon(dir ? (open ? "folderOpen" : "folder") : "file")),
          h("span", { class: "ws-name" }, entry.name),
          entry.link ? h("span", { class: "ws-tag" }, "链接") : null,
          dir ? null : h("span", { class: "ws-size" }, fmtSize(entry.size)),
        ),
        h("button", { class: "icon-btn ws-entry-more", title: "更多操作", "aria-label": "更多操作", onclick: (e) => entryMenu(entry, e.currentTarget) }, icon("more")),
      ),
    );
    if (open) rows.push(treeRows(entry.path, depth + 1));
  }
  if (listing.truncated) rows.push(h("div", { class: "ws-row ws-row-note", style: { paddingLeft: `${12 + depth * 16}px` } }, "文件太多，只列了前一部分"));
  if (!listing.entries.length && depth) rows.push(h("div", { class: "ws-row ws-row-note", style: { paddingLeft: `${12 + depth * 16}px` } }, "空目录"));
  return rows;
}

function treeToolbar() {
  const tool = (label, onclick) => h("button", { class: "btn ghost", onclick }, label);
  return h("div", { class: "ws-toolbar" }, tool("新建文件", () => newEntry("", "file")), tool("新建文件夹", () => newEntry("", "dir")), tool("上传", () => pickFiles("")));
}

function renderTree() {
  if (P.treeError) return fill(ui.wsBody, emptyNote(P.treeError));
  if (!P.tree.has("")) return fill(ui.wsBody, loading());
  const scroller = P.tree.get("").entries.length ? h("div", { class: "ws-list" }, treeRows("", 0)) : emptyNote("这个目录是空的");
  const old = ui.wsBody.querySelector(".ws-list");
  const top = old?.scrollTop ?? 0;
  fill(ui.wsBody, treeToolbar(), scroller);
  scroller.scrollTop = top;
}

// 拖文件到面板上：放到哪个目录上就传到哪，其余的传到工作目录
function bindPanelDrop(el) {
  const hasFiles = (e) => e.dataTransfer?.types.includes("Files");
  // 不是能放的地方也要拦住：不拦的话，浏览器会直接打开这个文件，把整个页面换掉
  const canDrop = () => P.tab === "files" && !P.detail;
  el.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
    el.classList.toggle("ws-dropping", canDrop());
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("ws-dropping");
  });
  el.addEventListener("drop", (e) => {
    el.classList.remove("ws-dropping");
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!canDrop()) return;
    const dir = e.target.closest?.("[data-dir]")?.dataset.dir ?? "";
    void uploadFiles(dir, [...e.dataTransfer.files]);
  });
}

// ---------- 改动 ----------

const LETTER = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typechange: "T", untracked: "U", conflicted: "!" };
const STATE_LABEL = { modified: "已修改", added: "新增", deleted: "已删除", renamed: "重命名", copied: "复制", typechange: "类型变更", untracked: "未跟踪", conflicted: "有冲突" };

const gitPost = (sub, body) => api(`${base()}/${sub}`, { method: "POST", body });

/** Git 操作的报错可能很长，多显示一会 */
const gitFail = (err) => toast(err.message, 8000);

/** 做一个 Git 操作，做完刷新。成功返回结果，失败提示并返回 undefined */
async function gitAct(sub, body) {
  try {
    const result = await gitPost(sub, body);
    P.log = null;
    await refreshGit();
    return result;
  } catch (err) {
    gitFail(err);
    return undefined;
  }
}

function discard(file) {
  const untracked = file.unstaged === "untracked";
  void confirmDialog({
    title: untracked ? `删除「${file.path}」？` : `丢弃「${file.path}」的改动？`,
    message: untracked ? "这个文件还没有被 Git 跟踪，删除后找不回来。" : "没有暂存的改动会全部丢掉，恢复成暂存区的样子，找不回来。",
    confirmText: untracked ? "删除" : "丢弃",
    danger: true,
  }).then((sure) => {
    if (sure) void gitAct("git-discard", { paths: [file.path] });
  });
}

/** 文件行右边的按钮。敏感文件不能暂存、丢弃，但可以取消暂存：那是把它从下次提交里拿掉 */
function rowActions(file, staged) {
  if (file.sensitive && !staged) return null;
  const act = (name, title, onclick) =>
    h(
      "button",
      {
        class: "icon-btn ws-row-act",
        title,
        "aria-label": title,
        onclick: (e) => {
          e.stopPropagation();
          onclick();
        },
      },
      icon(name),
    );
  const conflicted = file.unstaged === "conflicted";
  return h(
    "div",
    { class: "ws-row-actions" },
    staged
      ? act("minus", "取消暂存", () => void gitAct("git-unstage", { paths: [file.path] }))
      : [
          conflicted ? null : act("undo", file.unstaged === "untracked" ? "删除" : "丢弃改动", () => discard(file)),
          act("plus", conflicted ? "标记为已解决并暂存" : "暂存", () => void gitAct("git-stage", { paths: [file.path] })),
        ],
  );
}

function changeRow(file, state, staged, onclick, actions) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash >= 0 ? file.path.slice(0, slash) : "";
  const row = h(
    "button",
    {
      class: "ws-row ws-change",
      title: `${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}\n${STATE_LABEL[state]}`,
      onclick: onclick ?? (() => openDetail({ kind: "diff", path: file.path, staged, oldPath: file.oldPath, state, from: null })),
    },
    h("span", { class: `ws-state s-${state}` }, LETTER[state]),
    h("span", { class: "ws-name" }, name),
    dir ? h("span", { class: "ws-dir" }, dir) : null,
    file.sensitive ? h("span", { class: "ws-tag" }, "敏感") : null,
  );
  return actions ? h("div", { class: "ws-entry" }, row, actions) : row;
}

/** 分组标题。action：整组的操作（全部暂存 / 全部取消暂存） */
function group(title, rows, action) {
  if (!rows.length) return null;
  return [
    h(
      "div",
      { class: "ws-group" },
      title,
      h("span", { class: "ws-group-count" }, rows.length),
      action ? h("button", { class: "icon-btn ws-group-act", title: action.title, "aria-label": action.title, onclick: action.onclick }, icon(action.icon)) : null,
    ),
    rows,
  ];
}

function branchBar(s) {
  const name = s.branch ?? (s.head ? `分离头指针 ${s.head}` : "未知");
  return h(
    "button",
    { class: "ws-branch", title: "查看和切换分支", onclick: (e) => void openBranches(e.currentTarget) },
    icon("fork"),
    h("span", { class: "ws-branch-name" }, name),
    s.upstream ? h("span", { class: "ws-branch-up" }, s.upstream) : null,
    s.ahead ? h("span", { class: "ws-sync" }, `↑${s.ahead}`) : null,
    s.behind ? h("span", { class: "ws-sync" }, `↓${s.behind}`) : null,
    h("span", { class: "ws-caret" }, icon("caret")),
  );
}

// 和远程同步：要连网，可能要跑很久，同一时间只做一个。显示连到哪，别人的仓库配置可能把地址改了
let syncBusy = null;

async function sync(kind) {
  if (syncBusy) return;
  syncBusy = kind;
  renderChanges();
  const body = kind === "push" ? { hooks: commitUi.hooks.checked } : {};
  const result = await gitAct(`git-${kind}`, body);
  syncBusy = null;
  renderChanges();
  if (!result) return;
  if (kind === "fetch") toast(result.behind ? `已获取 ${result.remote}，落后 ${result.behind} 个提交` : `已获取 ${result.remote}`);
  else if (kind === "pull") toast(result.updated ? `已快进到 ${result.short}` : "已经是最新的");
  else toast(result.published ? `已发布到 ${result.remote}/${result.branch}` : `已推送到 ${result.remote}/${result.branch}`);
}

function syncBar(s) {
  if (!S.user?.gitRemote || !s.pushUrl) return null;
  const button = (kind, label, busyLabel, title, enabled = true) =>
    h("button", { class: "btn small", title, disabled: !!syncBusy || !enabled, onclick: () => void sync(kind) }, syncBusy === kind ? busyLabel : label);
  return h(
    "div",
    { class: "ws-sync-bar" },
    h("span", { class: "ws-sync-url", title: `推送到 ${s.pushUrl}` }, s.pushUrl),
    button("fetch", "获取", "获取中…", "更新远程分支的信息，不动工作区"),
    button("pull", s.behind ? `拉取 ↓${s.behind}` : "拉取", "拉取中…", s.upstream ? "只做快进；本地和远程分叉时不会合并" : "这个分支还没有上游", !!s.branch && !!s.upstream),
    button(
      "push",
      !s.upstream ? "发布分支" : s.ahead ? `推送 ↑${s.ahead}` : "推送",
      "推送中…",
      s.branch ? "不会强制推送。勾选了「运行 Git 钩子」时会跑 pre-push 钩子" : "现在不在任何分支上",
      !!s.branch && !!s.head && (!s.upstream || s.ahead > 0),
    ),
  );
}

// 提交框：一直是同一组元素。改动列表刷新时不动它，打到一半的字和光标都还在
const HOOKS_KEY = "aim.wsCommitHooks";
const commitUi = {
  box: null,
  message: null,
  hooks: null,
  button: null,
  stagedCount: 0,
  busy: false,
};

function ensureCommitBox() {
  if (commitUi.box) return;
  commitUi.message = h("textarea", {
    class: "ws-commit-msg",
    rows: "2",
    placeholder: "提交说明",
    "aria-label": "提交说明",
    spellcheck: "false",
    oninput: updateCommitButton,
    onkeydown: (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void commit();
      }
    },
  });
  commitUi.hooks = h("input", { type: "checkbox", onchange: () => localStorage.setItem(HOOKS_KEY, commitUi.hooks.checked ? "1" : "0") });
  commitUi.hooks.checked = localStorage.getItem(HOOKS_KEY) === "1";
  commitUi.button = h("button", { class: "btn primary", onclick: () => void commit() }, "提交");
  commitUi.box = h(
    "div",
    { class: "ws-commit" },
    commitUi.message,
    h(
      "div",
      { class: "ws-commit-foot" },
      h("label", { class: "ws-commit-hooks", title: "Git 钩子是仓库里的程序，只有你信任这个仓库时才打开" }, commitUi.hooks, h("span", {}, "运行 Git 钩子")),
      commitUi.button,
    ),
  );
}

function updateCommitButton() {
  const n = commitUi.stagedCount;
  commitUi.button.disabled = commitUi.busy || !n || !commitUi.message.value.trim();
  commitUi.button.textContent = commitUi.busy ? "提交中…" : n ? `提交 ${n} 个文件` : "没有已暂存的文件";
}

async function commit() {
  const message = commitUi.message.value.trim();
  if (commitUi.busy || !message || !commitUi.stagedCount) return;
  commitUi.busy = true;
  updateCommitButton();
  const result = await gitAct("git-commit", { message, hooks: commitUi.hooks.checked });
  commitUi.busy = false;
  if (result) {
    commitUi.message.value = "";
    toast(`已提交 ${result.short}`);
  }
  updateCommitButton();
}

function renderChanges() {
  const s = git.status;
  if (!s) return fill(ui.wsBody, loading());
  if (!s.repo) return fill(ui.wsBody, emptyNote(s.error ?? s.reason ?? "当前目录不是 git 仓库"));
  ensureCommitBox();
  ui.wsBranchSlot ??= h("div", { class: "ws-branch-slot" });
  ui.wsChangeList ??= h("div", { class: "ws-list" });
  ui.wsChanges ??= h("div", { class: "ws-changes" }, ui.wsBranchSlot, commitUi.box, ui.wsChangeList);
  // 已经在页面上就不动，只换里面的内容
  if (ui.wsChanges.parentNode !== ui.wsBody || ui.wsBody.childElementCount !== 1) fill(ui.wsBody, ui.wsChanges);

  const conflicted = s.files.filter((f) => f.unstaged === "conflicted");
  const staged = s.files.filter((f) => f.staged);
  const unstaged = s.files.filter((f) => f.unstaged && f.unstaged !== "untracked" && f.unstaged !== "conflicted");
  const untracked = s.files.filter((f) => f.unstaged === "untracked");
  commitUi.stagedCount = staged.length;
  updateCommitButton();
  fill(ui.wsBranchSlot, branchBar(s), syncBar(s));

  const paths = (files) => files.filter((f) => !f.sensitive).map((f) => f.path);
  const stageAll = (files) => (paths(files).length ? { title: "全部暂存", icon: "plus", onclick: () => void gitAct("git-stage", { paths: paths(files) }) } : null);
  fill(
    ui.wsChangeList,
    s.files.length === 0 ? h("div", { class: "ws-empty ws-clean" }, "工作区没有改动") : null,
    group("有冲突", conflicted.map((f) => changeRow(f, "conflicted", false, null, rowActions(f, false)))),
    group("已暂存", staged.map((f) => changeRow(f, f.staged, true, null, rowActions(f, true))), { title: "全部取消暂存", icon: "minus", onclick: () => void gitAct("git-unstage", { paths: staged.map((f) => f.path) }) }),
    group("未暂存", unstaged.map((f) => changeRow(f, f.unstaged, false, null, rowActions(f, false))), stageAll(unstaged)),
    group("未跟踪", untracked.map((f) => changeRow(f, "untracked", false, null, rowActions(f, false))), stageAll(untracked)),
    s.truncated ? h("div", { class: "ws-row ws-row-note" }, "改动的文件太多，只列了前一部分") : null,
  );
}

// ---------- 提交历史 ----------

async function loadLog(skip = 0) {
  const id = P.id;
  try {
    const page = await api(`${base()}/git-log?skip=${skip}`);
    if (id !== P.id) return;
    P.log = { commits: [...(skip ? (P.log?.commits ?? []) : []), ...page.commits], more: page.more };
  } catch (err) {
    if (id !== P.id) return;
    P.log = { commits: [], more: false, error: err.message };
  }
  if (P.tab === "log" && !P.detail) renderLog();
}

function renderLog() {
  if (!P.log) {
    fill(ui.wsBody, loading());
    P.log = { loading: true, commits: [] };
    return void loadLog();
  }
  if (P.log.loading) return fill(ui.wsBody, loading());
  if (P.log.error) return fill(ui.wsBody, emptyNote(P.log.error));
  if (!P.log.commits.length) return fill(ui.wsBody, emptyNote("还没有提交"));
  const old = ui.wsBody.querySelector(".ws-list");
  const top = old?.scrollTop ?? 0;
  const list = h(
    "div",
    { class: "ws-list" },
    P.log.commits.map((c) =>
      h(
        "button",
        { class: "ws-commit-row", title: `${c.hash}\n${c.author}`, onclick: () => void openCommit(c) },
        h("div", { class: "ws-commit-subject" }, c.subject || "（没有说明）"),
        h("div", { class: "ws-commit-meta" }, [c.short, c.author, c.date ? relTime(c.date) : ""].filter(Boolean).join(" · ")),
      ),
    ),
    P.log.more ? h("button", { class: "btn ghost d-more", onclick: () => void loadLog(P.log.commits.length) }, "加载更多") : null,
  );
  fill(ui.wsBody, list);
  list.scrollTop = top;
}

async function openCommit(commit) {
  const detail = { kind: "commit", commit, files: null, error: null, from: null };
  openDetail(detail);
  try {
    detail.files = (await api(`${base()}/git-commit-files?hash=${encodeURIComponent(commit.hash)}`)).files;
  } catch (err) {
    detail.error = err.message;
  }
  if (P.detail === detail) renderCommitDetail();
}

function renderCommitDetail() {
  const detail = P.detail;
  const { commit, files } = detail;
  const head = detailHead(commit.subject || commit.short, [commit.short, commit.author, commit.date ? relTime(commit.date) : ""].filter(Boolean).join(" · "));
  if (detail.error) return fill(ui.wsBody, head, emptyNote(detail.error));
  if (!files) return fill(ui.wsBody, head, loading());
  const list = files.length
    ? h(
        "div",
        { class: "ws-list" },
        files.map((file) =>
          changeRow(file, file.status, false, () => openDetail({ kind: "diff", path: file.path, oldPath: file.oldPath, state: file.status, commit: commit.hash, from: detail })),
        ),
      )
    : emptyNote("这个提交没有改动文件");
  fill(ui.wsBody, head, list);
}

async function openBranches(anchor) {
  const pop = showPopover(anchor, { place: "below", align: "left" });
  pop.classList.add("ws-branches");
  fill(pop, h("div", { class: "ws-branches-note" }, "加载中…"));
  placePopover(pop, anchor);
  let data;
  try {
    data = await api(`${base()}/git-branches`);
  } catch (err) {
    closeMenu();
    return toast(err.message);
  }
  if (ui.menu !== pop) return;
  const row = (b) =>
    h(
      "button",
      {
        class: `ws-branch-row${b.current ? " on" : ""}`,
        title: b.current ? "当前分支" : b.remote ? `切换过去（建一个跟踪它的本地分支）` : "切换到这个分支",
        onclick: async () => {
          closeMenu();
          if (b.current) return;
          if ((await gitAct("git-switch", { branch: b.name })) !== undefined) toast(`已切换到 ${b.remote ? b.name.slice(b.name.indexOf("/") + 1) : b.name}`);
        },
      },
      h("span", { class: "ws-branch-check" }, b.current ? icon("check") : null),
      h(
        "div",
        { class: "ws-branch-text" },
        h("div", { class: "ws-branch-title" }, b.name),
        h("div", { class: "ws-branch-sub" }, [b.hash, b.date ? relTime(b.date) : "", b.subject].filter(Boolean).join(" · ")),
      ),
    );
  const local = data.branches.filter((b) => !b.remote);
  const remote = data.branches.filter((b) => b.remote);
  fill(
    pop,
    h(
      "button",
      {
        class: "ws-branch-new",
        onclick: () => {
          closeMenu();
          promptName({
            title: "新建分支",
            confirmText: "新建并切换",
            submit: async (name) => {
              await gitPost("git-branch-new", { name });
              P.log = null;
              await refreshGit();
            },
          });
        },
      },
      icon("plus"),
      "新建分支…",
    ),
    local.length ? h("div", { class: "ws-group" }, "本地分支") : null,
    local.map(row),
    remote.length ? h("div", { class: "ws-group" }, "远程分支") : null,
    remote.map(row),
    !data.branches.length ? h("div", { class: "ws-branches-note" }, "还没有分支，先提交一次") : null,
    data.truncated ? h("div", { class: "ws-branches-note" }, "分支太多，只列了最近的一部分") : null,
  );
  placePopover(pop, anchor);
}

// ---------- 详情 ----------

function openDetail(detail) {
  P.detail = detail;
  P.diff = null;
  P.diffError = null;
  renderBody();
  if (detail.kind === "diff") void loadDiff();
}

async function closeDetail() {
  if (!(await leaveEdit())) return;
  const from = P.detail?.from;
  P.detail = from ?? null;
  P.diff = null;
  P.diffError = null;
  renderBody();
  if (from?.kind === "diff") void loadDiff();
}

function detailHead(name, sub, ...actions) {
  return h(
    "div",
    { class: "ws-detail-head" },
    h("button", { class: "icon-btn", title: "返回", "aria-label": "返回", onclick: () => void closeDetail() }, icon("back")),
    h("div", { class: "ws-detail-title", title: sub }, h("div", { class: "ws-detail-name" }, name), h("div", { class: "ws-detail-sub" }, sub)),
    ...actions,
  );
}

function renderDetail() {
  if (P.detail.kind === "file") return renderFileDetail();
  if (P.detail.kind === "edit") return renderEditDetail();
  if (P.detail.kind === "turn") return renderTurnDetail();
  if (P.detail.kind === "commit") return renderCommitDetail();
  renderDiffDetail();
}

// ---------- 一轮的改动 ----------

function turnDiffDetail(changes, file, from) {
  return { kind: "diff", path: file.path, oldPath: file.oldPath, state: file.status, turn: changes.id, from };
}

async function loadTurnState(detail) {
  try {
    detail.turnState = await api(`${base()}/git-turn-state?id=${encodeURIComponent(detail.changes.id)}`);
  } catch {
    detail.turnState = { state: "expired" };
  }
  if (P.detail === detail) renderTurnDetail();
}

async function revert(detail, direction, force = false) {
  const { changes } = detail;
  if (!force) {
    const sure = await confirmDialog(
      direction === "undo"
        ? {
            title: `撤销这一轮改的 ${changes.fileCount} 个文件？`,
            message: "这些文件会恢复成这一轮开始前的样子，别的文件不动。之后可以重做。对话记录不变，agent 不知道文件被撤销了，接着聊之前最好告诉它。",
            confirmText: "撤销",
            danger: true,
          }
        : { title: `重做这一轮改的 ${changes.fileCount} 个文件？`, message: "这些文件会恢复成这一轮结束时的样子。", confirmText: "重做" },
    );
    if (!sure) return;
  }
  try {
    detail.turnState = await gitPost("git-turn-revert", { id: changes.id, direction, force });
    toast(direction === "undo" ? "已撤销" : "已重做");
    await refreshGit();
  } catch (err) {
    if (err.data?.conflict !== "diverged") return gitFail(err);
    const files = err.data.files ?? [];
    const sure = await confirmDialog({
      title: "这些文件之后又被改过了",
      message: `${files.slice(0, 8).join("、")}${files.length > 8 ? ` 等 ${files.length} 个文件` : ""} 和这一轮结束时不一样了。继续的话，之后的改动会丢掉，找不回来。`,
      confirmText: "仍然继续",
      danger: true,
    });
    if (sure) return revert(detail, direction, true);
  }
  if (P.detail === detail) renderTurnDetail();
}

function renderTurnDetail() {
  const detail = P.detail;
  const { changes } = detail;
  const state = detail.turnState?.state;
  const action =
    state === "undone"
      ? h("button", { class: "btn ghost", onclick: () => void revert(detail, "redo") }, "重做")
      : state === "applied" || state === "diverged"
        ? h("button", { class: "btn ghost", onclick: () => void revert(detail, "undo") }, "撤销这一轮")
        : null;
  const head = detailHead(
    `这一轮改了 ${changes.fileCount} 个文件`,
    state === "undone" ? "已经撤销了" : state === "diverged" ? "这些文件之后又被改过" : "和这一轮开始前相比",
    h("span", { class: "ws-stat" }, h("span", { class: "ws-add" }, `+${changes.added}`), h("span", { class: "ws-del" }, `−${changes.removed}`)),
    action,
  );
  const rows = changes.files.map((file) =>
    changeRow(file, file.status, false, () => openDetail(turnDiffDetail(changes, file, detail))),
  );
  fill(
    ui.wsBody,
    head,
    h(
      "div",
      { class: "ws-list" },
      changes.shared ? h("div", { class: "d-note-bar" }, "这一轮期间同一仓库里还有别的会话在跑，可能混入了它们的改动") : null,
      rows,
      changes.fileCount > rows.length ? h("div", { class: "ws-row ws-row-note" }, `文件太多，只列了前 ${rows.length} 个`) : null,
    ),
  );
  if (!detail.turnState) void loadTurnState(detail);
}

async function renderFileDetail() {
  const detail = P.detail;
  const rel = detail.path;
  const body = h("div", { class: "fv-body ws-preview" }, h("div", { class: "fv-loading" }, starsLoader()));
  const actions = h("div", { class: "fv-actions" });
  const head = detailHead(rel.split("/").pop(), rel, actions);
  const sub = head.querySelector(".ws-detail-sub");
  fill(ui.wsBody, head, body);
  const url = fileUrl(rel);
  const alive = () => P.detail === detail && body.isConnected;
  let info;
  try {
    info = await api(`${url}&stat=1`);
  } catch (err) {
    if (alive()) body.replaceChildren(emptyNote(err.message));
    return;
  }
  if (!alive()) return;
  sub.textContent = `${rel} · ${fmtSize(info.size)}`;
  await renderFileView({ info, url, page: pageUrl(rel), body, actions, alive });
  if (alive() && editableName(info.name) && info.size <= EDIT_MAX) {
    actions.prepend(h("button", { class: "btn", onclick: () => openEditor(rel, detail) }, "编辑"));
  }
}

// ---------- 编辑 ----------

/** 和服务端的 EDIT_MAX_BYTES 一致 */
const EDIT_MAX = 1024 * 1024;

const editDirty = () => !!P.edit?.editor && P.edit.editor.text() !== P.edit.saved;
const editBase = (e) => `/api/conversations/${encodeURIComponent(e.key)}`;

function dropEditor() {
  P.edit?.editor?.destroy();
  P.edit = null;
}

/** 离开编辑页之前：有没保存的内容就问一下。返回 false 表示留在这里 */
async function leaveEdit() {
  if (P.detail?.kind !== "edit" || !P.edit) return true;
  if (editDirty()) {
    const choice = await confirmDialog({
      title: "还有没保存的修改",
      message: `要保存对「${P.edit.name}」的修改吗？`,
      confirmText: "保存",
      altText: "不保存",
    });
    if (choice === false) {
      P.edit?.editor.focus();
      return false;
    }
    if (choice === true && !(await saveEdit())) return false;
    if (choice === "alt") clearDraft(P.edit);
  }
  dropEditor();
  return true;
}

async function openEditor(rel, from) {
  P.detail = { kind: "edit", path: rel, from };
  const detail = P.detail;
  dropEditor();
  const edit = { key: S.current, path: rel, name: rel.split("/").pop(), hash: "", saved: "", editor: null, host: h("div", { class: "ws-editor" }), previewEl: null, saving: false, loadError: null };
  P.edit = edit;
  renderEditDetail();
  const alive = () => P.edit === edit && P.detail === detail;
  try {
    const file = await api(`${editBase(edit)}/workspace-text?path=${encodeURIComponent(rel)}`);
    if (!alive()) return;
    edit.hash = file.hash;
    edit.saved = file.content;
    // 上次没保存的内容：放回编辑器，还是按当时读出来的版本算冲突
    const draft = readDraft(edit);
    const restored = draft && draft.text !== file.content;
    if (restored) edit.hash = draft.hash;
    else if (draft) clearDraft(edit);
    const editor = await createEditor({
      parent: edit.host,
      text: restored ? draft.text : file.content,
      name: edit.name,
      onChange: () => {
        updateEditHead();
        scheduleDraft(edit);
      },
      onSave: () => void saveEdit(),
    });
    if (!alive()) return editor.destroy();
    edit.editor = editor;
    if (restored) {
      // 跟文件现在的内容比才知道有没有改；draft 的基准不是当前文件时，存的时候会走冲突
      toast("已恢复上次没保存的修改");
    }
    renderEditDetail();
    editor.focus();
  } catch (err) {
    if (!alive()) return;
    edit.loadError = err.message;
    renderEditDetail();
  }
}

let editHead = null;

function updateEditHead() {
  if (!editHead || !P.edit) return;
  const dirty = editDirty();
  editHead.save.disabled = !dirty || P.edit.saving;
  editHead.save.textContent = P.edit.saving ? "保存中…" : "保存";
  editHead.dot.hidden = !dirty;
}

function renderEditDetail() {
  const edit = P.edit;
  if (!edit) return;
  const save = h("button", { class: "btn primary", disabled: true, onclick: () => void saveEdit() }, "保存");
  const dot = h("span", { class: "ws-dirty", title: "有没保存的修改", hidden: true });
  const hasPreview = edit.editor && textPreview(edit.name, "") !== null;
  const previewBtn = hasPreview
    ? h(
        "button",
        {
          class: "btn ghost",
          onclick: () => {
            edit.previewEl = edit.previewEl ? null : h("div", { class: "fv-body ws-preview" }, textPreview(edit.name, edit.editor.text()));
            renderEditDetail();
          },
        },
        edit.previewEl ? "继续编辑" : "预览",
      )
    : null;
  const head = detailHead(edit.name, edit.path, ...(edit.editor ? [previewBtn, save] : []));
  head.querySelector(".ws-detail-name").append(dot);
  editHead = { save, dot };
  if (edit.loadError) return fill(ui.wsBody, head, emptyNote(edit.loadError));
  if (!edit.editor) return fill(ui.wsBody, head, loading());
  edit.host.hidden = !!edit.previewEl;
  fill(ui.wsBody, head, edit.host, edit.previewEl);
  edit.editor.measure();
  updateEditHead();
}

/** 保存。成功返回 true；失败、用户取消返回 false。force：明确要覆盖别人的改动 */
async function saveEdit(force = false) {
  const edit = P.edit;
  if (!edit?.editor || edit.saving) return false;
  const content = edit.editor.text();
  if (!force && content === edit.saved) return true;
  edit.saving = true;
  updateEditHead();
  try {
    const saved = await api(`${editBase(edit)}/workspace-save`, { method: "POST", body: { path: edit.path, content, baseHash: edit.hash, force } });
    edit.hash = saved.hash;
    edit.saved = content;
    clearDraft(edit);
    toast("已保存");
    void refreshGit();
    return true;
  } catch (err) {
    if (err.status !== 409 || !err.data?.conflict) {
      toast(err.message);
      return false;
    }
    // 等用户选的时候不算在保存
    edit.saving = false;
    updateEditHead();
    return await resolveConflict(edit, err.data.conflict);
  } finally {
    edit.saving = false;
    if (P.edit === edit) updateEditHead();
  }
}

/** 文件在编辑期间被改了、被删了：不替用户决定 */
async function resolveConflict(edit, conflict) {
  if (conflict === "deleted") {
    const sure = await confirmDialog({
      title: "文件已经被删掉了",
      message: `「${edit.name}」在你编辑期间被删除了。要用你正在编辑的内容重新创建它吗？`,
      confirmText: "重新创建",
    });
    if (sure) return saveEdit(true);
    if (P.edit === edit) edit.editor.focus();
    return false;
  }
  const choice = await confirmDialog({
    title: "文件已经被改过了",
    message: `「${edit.name}」在你编辑期间被改过了，可能是 agent 改的。覆盖保存会丢掉那些改动；重新加载会丢掉你的修改。`,
    confirmText: "覆盖保存",
    danger: true,
    altText: "重新加载",
  });
  if (choice === true) return saveEdit(true);
  if (choice === "alt") await reloadEditor(edit);
  // 弹窗关了，焦点放回编辑器，接着打字
  if (P.edit === edit) edit.editor.focus();
  return false;
}

async function reloadEditor(edit) {
  try {
    const file = await api(`${editBase(edit)}/workspace-text?path=${encodeURIComponent(edit.path)}`);
    if (P.edit !== edit) return;
    edit.hash = file.hash;
    edit.saved = file.content;
    edit.editor.setText(file.content);
    clearDraft(edit);
    updateEditHead();
    toast("已重新加载");
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 草稿 ----------
// 存在本机的 localStorage：{ text, hash, at }。空间不够存不下就算了，有离开时的提示兜底

const DRAFT_PREFIX = "aim.wsDraft.";
const DRAFT_MAX_AGE = 30 * 86400_000;
const draftKey = (edit) => `${DRAFT_PREFIX}${edit.key}\n${edit.path}`;
let draftTimer = 0;

function writeDraft(edit) {
  if (!edit.editor) return;
  try {
    if (edit.editor.text() === edit.saved) localStorage.removeItem(draftKey(edit));
    else localStorage.setItem(draftKey(edit), JSON.stringify({ text: edit.editor.text(), hash: edit.hash, at: Date.now() }));
  } catch {
    // 空间不够
  }
}

function scheduleDraft(edit) {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => writeDraft(edit), 500);
}

function flushDraft() {
  clearTimeout(draftTimer);
  if (P.edit) writeDraft(P.edit);
}

function clearDraft(edit) {
  clearTimeout(draftTimer);
  localStorage.removeItem(draftKey(edit));
}

function readDraft(edit) {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(edit)) ?? "null");
    return typeof draft?.text === "string" ? draft : null;
  } catch {
    return null;
  }
}

/** 太久没回来的草稿不留着占地方 */
function sweepDrafts() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    try {
      if (Date.now() - (JSON.parse(localStorage.getItem(key)).at ?? 0) > DRAFT_MAX_AGE) localStorage.removeItem(key);
    } catch {
      localStorage.removeItem(key);
    }
  }
}
sweepDrafts();
addEventListener("pagehide", flushDraft);

async function loadDiff() {
  const detail = P.detail;
  const token = ++P.loadToken;
  try {
    const path = encodeURIComponent(detail.path);
    const diff = await api(
      detail.turn
        ? `${base()}/git-turn-diff?id=${encodeURIComponent(detail.turn)}&path=${path}`
        : detail.commit
          ? `${base()}/git-commit-diff?hash=${encodeURIComponent(detail.commit)}&path=${path}`
          : `${base()}/git-diff?path=${path}${detail.staged ? "&staged=1" : ""}`,
    );
    if (token !== P.loadToken || P.detail !== detail) return;
    P.diff = diff;
    P.diffError = null;
  } catch (err) {
    if (token !== P.loadToken || P.detail !== detail) return;
    P.diff = null;
    P.diffError = err.status === 404 ? (detail.turn ? "这一轮的快照已经清理了，看不到具体内容" : detail.commit ? "找不到这个提交里的这个文件" : "这个文件现在已经没有这处改动了") : err.message;
  }
  renderDiffDetail();
}

/** 仓库路径（相对根目录）换算成相对工作目录的路径；在工作目录之外：null */
function repoToWorkspace(p) {
  const prefix = git.status?.prefix ?? "";
  if (!prefix) return p;
  return p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : null;
}

function renderDiffDetail() {
  const detail = P.detail;
  const canSplit = ui.wsPanel.getBoundingClientRect().width >= SPLIT_MIN_WIDTH;
  const mode = canSplit ? P.diffMode : "unified";
  const rel = repoToWorkspace(detail.path);
  const old = ui.wsBody.querySelector(".ws-diff-scroll");
  const top = old?.scrollTop ?? 0;

  const rendered = P.diff?.diff ? renderDiff(P.diff.diff, { path: detail.path, mode }) : null;
  const stat = rendered?.stat;
  const modeBtn = canSplit && rendered?.stat
    ? h(
        "button",
        {
          class: "btn ghost",
          onclick: () => {
            P.diffMode = P.diffMode === "split" ? "unified" : "split";
            localStorage.setItem(MODE_KEY, P.diffMode);
            renderDiffDetail();
          },
        },
        P.diffMode === "split" ? "单栏" : "并排",
      )
    : null;
  const openBtn = rel && detail.state !== "deleted"
    ? h("button", { class: "btn ghost", onclick: () => openDetail({ kind: "file", path: rel, from: detail }) }, "看文件")
    : null;
  const sub = [
    detail.turn ? "这一轮" : detail.commit ? `提交 ${detail.commit.slice(0, 7)}` : "",
    STATE_LABEL[detail.state],
    detail.staged ? "已暂存" : "",
    detail.oldPath ? `从 ${detail.oldPath}` : "",
  ].filter(Boolean).join(" · ");
  const statEl = stat && (stat.added || stat.removed)
    ? h("span", { class: "ws-stat" }, h("span", { class: "ws-add" }, `+${stat.added}`), h("span", { class: "ws-del" }, `−${stat.removed}`))
    : null;
  const head = detailHead(detail.path.split("/").pop(), detail.path, statEl, modeBtn, openBtn);
  head.querySelector(".ws-detail-sub").textContent = `${detail.path}${sub ? ` · ${sub}` : ""}`;

  const scroll = h("div", { class: "ws-diff-scroll" });
  if (P.diffError) scroll.append(emptyNote(P.diffError));
  else if (!P.diff) scroll.append(loading());
  else if (P.diff.note) scroll.append(emptyNote(P.diff.note));
  else if (P.diff.binary) scroll.append(emptyNote("二进制文件，没有文字差异"));
  else if (!P.diff.diff) scroll.append(emptyNote("没有内容上的差异"));
  else {
    if (P.diff.truncated) scroll.append(h("div", { class: "d-note-bar" }, "这个 diff 太大，只显示了前 2 MB"));
    if (rendered.empty) scroll.append(emptyNote(metaSummary(rendered.meta)));
    else scroll.append(rendered.el);
  }
  fill(ui.wsBody, head, scroll);
  scroll.scrollTop = top;
}

/** 没有内容改动，只改了权限、改了名字：把 git 说的翻出来 */
function metaSummary(meta) {
  const oldMode = meta.find((l) => l.startsWith("old mode "));
  const newMode = meta.find((l) => l.startsWith("new mode "));
  if (oldMode && newMode) return `文件权限从 ${oldMode.slice(9)} 改成 ${newMode.slice(9)}，内容没变`;
  if (meta.some((l) => l.startsWith("rename from "))) return "只改了名字，内容没变";
  if (meta.some((l) => l.startsWith("new file mode "))) return "空文件";
  return "没有内容上的差异";
}
