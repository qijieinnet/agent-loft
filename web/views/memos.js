import { api } from "../lib/api.js";
import { h, fill, icon, toast } from "../lib/dom.js";
import { patchMarkdown } from "../lib/markdown.js";
import { closeMenu, confirmDialog, placePopover, showPopover } from "../lib/overlay.js";
import { WS } from "../lib/ws.js";
import { S, setContentHash, ui } from "../state.js";
import { createEditor } from "./file-editor.js";
import { findMemo, rememberFile, relocatePreference, vaultFiles, trashDir } from "./memo-find.js";
import { organizeDialog } from "./memo-organize.js";
import { createMemoOutline } from "./memo-outline.js";
import { askMemoName, chooseMemoVersion, confirmDisconnect, connectSource, memoAccessSettings, shareMemoSource } from "./memo-dialogs.js";
import { closeSide, renderSidebar } from "./sidebar.js";
import { renderTopbar } from "./topbar.js";

const markdown = path => /\.(md|markdown)$/i.test(path);
const imageFile = path => /\.(png|jpe?g|gif|webp)$/i.test(path);
const noteMarkup = {
  ALLOWED_TAGS: "a img p br hr h1 h2 h3 h4 h5 h6 ul ol li pre code blockquote strong b em i del s table thead tbody tr th td details summary sub sup kbd input".split(" "),
  ALLOWED_ATTR: "href src alt title class start align type checked disabled".split(" "),
};
const parent = path => path.split("/").slice(0, -1).join("/");
const join = (dir, name) => dir ? dir + "/" + name : name;
const button = (name, action, symbol) => h("button", { class: symbol ? "icon-btn" : "btn", title: name, "aria-label": name, onclick: action }, symbol ? icon(symbol) : name);

