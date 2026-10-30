import { fill, h, icon, starsLoader, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { confirmDialog, modal, showMenu } from "../lib/overlay.js";
import { S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { closeSide, renderSidebar } from "./sidebar.js";
import { renderTopbar } from "./topbar.js";
import { newDraft, openConversation, openLightbox } from "./messages.js";
import { attachLibraryFiles } from "./composer.js";

// ---------- 资料库 ----------
// 你发过的附件、agent 生成的文件，按时间从新到旧。可以按类型筛、按文件名搜，点开预览，
// 删掉，或者拿到新对话里再用。服务端只给自己的（见 core/library.ts）。
// 页面和输入框「从资料库选」的弹窗用同一套网格（browser）。

const KINDS = [
  ["", "全部"],
  ["image", "图片"],
  ["file", "文档"],
  ["media", "音视频"],
];

function fmtSize(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 浏览器里能直接看的图片（服务端只对这几种 inline 显示，SVG 之类的一律当下载，见 api.ts 的 serveUpload） */
const viewable = (f) => f.kind === "image" && /\.(png|jpe?g|gif|webp)$/i.test(f.name);

const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] ?? "").slice(0, 4).toUpperCase() || "FILE";
const downloadUrl = (f) => `${f.url}&download=1`;

function convLabel(f) {
  if (f.conv.hidden) return "已删除的对话";
  return f.conv.title || (f.conv.key.startsWith("feishu:") ? "飞书对话" : "未命名对话");
}

/**
 * 一块可以筛选、搜索、翻页的文件网格。
 * pick：选择模式（弹窗里用），点一下切换选中；否则点开预览，右上角有菜单。
 * onChange：选中的变了
 */
function browser({ pick = false, onChange } = {}) {
  const B = { kind: "", q: "", files: [], more: false, summary: null, token: 0, selected: new Map(), selecting: pick };
  const grid = h("div", { class: "lib-grid" });
  const moreBtn = h("button", { class: "btn ghost lib-more", hidden: true, onclick: () => void load(true) }, "加载更多");
  const status = h("div", { class: "lib-status" });
  const tabs = h("div", { class: "lib-tabs" });
  let searchTimer = 0;
  const search = h("input", {
    class: "input lib-search",
    type: "search",
    placeholder: "搜索文件名",
    oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        B.q = search.value.trim();
        void load(false);
      }, 250);
    },
  });

  const renderTabs = () =>
    fill(
      tabs,
      KINDS.map(([k, label]) =>
        h(
          "button",
          {
            class: `lib-tab${B.kind === k ? " active" : ""}`,
            onclick: () => {
              if (B.kind === k) return;
              B.kind = k;
              renderTabs();
              void load(false);
            },
          },
          label,
        ),
      ),
    );

  async function load(append) {
    const my = ++B.token;
    const last = append ? B.files.at(-1) : null;
    const qs = new URLSearchParams({ limit: "60" });
    if (B.kind) qs.set("kind", B.kind);
    if (B.q) qs.set("q", B.q);
    if (last) (qs.set("beforeAt", String(last.createdAt)), qs.set("beforeId", last.id));
    if (!append) fill(grid, h("div", { class: "lib-empty" }, starsLoader("lg")));
    try {
      const data = await api(`/api/library?${qs}`);
      if (my !== B.token) return;
      B.files = append ? [...B.files, ...data.files] : data.files;
      B.more = data.more;
      B.summary = data.summary;
      render();
    } catch (err) {
      if (my === B.token) fill(grid, h("div", { class: "lib-empty" }, err.message));
    }
  }

  function toggle(f) {
    if (B.selected.has(f.id)) B.selected.delete(f.id);
    else B.selected.set(f.id, f);
    render();
    onChange?.(B.selected);
  }

  function tile(f) {
    const selected = B.selected.has(f.id);
    const open = () => (B.selecting ? toggle(f) : preview(f));
    const thumb =
      viewable(f)
        ? h("img", { src: f.url, alt: f.name, loading: "lazy", onerror: (e) => e.target.replaceWith(h("span", { class: "lib-ext" }, extOf(f.name))) })
        : h("span", { class: "lib-ext" }, f.kind === "audio" ? "♪" : f.kind === "video" ? "▶" : extOf(f.name));
    return h(
      "div",
      { class: `lib-tile${selected ? " selected" : ""}${viewable(f) ? " is-image" : ""}`, title: f.name },
      h("button", { class: "lib-thumb", onclick: open }, thumb),
      B.selecting ? h("span", { class: "lib-check", onclick: () => toggle(f) }, selected ? icon("check") : null) : null,
      pick
        ? null
        : h("button", { class: "icon-btn lib-menu", title: "更多", onclick: (e) => (e.stopPropagation(), fileMenu(e.currentTarget, f)) }, icon("more")),
      h(
        "div",
        { class: "lib-meta", onclick: open },
        h("span", { class: "lib-name" }, f.name),
        h(
          "span",
          { class: "lib-sub" },
          f.source === "agent" ? h("span", { class: "lib-badge" }, "生成") : null,
          `${fmtSize(f.size)} · ${relTime(f.createdAt)}`,
        ),
        pick ? null : h("span", { class: "lib-conv" }, convLabel(f)),
      ),
    );
  }

  function render() {
    const s = B.summary;
    fill(status, s ? `共 ${s.count} 个文件，${fmtSize(s.size)}` : "");
    if (!B.files.length) {
      fill(grid, h("div", { class: "lib-empty" }, B.q || B.kind ? "没有符合条件的文件" : "还没有文件。对话里发过的附件、agent 生成的图片和文档会出现在这里。"));
    } else fill(grid, B.files.map(tile));
    moreBtn.hidden = !B.more;
  }

  // ----- 单个文件的操作 -----

  function preview(f) {
    if (viewable(f)) return openLightbox(f.url, f.name, downloadUrl(f));
    const a = h("a", { href: downloadUrl(f), download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function fileMenu(anchor, f) {
    showMenu(anchor, [
      { label: viewable(f) ? "查看大图" : "下载", onclick: () => preview(f) },
      ...(viewable(f) ? [{ label: "下载", onclick: () => window.open(downloadUrl(f), "_blank", "noopener") }] : []),
      { label: "在新对话里用", onclick: () => void useInNewChat([f]) },
      ...(f.conv.hidden ? [] : [{ label: "打开所在对话", onclick: () => void openConversation(f.conv.key) }]),
      "sep",
      { label: "删除", danger: true, onclick: () => void remove([f]) },
    ]);
  }

  async function remove(files) {
    const ok = await confirmDialog({
      title: files.length > 1 ? `删除 ${files.length} 个文件？` : `删除「${files[0].name}」？`,
      message: "文件会从磁盘上删掉，对话里引用它的地方也打不开了。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api("/api/library/delete", { method: "POST", body: { ids: files.map((f) => f.id) } });
      const gone = new Set(files.map((f) => f.id));
      B.files = B.files.filter((f) => !gone.has(f.id));
      for (const id of gone) B.selected.delete(id);
      B.summary = res.summary;
      render();
      onChange?.(B.selected);
      toast(`已删除 ${res.deleted} 个文件`);
    } catch (err) {
      toast(`删除失败：${err.message}`);
    }
  }

  renderTabs();
  void load(false);
  return {
    B,
    el: h("div", { class: "lib-browser" }, h("div", { class: "lib-bar" }, tabs, search), grid, moreBtn),
    status,
    render,
    remove,
    clearSelection: () => {
      B.selected.clear();
      render();
      onChange?.(B.selected);
    },
    setSelecting: (on) => {
      B.selecting = on;
      if (!on) B.selected.clear();
      render();
      onChange?.(B.selected);
    },
  };
}

/** 开一个新对话，把这些文件放进输入框（还没发，用户可以再打字） */
async function useInNewChat(files) {
  newDraft();
  closeSide();
  await attachLibraryFiles(files.map((f) => f.id));
  ui.input?.focus();
}

// ---------- 页面 ----------

export function openLibrary() {
  if (S.current) WS.raw({ t: "unsub", key: S.current });
  S.current = null;
  // 远程控制页藏起来，连接留着（views/remote.js）
  document.dispatchEvent(new Event("aim:leave-view"));
  S.view = "library";
  S.items = [];
  S.turnAi = null;
  history.replaceState(history.state, "", "#library");
  WS.presence();
  ui.spacer.style.height = "0px";
  ui.follow = false;
  // 和定时任务页一样：不要输入框、「回到底部」（样式见 css/tasks.css 的 .tasks-view）
  ui.main.classList.add("tasks-view");
  closeSide();
  renderTopbar();
  renderSidebar();

  const selBar = h("div", { class: "lib-selbar", hidden: true });
  const selectBtn = h("button", { class: "btn", onclick: () => lib.setSelecting(!lib.B.selecting) }, "选择");
  const lib = browser({
    onChange: (sel) => {
      selectBtn.textContent = lib.B.selecting ? "取消选择" : "选择";
      selBar.hidden = !lib.B.selecting;
      const files = [...sel.values()];
      fill(
        selBar,
        h("span", { class: "grow" }, files.length ? `已选 ${files.length} 个` : "点文件选中"),
        h("button", { class: "btn", disabled: !files.length, onclick: () => void useInNewChat(files) }, "在新对话里用"),
        h("button", { class: "btn danger", disabled: !files.length, onclick: () => void lib.remove(files) }, "删除"),
      );
    },
  });
  fill(
    ui.msgInner,
    h(
      "div",
      { class: "tasks-page lib-page" },
      h(
        "div",
        { class: "tasks-head" },
        h(
          "div",
          { class: "grow" },
          h("h2", {}, "资料库"),
          h("p", {}, "对话里发过的附件、agent 生成的图片和文档都收在这里，开新对话也不会丢。", lib.status),
        ),
        selectBtn,
      ),
      lib.el,
      selBar,
    ),
  );
  ui.messages.scrollTop = 0;
}

// ---------- 输入框里「从资料库选」 ----------

export function pickFromLibrary() {
  const add = h("button", { class: "btn primary", disabled: true }, "添加");
  const lib = browser({
    pick: true,
    onChange: (sel) => {
      add.disabled = sel.size === 0;
      add.textContent = sel.size ? `添加（${sel.size}）` : "添加";
    },
  });
  const close = modal({
    title: "从资料库选择",
    wide: true,
    tall: true,
    className: "lib-pick",
    body: h("div", { class: "modal-body" }, lib.el),
    foot: h("div", { class: "modal-foot" }, h("span", { class: "grow" }, lib.status), h("button", { class: "btn ghost", onclick: () => close() }, "取消"), add),
  });
  add.onclick = async () => {
    const ids = [...lib.B.selected.keys()];
    close();
    await attachLibraryFiles(ids);
  };
}