function relativePath(note, ref) {
  if (!ref || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(ref)) return null;
  const parts = note.split("/").slice(0, -1);
  try {
    for (const part of decodeURIComponent(ref.split(/[?#]/, 1)[0]).split("/")) {
      if (part === "..") { if (!parts.length) return null; parts.pop(); }
      else if (part && part !== ".") parts.push(part);
    }
  } catch { return null; }
  return parts.join("/");
}

function bindTreeWidth(root, handle, key) {
  const defaultWidth = 248;
  let preferred = Number(localStorage.getItem(key)) || defaultWidth;
  let startX, startWidth;
  function resize(value, remember = false) {
    if (!root.clientWidth) return;
    const max = Math.min(600, Math.floor(root.clientWidth * 0.58));
    const min = Math.min(184, max);
    const width = Math.round(Math.max(min, Math.min(max, value)));
    root.style.setProperty("--memo-tree-width", width + "px");
    handle.setAttribute("aria-valuemin", min);
    handle.setAttribute("aria-valuemax", max);
    handle.setAttribute("aria-valuenow", width);
    handle.setAttribute("aria-valuetext", width + " 像素");
    if (remember) {
      preferred = width;
      localStorage.setItem(key, width);
    }
  }
  const observer = new ResizeObserver(() => resize(preferred));
  observer.observe(root);
  handle.onpointerdown = e => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = Number(handle.getAttribute("aria-valuenow"));
    handle.setPointerCapture(e.pointerId);
    root.classList.add("resizing");
  };
  const dragWidth = e => startWidth + e.clientX - startX;
  handle.onpointermove = e => { if (handle.hasPointerCapture(e.pointerId)) resize(dragWidth(e)); };
  handle.onpointerup = e => { if (handle.hasPointerCapture(e.pointerId)) resize(dragWidth(e), true); };
  handle.onlostpointercapture = () => { root.classList.remove("resizing"); resize(preferred); };
  handle.ondblclick = () => { preferred = defaultWidth; localStorage.removeItem(key); resize(preferred); };
  handle.onkeydown = e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    resize(Number(handle.getAttribute("aria-valuenow")) + (e.key === "ArrowLeft" ? -16 : 16), true);
  };
  return observer;
}

function notebook() {
  let sources = [], source, dir = "", path = "", editor, original = "", version, dirty = false, busy = false, preview = false;
  let expanded = new Set(), conflict = false;
  let session, poll, receiving = false;
  const owner = S.user.id;
  const chooseKey = "aim.memoSource." + owner;
  const draftKey = "aim.memoDraft." + owner;
  const readingKey = s => "aim.memoReading." + owner + "." + s.id;
  const collapsedKey = "aim.memoTreeCollapsed." + owner;
  const pauseMs = 1200;
  let draftTimer, saveTimer, saving, savingText, saveError = "", retryMs = 0;

  function persistDraft() {
    clearTimeout(draftTimer);
    if (!editor) return;
    try {
      if (dirty || (saving && editor.text() !== savingText)) sessionStorage.setItem(draftKey, JSON.stringify({ source: source.id, path, version, text: editor.text() }));
      else if (!readOnly()) {
        const saved = savedDraft();
        if (saved?.source === source.id && saved.path === path) sessionStorage.removeItem(draftKey);
      }
    } catch { /* Storage may be full or disabled. The live editor still holds the draft. */ }
  }
  function savedDraft() {
    try { return JSON.parse(sessionStorage.getItem(draftKey)); }
    catch { return null; }
  }
  const root = h("section", { class: "memo-page no-source", "aria-label": "备忘录" });
  const tree = h("nav", { class: "memo-tree", id: "memo-tree", "aria-label": "文件目录" });
  const toolbar = h("div", { class: "memo-bar" });
  const pane = h("section", { class: "memo-pane" });
  const editorHost = h("div", { class: "memo-editor" });
  const reading = h("div", { class: "memo-reading" });
  const outline = createMemoOutline(reading);
  let positionTimer, lastPosition = "", pendingPosition;
  function savedPosition(s) {
    try {
      const value = JSON.parse(localStorage.getItem(readingKey(s)));
      return typeof value?.path === "string" && value.path ? value : null;
    } catch { return null; }
  }
  function writePosition(value) {
    const json = JSON.stringify(value);
    if (json === lastPosition) return;
    try { localStorage.setItem(readingKey(source), json); lastPosition = json; }
    catch { /* A full or private browser store must not interrupt reading. */ }
  }
  function forgetPosition(s) {
    try { localStorage.removeItem(readingKey(s)); } catch { /* Storage may be disabled. */ }
  }
  function savePosition() {
    clearTimeout(positionTimer);
    if (editor && preview && !pendingPosition && reading.clientHeight) writePosition({ path, ...outline.position() });
  }
  function restorePosition() {
    if (!pendingPosition || !preview || !reading.clientHeight) return;
    outline.restore(pendingPosition);
    pendingPosition = null;
  }
  reading.addEventListener("scroll", () => {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(savePosition, 250);
  }, { passive: true });
  const noteTitle = h("h1", { class: "memo-note-title" });
  const markdownBody = h("div", { class: "md" });
  const paper = h("article", { class: "memo-paper" }, noteTitle, markdownBody);
  const status = h("span", { class: "memo-status", role: "status" });
  const footer = h("div", { class: "memo-footer" });
  const retryButton = button("重试保存", () => void saveNow().catch(err => toast(err.message)));
  const historyButton = button("版本历史", () => run(openHistory), "clock");
  function switchMode(readingMode) {
    if (busy || !editor || readOnly() || readingMode === preview) return;
    savePosition();
    preview = readingMode;
    modes();
    restorePosition();
    if (!preview) editor.focus();
  }
  const modeButton = (label, symbol, readingMode) => h("button", { type: "button", title: label,
    "aria-label": label, onclick: () => switchMode(readingMode) }, icon(symbol), h("span", {}, label));
  const readMode = modeButton("阅读", "eye", true);
  const editMode = modeButton("编辑", "edit", false);
  const modeGroup = h("div", { class: "memo-modes", role: "group", "aria-label": "笔记模式" }, readMode, editMode);
  const narrow = matchMedia("(max-width: 768px)");
  function setTreeOpen(open) {
    root.classList.toggle("show-tree", open);
    pane.inert = open && narrow.matches && root.classList.contains("has-file");
    openTree.setAttribute("aria-expanded", String(open));
  }
  const onScreenChange = () => setTreeOpen(!path);
  narrow.addEventListener("change", onScreenChange);
  const openTree = button("文件目录", () => {
    savePosition();
    setTreeOpen(true);
    (tree.querySelector(".selected") || tree.querySelector("button"))?.focus();
  }, "panel");
  openTree.classList.add("memo-mobile", "memo-panel-button");
  openTree.setAttribute("aria-controls", "memo-side");
  function returnToFile() {
    setTreeOpen(false);
    restorePosition();
    openTree.focus();
  }
  const scrim = h("button", { class: "memo-scrim", type: "button", tabindex: -1, "aria-label": "关闭文件目录", onclick: returnToFile });
  const backToFile = button("返回文件", returnToFile, "back");
  backToFile.classList.add("memo-return");
  const foldTree = button("收起文件树", () => {
    const collapsed = !root.classList.contains("tree-collapsed");
    setCollapsed(collapsed);
    if (collapsed) localStorage.setItem(collapsedKey, "1");
    else localStorage.removeItem(collapsedKey);
    editor?.measure();
  }, "panel");
  foldTree.classList.add("memo-desktop", "memo-panel-button");
  foldTree.setAttribute("aria-controls", tree.id);
  function setCollapsed(collapsed) {
    root.classList.toggle("tree-collapsed", collapsed);
    foldTree.title = collapsed ? "展开文件树" : "收起文件树";
    foldTree.setAttribute("aria-label", foldTree.title);
    foldTree.setAttribute("aria-expanded", String(!collapsed));
  }
  setCollapsed(localStorage.getItem(collapsedKey) === "1");
  const copyButton = button("另存副本", () => run(() => create(false, true)));
  const choose = h("select", { class: "input", "aria-label": "切换笔记库", onchange: () => {
    const selected = sources.find(s => s.id === choose.value);
    choose.value = source.id;
    void run(async () => { if (await discardable()) await select(selected); });
  } });
  const side = h("aside", { class: "memo-side", id: "memo-side", "aria-label": "笔记库文件" });
  side.addEventListener("keydown", e => {
    if (e.key === "Escape" && pane.inert && !ui.menu) { e.preventDefault(); returnToFile(); }
  });
  const pathLabel = h("div", { class: "memo-breadcrumb" });
  const entryButton = button("连接笔记库", () => addSource());
  const settings = button("笔记库设置", openSettings, "gear");
  const handle = h("div", { class: "memo-divider", role: "separator", tabindex: 0, "aria-label": "文件树宽度",
    "aria-controls": tree.id, "aria-orientation": "vertical", title: "拖动调整文件树宽度，双击恢复默认" });
  const widthObserver = bindTreeWidth(root, handle, "aim.memoTreeWidth." + owner);
  const newNote = button("新建笔记", () => run(() => create(false)), "compose");
  const newFolder = button("新建文件夹", () => run(() => create(true)), "folderPlus");
  const readOnly = () => source?.permission === "read";
  function endpoint(action, file = "", cursor = "") {
    return "/api/memos/" + action + "?" + new URLSearchParams({ source: source.id, path: file,
      ...(source.sharedBy ? { owner: source.sharedBy.id } : {}), ...(action === "file" ? { collab: "1" } : {}), ...(cursor ? { cursor } : {}) });
  }
  const shelfKey = () => readingKey(source) + ".files";
  async function reveal(file) {
    await openFile(file);
    if (path !== file) return;
    let changed = false;
    for (let p = parent(file); p; p = parent(p)) {
      if (!expanded.has(p)) { expanded.add(p); changed = true; }
    }
    if (changed) refreshTree();
  }
  async function quick(initial = "", trash = false) {
    const hit = await findMemo(endpoint, shelfKey(), initial, trash);
    if (!hit) return;
    if (trash) {
      const result = await api(endpoint("organize",hit.path),{method:"POST",body:{op:"restore"}});
      refreshTree(); toast("已恢复「"+result.path+"」"); return;
    }
    await reveal(hit.path);
    if (path !== hit.path || !hit.needle) return;
    const needle = hit.needle.toLowerCase();
    const walker = document.createTreeWalker(reading, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("[hidden],button,.code-head")) continue;
      const at = node.data.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node,at);
      range.setEnd(node,at+hit.needle.length);
      reading.scrollTop += range.getBoundingClientRect().top - reading.getBoundingClientRect().top - reading.clientHeight / 3;
      if (globalThis.Highlight && globalThis.CSS?.highlights) CSS.highlights.set("memo-search",new Highlight(range));
      return;
    }
    // Formatted links and nested markup can split the original phrase across text nodes.
    const block = markdownBody._blocks?.find(b => b.raw.toLowerCase().includes(needle));
    block?.nodes.find(n => n.nodeType === 1)?.scrollIntoView({block:"center"});
  }
  const findButton = button("快速打开", () => run(() => quick()), "search");
  const shortcut = e => {
    if (S.view === "memos" && source && !document.querySelector(".overlay") && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault(); void run(() => quick());
    }
  };
  document.addEventListener("keydown",shortcut);
  async function organize(file) {
    if (readOnly() || !(await discardable())) return;
    const op = await organizeDialog(endpoint,file);
    if (!op) return;
    const result = await api(endpoint("organize",file),{method:"POST",body:op});
    relocatePreference(shelfKey(),file,op.op === "move" ? result.path : null);
    if (path === file) {
      resetDocument(); forgetPosition(source);
      await select(source);
      if (op.op === "move") await reveal(result.path);
    } else refreshTree();
    toast(op.op === "move" ? "已移动到 "+result.path : "已移入回收站，可在笔记库设置中恢复");
  }
  function sync() {
    retryButton.hidden = !saveError || conflict;
    retryButton.disabled = busy || !!saving;
    status.title = saveError;
    readMode.disabled = editMode.disabled = busy;
    choose.disabled = busy;
    settings.disabled = busy;
    copyButton.hidden = !conflict || readOnly();
    status.textContent = conflict ? "远端已更改" : saving ? "正在保存…" : saveError ? "保存失败" :
      busy ? "处理中…" : dirty ? "待自动保存" : readOnly() ? "只读" : editor ? "已保存" : "";
    status.dataset.state = conflict || saveError ? "error" : saving || busy || dirty ? "pending" : readOnly() ? "readonly" : "saved";
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    clearTimeout(saveTimer);
    saveTimer = null;
    const previousEditor = editor;
    const wasEditing = editorHost.contains(document.activeElement);
    // Keep the insertion point and the text being saved stable across remote I/O.
    editorHost.inert = true;
    sync();
    try { await fn(); }
    catch (err) { toast(err.message); }
    finally {
      busy = false;
      editorHost.inert = false;
      scheduleSave();
      sync();
      if (!preview && pane.isConnected && (wasEditing || previousEditor !== editor)) editor?.focus();
    }
  }
  async function discardable() {
    if (!dirty && !saving) return true;
    if (!conflict) {
      try { await saveNow(); return true; }
      catch { /* Keep the draft unless the user explicitly discards it. */ }
    }
    return confirmDialog({ title: "当前草稿尚未保存", message: saveError || "远端版本已更改。可以返回编辑器另存副本。", confirmText: "放弃修改", danger: true });
  }
  function resetDocument() {
    globalThis.CSS?.highlights?.delete("memo-search");
    savePosition();
    lastPosition = "";
    pendingPosition = null;
    pausePoll();
    session = null;
    clearTimeout(saveTimer);
    saveTimer = null;
    clearTimeout(draftTimer);
    saving = null;
    retryMs = 0;
    saveError = "";
    if (editor) {
      dirty = false;
      persistDraft();
      editor.destroy();
    }
    editor = null;
    dirty = conflict = preview = false;
    root.classList.remove("has-file");
    path = original = "";
    fill(editorHost);
    outline.update(null);
    patchMarkdown(markdownBody, "");
    fill(reading);
  }
  async function select(s, draft) {
    resetDocument();
    source = s;
    dir = "";
    expanded = new Set();
    setTreeOpen(true);
    if (s) localStorage.setItem(chooseKey, s.id);
    fillChoices();
    if (s) choose.value = s.id;
    modeGroup.hidden = newNote.hidden = newFolder.hidden = readOnly();
    side.hidden = !s;
    root.classList.toggle("no-source", !s);
    if (!s) {
      fill(pane, h("div", { class: "memo-empty" }, icon("clipboard"), h("h2", {}, "连接你的笔记库"), h("p", {}, "从 WebDAV 目录或 S3 存储桶打开笔记。"), entryButton));
      return;
    }
    const position = savedPosition(s);
    const recoverDraft = !readOnly() && draft?.source === s.id && typeof draft.path === "string" && typeof draft.text === "string";
    const file = recoverDraft ? draft.path : position?.path;
    const empty = h("div", { class: "memo-empty" }, icon("notebook"), h("h2", {}, "打开一篇笔记"), h("p", {}, readOnly() ? "从文件目录中选择文件查看。" : "从文件目录中选择文件，或新建一篇笔记。"));
    const bar = h("div", { class: "memo-bar" }, openTree, icon("notebook"), s.name);
    fill(pane, bar, file ? h("div", { class: "memo-empty", role: "status" }, "正在打开「" + file + "」…") : empty);
    if (file) for (let p = parent(file); p; p = parent(p)) expanded.add(p);
    refreshTree();
    if (!file) return;
    let data;
    try { data = await api(endpoint("file", file)); }
    catch (err) {
      if (recoverDraft && !s.sharedBy && (err.status === 404 || !err.status || err.status >= 500)) data = { text: null, version: null };
      else {
        fill(pane, bar, empty);
        if (err.status === 404 || err.status === 403) {
          if (position?.path === file) forgetPosition(s);
          if (expanded.size) { expanded.clear(); refreshTree(); }
        }
        toast(err.status === 404 && !recoverDraft ? "找不到上次阅读的「" + file + "」，请从文件目录重新选择。" : err.message);
        return;
      }
    }
    await showText(file, data, recoverDraft, recoverDraft ? draft : null, position?.path === file ? position : null);
  }
  function fillChoices() {
    fill(choose, sources.map(item => h("option", { value: item.id }, item.sharedBy
      ? item.name + " · " + item.sharedBy.name + "共享（" + (item.permission === "read" ? "只读" : "读写") + "）" : item.name)));
  }
  async function reloadSources() {
    const list = await api("/api/memos/sources");
    if (busy || dirty || saving) return;
    sources = list;
    const latest = sources.find(s => s.id === source?.id);
    if (!latest || latest.permission !== source.permission) {
      const previous = source;
      await run(() => select(latest ?? sources[0]));
      if (previous && !latest) forgetPosition(previous);
    }
    else {
      Object.assign(source, latest);
      fillChoices();
      choose.value = latest.id;
    }
  }
  function addSource() {
    void run(async () => {
      if (!(await discardable())) return;
      connectSource(async s => { sources.push(s); await run(() => select(s)); });
    });
  }
  function openSettings() {
    if (ui.menu?.anchor === settings) { closeMenu(); return; }
    const menu = showPopover(settings, { align: "left" });
    const library = source;
    const action = (label, symbol, fn, danger = false) => h("button", {
      class: danger ? "danger" : null, onclick: () => {
        closeMenu();
        settings.focus();
        if (source === library && S.view === "memos") fn();
      },
    }, icon(symbol), label);
    fill(menu, path && !readOnly() ? action("整理当前文件", "folder", () => run(() => organize(path))) : null,
      !readOnly() ? action("回收站", "trash", () => run(() => quick("",true))) : null,
      action("连接其他笔记库", "plus", addSource),
      library.sharedBy ? null : [
        action("智能体访问", "spark", () => run(() => memoAccessSettings(library))),
        action("共享给成员", "handoff", () => run(() => shareMemoSource(library))),
        h("div", { class: "sep" }),
        action("断开笔记库", "unplug", () => run(disconnect), true),
      ]);
    menu.classList.add("memo-settings");
    placePopover(menu, settings);
    menu.querySelector("button").focus();
  }
  async function disconnect() {
    if (source.sharedBy || !(await confirmDisconnect(source))) return;
    if (!(await discardable())) return;
    await api(endpoint("sources"), { method: "DELETE" });
    const disconnected = source;
    sources = sources.filter(s => s.id !== source.id);
    await select(sources[0]);
    forgetPosition(disconnected);
  }

  function highlight() {
    for (const el of tree.querySelectorAll("[data-path]")) {
      const active = el.dataset.path === (el.dataset.directory ? dir : path);
      if (active && !el.dataset.directory) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
      el.classList.toggle("selected", active && (!path || !el.dataset.directory));
      el.classList.toggle("current-dir", active && !!el.dataset.directory);
    }
  }
  function branch(folder) {
    const library = source;
    const box = h("div", { class: "memo-branch" });
    const load = async (cursor = "") => {
      const more = h("button", { class: "btn" }, "加载中…");
      more.disabled = true;
      box.append(more);
      try {
        const { entries, next } = await api(endpoint("tree", folder, cursor));
        if (source !== library || !tree.contains(box)) return;
        for (const item of entries) {
          const full = join(folder, item.name);
          if (full === trashDir) continue;
          const ext = !item.directory && item.name.match(/^(.+)(\.[^.]+)$/);
          const label = ext ? h("span", {}, ext[1], h("small", { class: "memo-extension" }, ext[2])) : h("span", {}, item.name);
          const row = h("button", { class: "memo-row", title: full, "data-path": full, "data-directory": item.directory ? "1" : null },
            icon(item.directory ? "folder" : imageFile(full) ? "library" : "file"), label);
          if (!item.directory && !readOnly()) row.oncontextmenu = e => {
            e.preventDefault(); void run(() => organize(full));
          };
          box.append(row);
          if (item.directory) {
            let children;
            const expand = () => {
              children = branch(full);
              row.after(children);
              row.setAttribute("aria-expanded", "true");
            };
            row.setAttribute("aria-expanded", "false");
            if (expanded.has(full)) expand();
            row.onclick = () => {
              if (busy) return;
              dir = full;
              if (children) {
                children.remove(); children = null;
                expanded.delete(full);
                row.setAttribute("aria-expanded", "false");
              } else { expanded.add(full); expand(); }
              highlight();
            };
          } else row.onclick = () => {
            if (full === path && !conflict && !saveError && root.classList.contains("show-tree")) returnToFile();
            else void run(async () => {
              row.setAttribute("aria-busy", "true");
              try {
                await openFile(full);
                if (narrow.matches && path === full) openTree.focus({ preventScroll: true });
              }
              finally { row.removeAttribute("aria-busy"); }
            });
          };
        }
        more.remove();
        if (!entries.length && !cursor) box.append(h("small", {}, "空目录"));
        if (next) box.append(button("加载更多", e => { e.currentTarget.remove(); void load(next); }));
        highlight();
      } catch (err) {
        more.disabled = false;
        more.textContent = "重试 · " + err.message;
        more.onclick = () => { more.remove(); void load(cursor); };
      }
    };
    void load();
    return box;
  }
  let holdTimer, holdRow, holdX, holdY;
  function cancelHold() { clearTimeout(holdTimer); holdRow = null; }
  tree.addEventListener("pointerdown", e => {
    cancelHold();
    if (e.pointerType !== "touch" || readOnly() || busy) return;
    holdRow = e.target.closest(".memo-row:not([data-directory])");
    if (!holdRow) return;
    holdX = e.clientX; holdY = e.clientY;
    holdTimer = setTimeout(() => {
      const file = holdRow.dataset.path;
      cancelHold();
      void run(() => organize(file));
    }, 520);
  });
  tree.addEventListener("pointermove", e => {
    if (holdRow && Math.hypot(e.clientX-holdX,e.clientY-holdY)>8) cancelHold();
  });
  for (const event of ["pointerup","pointercancel","pointerleave","contextmenu"]) tree.addEventListener(event,cancelHold);
  function refreshTree() {
    if (!source) return;
    const home = h("button", { class: "memo-row memo-root", title: source.name, "data-path": "", "data-directory": "1", onclick: () => { dir = ""; highlight(); } }, icon("folderOpen"), h("span", {}, source.name));
    fill(tree, home, branch(""));
    highlight();
  }

  function modes() {
    readMode.setAttribute("aria-pressed", String(preview));
    editMode.setAttribute("aria-pressed", String(!preview));
    reading.hidden = !preview;
    editorHost.hidden = preview;
    if (!preview) { outline.update(null); editor?.measure(); return; }
    const text = editor.text();
    if (!markdown(path)) { fill(reading, h("pre", {}, text)); return; }
    patchMarkdown(markdownBody, text, { sanitizeOptions: noteMarkup, prepare: prepareNote });
    const title = path.split("/").pop().replace(/\.(md|markdown)$/i, "");
    const heading = markdownBody.firstElementChild;
    if (noteTitle.textContent !== title) noteTitle.textContent = title;
    noteTitle.hidden = heading?.tagName === "H1" && heading.textContent === title;
    if (paper.parentNode !== reading) fill(reading, paper);
    outline.update(markdownBody);
  }
  function prepareNote(box, {raw, offset, chunk}) {
    for (const el of box.querySelectorAll("[class]")) {
      const language = el.tagName === "CODE" && /^language-[\w+-]+$/.test(el.className);
      if (!language) el.removeAttribute("class");
    }
    const inputs = [...box.querySelectorAll("input")];
    const markers = [...raw.matchAll(/^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\](?=\s|$)/gm)];
    const tasks = !/<input\b/i.test(raw) && !readOnly() && chunk.every(t => ["list","blockquote","space"].includes(t.type)) &&
      inputs.length === markers.length && inputs.every((el,i) => el.closest("li") && el.checked === (markers[i][1] !== " "));
    inputs.forEach((el,i) => {
      el.type = "checkbox"; el.disabled = !tasks;
      if (!tasks) return;
      const m = markers[i], at = offset + m.index + m[0].lastIndexOf("[") + 1;
      el.setAttribute("aria-label",el.closest("li").textContent.trim());
      el.onchange = () => {
        if (busy || conflict || !editor.toggleTask(at,m[1])) { el.checked = m[1] !== " "; return; }
        modes();
      };
    });
    for (const img of box.querySelectorAll("img")) {
      const file = relativePath(path, img.getAttribute("src"));
      img.removeAttribute("srcset");
      if (file && imageFile(file)) img.src = endpoint("image", file);
      else img.removeAttribute("src");
    }
    for (const a of box.querySelectorAll("a")) {
      const ref = a.getAttribute("href");
      if (/^https?:\/\//i.test(ref)) continue;
      const file = ref?.startsWith("#") ? path : relativePath(path, ref);
      a.removeAttribute("href");
      if (file) {
        const hash = ref.indexOf("#");
        a.href = "#memos";
        a.onclick = e => {
          e.preventDefault();
          void run(async () => {
            if (file !== path || hash < 0) await openFile(file);
            if (hash < 0 || file !== path || !preview || !markdown(file)) return;
            let fragment = ref.slice(hash + 1);
            try { fragment = decodeURIComponent(fragment); } catch { /* A literal percent is valid in a title. */ }
            if (fragment) outline.jump(fragment);
            else reading.scrollTop = 0;
          });
        };
      }
    }
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest("pre,code,a") && walker.currentNode.data.includes("[[")) texts.push(walker.currentNode);
    for (const node of texts) {
      const parts = [], value = node.data;
      let start = 0;
      for (const m of value.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
        const [name,...fragment] = m[1].split("#");
        const link = h("a",{href:"#memos",onclick:e => {
          e.preventDefault(); void run(async () => {
            let file = path;
            if (name) {
              const matches = [];
              for await (const item of vaultFiles(endpoint)) {
                const normalized = item.replace(/\.(md|markdown)$/i,"");
                const target = name.trim().replace(/\.(md|markdown)$/i,"");
                if (normalized === target || normalized.endsWith("/"+target)) matches.push(item);
              }
              if (!matches.length) { toast("找不到笔记「"+name+"」"); return; }
              const stem = value => value.replace(/\.(md|markdown)$/i,"");
              const wanted = stem(name.trim());
              const exact = matches.find(p => stem(p) === join(parent(path),wanted)) ?? matches.find(p => stem(p) === wanted);
              file = exact || matches[0];
              if (!exact && matches.length > 1) {
                const hit = await findMemo(endpoint,shelfKey(),name);
                if (!hit) return;
                file = hit.path;
              }
              await reveal(file);
            }
            if (path === file && fragment.length) outline.jump(fragment.join("#"));
          });
        }},m[2] || m[1]);
        parts.push(value.slice(start,m.index),link); start = m.index+m[0].length;
      }
      if (start) node.replaceWith(...parts,value.slice(start));
    }
  }
  function updatePath(file) {
    const dirs = [source.name, parent(file)].filter(Boolean).join(" / ");
    pathLabel.title = dirs + " / " + file.split("/").pop();
    fill(pathLabel, h("span", {}, dirs), h("span", { "aria-hidden": "true" }, "/"), h("strong", {}, file.split("/").pop()));
  }
  async function showText(file, data, edit, draft, position = null) {
    if (file === path && editor) {
      savePosition();
      position ??= savedPosition(source);
      if (position?.path !== file) position = null;
    }
    resetDocument();
    path = file;
    dir = parent(file);
    original = data.text;
    version = draft?.version ?? data.version;
    dirty = !!draft && draft.text !== data.text;
    conflict = dirty && data.version !== null && draft.version !== data.version;
    root.classList.add("has-file");
    updatePath(file);
    editorHost.classList.toggle("memo-prose", markdown(file));
    fill(toolbar, openTree, foldTree, pathLabel, modeGroup, outline.trigger, historyButton);
    fill(footer, status, copyButton, retryButton);
    fill(pane, toolbar, editorHost, reading, footer);
    session = conflict ? null : data.collab;
    editor = await createEditor({ parent: editorHost, readOnly: readOnly(), collaboration: session, text: session ? original : draft?.text ?? original, name: file, onSave: () => void saveNow().catch(err => toast(err.message)), onChange: () => {
      if (receiving) return;
      dirty = editor.collaboration ? !!editor.collaboration.pending() : editor.text() !== original;
      if (!conflict) { saveError = ""; retryMs = 0; }
      scheduleSave();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(persistDraft, 400);
      sync();
    } });
    if (session && dirty && draft) editor.setText(draft.text);
    if (draft) {
      if (!dirty) version = data.version;
      persistDraft();
    }
    preview = !edit;
    modes();
    setTreeOpen(false);
    pendingPosition = position ?? { path: file, top: 0 };
    writePosition(pendingPosition);
    rememberFile(shelfKey(), file);
    restorePosition();
    if (edit) editor.focus();
    resumePoll();
    highlight();
  }
  async function openFile(file) {
    if (!(await discardable())) return;
    if (!imageFile(file)) return showText(file, await api(endpoint("file", file)), false);
    resetDocument();
    path = file; dir = parent(file);
    root.classList.add("has-file");
    updatePath(file);
    fill(toolbar, openTree, foldTree, pathLabel);
    rememberFile(shelfKey(),file);
    fill(pane, toolbar, h("div", { class: "memo-reading" }, h("img", { alt: file, src: endpoint("image", file), onerror: () => toast("图片读取失败") })));
    setTreeOpen(false);
    highlight();
  }
  function pausePoll() {
    poll?.abort();
    poll = null;
  }
  function applyPacket(current, packet) {
    if (current !== editor) return;
    receiving = true;
    try {
      if (!current.collaboration.receive(packet)) return;
      original = current.collaboration.savedText();
      version = packet.version;
      dirty = !!current.collaboration.pending();
      if (preview) modes();
      persistDraft();
      sync();
    } finally { receiving = false; }
  }
  function changesURL(since) { return endpoint("changes", path) + "&since=" + since; }
  function resumePoll() {
    if (poll || !session || !editor || conflict || S.view !== "memos") return;
    const controller = poll = new AbortController(), current = editor;
    const headers = { "X-Memo-Client": session.token };
    void (async () => {
      let retry = 1000;
      while (!controller.signal.aborted && S.view === "memos") {
        try {
          const packet = await api(changesURL(current.collaboration.revision()), { headers, signal: controller.signal });
          if (controller.signal.aborted) break;
          applyPacket(current, packet);
          if (source.sharedBy && packet.permission !== source.permission && !dirty && !saving && !busy) {
            await reloadSources();
            if (current !== editor) break;
          }
          retry = 1000;
        } catch (err) {
          if (controller.signal.aborted) break;
          if ([401, 403, 404, 409].includes(err.status)) {
            if (source.sharedBy && (err.status === 403 || err.status === 404) && !dirty && !saving && !busy) {
              await reloadSources().catch(error => toast(error.message));
              if (current !== editor) break;
            }
            if (!dirty && !saving && !busy && err.status === 409) {
              await run(async () => {
                const fresh = await api(endpoint("file", path));
                if (editor === current) await showText(path, fresh, !preview);
              });
              if (current !== editor) break;
            }
            conflict = true;
            saveError = err.message;
            sync();
            break;
          }
          await new Promise(resolve => setTimeout(resolve, retry));
          retry = Math.min(15000, retry * 2);
        }
      }
      if (poll === controller) poll = null;
    })();
  }
  function scheduleSave() {
    if (!dirty || !editor || conflict || busy || saving || (saveError && !retryMs)) {
      clearTimeout(saveTimer);
      saveTimer = null;
      return;
    }
    // Publish continuous typing too, instead of waiting indefinitely for a pause.
    if (session && saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void startSave().catch(() => {});
    }, retryMs || (session ? 450 : pauseMs));
  }

  // An automatic write owns a snapshot, not the editor. Typing can continue during the PUT.
  async function startSave() {
    if (saving) return saving;
    if (!editor || !dirty || conflict) return;
    const current = editor, text = current.text();
    savingText = text;
    const collaboration = current.collaboration;
    const request = collaboration ?
      api(changesURL(collaboration.revision()), { method: "POST", headers: { "X-Memo-Client": session.token }, body: { updates: collaboration.outgoing() } }) :
      api(endpoint("file", path), { method: "PUT", body: { text, version } });
    saving = request.then(result => {
      if (editor !== current) return;
      if (collaboration) applyPacket(current, result);
      else {
        version = result.version;
        original = text;
        dirty = current.text() !== original;
      }
      saveError = "";
      retryMs = 0;
    }).catch(err => {
      if (editor !== current) return;
      if (collaboration && !collaboration.pending()) return; // The long poll already acknowledged this batch.
      conflict = err.status === 409 || err.status === 404;
      dirty = true;
      saveError = err.message;
      const transient = !err.status || err.status >= 500 || err.status === 423 || err.status === 429;
      retryMs = transient ? Math.min(30000, Math.max(3000, retryMs * 2)) : 0;
      throw err;
    }).finally(() => {
      if (editor !== current) return;
      saving = null;
      persistDraft();
      scheduleSave();
      sync();
    });
    sync();
    return saving;
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (saving) await saving;
    if (conflict) throw new Error("远端已更改，请另存副本或重新打开文件");
    if (dirty) await startSave();
    while (busy && dirty && editor?.collaboration && !conflict) await startSave();
  }

  async function openHistory() {
    if (saving) await saving.catch(() => {});
    if (dirty && !conflict) await saveNow();
    const text = await chooseMemoVersion(endpoint("history", path), readOnly());
    if (text === null) return;
    if (conflict) throw new Error("请先另存草稿并重新打开文件，再恢复旧版");
    editor.setText(text);
    await saveNow();
    if (preview) modes();
  }
  async function create(folder, copy = false) {
    if (!folder && !copy && !(await discardable())) return;
    const target = copy ? parent(path) : dir;
    let name = await askMemoName(folder ? "新建文件夹" : copy ? "另存副本" : "新建笔记",
      folder ? "" : copy ? path.split("/").pop().replace(/(\.[^.]+)$/, "-副本$1") : "未命名.md", target);
    if (!name) return;
    if (!folder && !name.includes(".")) name += ".md";
    const file = join(target, name);
    if (folder) {
      await api(endpoint("folder", file), { method: "POST" });
      expanded.add(file);
      dir = file;
    } else {
      const text = copy ? editor.text() : "";
      const data = await api(endpoint("file", file), { method: "PUT", body: { version: null, text } });
      await showText(file, { ...data, text }, true);
    }
    for (let p = target; p; p = parent(p)) expanded.add(p);
    refreshTree();
  }

  editorHost.addEventListener("paste", e => {
    const clipboard = e.clipboardData;
    if (!clipboard) return;
    let files = [...clipboard.files].filter(file => file.type.startsWith("image/"));
    if (!files.length) {
      files = [...clipboard.items].filter(item => item.kind === "file" && item.type.startsWith("image/"))
        .map(item => item.getAsFile()).filter(Boolean);
    }
    if (!files.length || !editor) return;
    e.preventDefault();
    e.stopPropagation();
    void run(async () => {
      for (const file of files) {
        const { relative } = await api(endpoint("attachment", path), { method: "POST", body: file });
        editor.insertAtSelection(markdown(path) ? `![图片](${relative})` : relative);
      }
      refreshTree();
    });
  }, true);
  fill(side, h("div", { class: "memo-tree-tools" }, backToFile, h("strong", {}, "文件"), findButton, newNote, newFolder, button("刷新目录", refreshTree, "refresh")),
    tree, h("div", { class: "memo-sources" }, icon("notebook"), choose, settings), handle);
  fill(root, side, pane, scrim);
  async function init() {
    fill(pane, h("div", { class: "memo-empty" }, "正在读取笔记库…"));
    try {
      sources = await api("/api/memos/sources");
      const draft = savedDraft();
      const initial = sources.find(s => s.id === draft?.source && s.permission !== "read")
        ?? sources.find(s => s.id === localStorage.getItem(chooseKey)) ?? sources[0];
      await run(() => select(initial, draft));
    }
    catch (err) { fill(pane, h("div", { class: "memo-empty" }, err.message, button("重试", init))); }
  }
  side.hidden = true;
  void init();
  return { owner, root, reloadSources, persistDraft, savePosition, pausePoll, resumePoll, flush: () => {
    if (!busy && !conflict) void saveNow().catch(() => {});
  }, pending: () => dirty || busy || !!saving, destroy: () => { document.removeEventListener("keydown",shortcut); narrow.removeEventListener("change", onScreenChange); widthObserver.disconnect(); resetDocument(); }, measure: () => { editor?.measure(); restorePosition(); } };
}

let page;
document.addEventListener("aim:leave-view", () => { page?.savePosition(); page?.pausePoll(); });
window.addEventListener("pagehide", () => { page?.savePosition(); page?.persistDraft(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { page?.savePosition(); page?.persistDraft(); page?.flush(); }
});
window.addEventListener("online", () => page?.flush());
window.addEventListener("beforeunload", e => { if (page?.pending()) { e.preventDefault(); e.returnValue = ""; } });
export function openMemos() {
  if (S.current) WS.raw({ t: "unsub", key: S.current });
  S.current = null;
  document.dispatchEvent(new Event("aim:leave-view"));
  S.view = "memos";
  S.items = [];
  S.turnAi = null;
  setContentHash("#memos");
  WS.presence();
  ui.spacer.style.height = "0px";
  ui.follow = false;
  ui.main.classList.add("tasks-view");
  closeSide();
  renderTopbar();
  renderSidebar();
  if (page?.owner !== S.user.id) { page?.destroy(); page = notebook(); }
  else void page.reloadSources().catch(err => toast(err.message));
  fill(ui.msgInner, page.root);
  page.measure();
  page.resumePoll();
}
