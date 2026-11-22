import { api } from "../lib/api.js";
import { h, fill, icon, toast } from "../lib/dom.js";
import { patchMarkdown } from "../lib/markdown.js";
import { closeMenu, confirmDialog } from "../lib/overlay.js";
import { WS } from "../lib/ws.js";
import { S, setContentHash, ui } from "../state.js";
import { createEditor } from "./file-editor.js";
import { findMemo, rememberFile, relocatePreference, vaultFiles, isFavorite, toggleFavorite } from "./memo-find.js";
import { organizeDialog } from "./memo-organize.js";
import { createMemoOutline } from "./memo-outline.js";
import { askMemoName, chooseMemoVersion, openFileMenu, openLibraryMenu, manageMemoSource, confirmDisconnect, connectSource, memoAccessSettings, shareMemoSource } from "./memo-dialogs.js";
import { createMemoList } from "./memo-list.js";
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
function noteStem(text) {
  const first = text.trimStart().split(/[\r\n]/, 1)[0].replace(/^#{1,6}(?:\s+|$)/, "");
  const cleaned = first.replace(/[<>:"/\\|?*%\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+|[. ]+$/g, "");
  return Array.from(cleaned).slice(0, 55).join("").trimEnd() || "未命名";
}
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
  let sources = [], source, path = "", editor, original = "", version, dirty = false, busy = false, preview = false;
  let conflict = false;
  let session, poll, receiving = false;
  let unborn = false, creationPath = "";
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
      if (dirty || (saving && editor.text() !== savingText)) sessionStorage.setItem(draftKey, JSON.stringify({
        source: source.id, path, version, text: editor.text(), ...(unborn ? { unborn, creationPath } : {}),
      }));
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
  const list = createMemoList({endpoint, shelfKey: () => shelfKey(), canWrite: () => !readOnly(),
    currentFile: () => unborn ? "" : path, onOpen: (hit, row) => run(async () => {
      row?.setAttribute("aria-busy", "true");
      try {
        if (path === hit.path && !unborn && !conflict && !saveError) {
          setTreeOpen(false);
          if (hit.needle && !preview) switchMode(true);
        } else await openFile(hit.path);
        if (path !== hit.path) return;
        if (hit.needle) highlightHit(hit.needle);
        if (narrow.matches && preview) openTree.focus({preventScroll: true});
      } finally { row?.removeAttribute("aria-busy"); }
    }), onMenu: fileMenu, onNewFolder: () => run(() => create(true)) });
  const tree = list.tree;
  const noteDirectory = list.directory;
  const browseFolder = list.navigate;
  const refreshTree = list.refresh;
  const highlight = list.highlight;
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
    if (!unborn && editor && preview && !pendingPosition && reading.clientHeight) writePosition({ path, ...outline.position() });
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
  let feedbackTimer, lastSaveState;
  function switchMode(readingMode) {
    if (!editor || readOnly() || readingMode === preview) return;
    savePosition();
    preview = readingMode;
    modes();
    restorePosition();
    if (!preview) editor.focus();
  }
  const modeButton = button("编辑", () => {
    if (busy) return;
    if (unborn && !dirty && !saving) { backToList(); return; }
    switchMode(!preview);
    if (preview) void saveNow().catch(() => {});
  });
  const narrow = matchMedia("(max-width: 768px)");
  function setTreeOpen(open) {
    root.classList.toggle("show-list", open);
  }
  const onScreenChange = () => {
    closeMenu();
    editor?.measure();
    restorePosition();
  };
  narrow.addEventListener("change", onScreenChange);
  function backToList() {
    if (busy) return;
    if (dirty || saving || conflict) {
      void run(async () => { await saveNow(); displayList(); });
    } else displayList();
  }
  function displayList() {
    savePosition();
    if (unborn && !dirty && !saving) {
      resetDocument();
      showEmptyPane();
    }
    setTreeOpen(true);
    list.focusOrigin();
  }
  const openTree = button("返回列表", backToList, "back");
  openTree.classList.add("memo-mobile");
  openTree.setAttribute("aria-controls", "memo-side");
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
  const side = h("aside", { class: "memo-side", id: "memo-side", "aria-label": "笔记库文件" });
  const pathLabel = h("strong", { class: "memo-breadcrumb" });
  const entryButton = button("连接笔记库", addSource);
  entryButton.classList.add("primary");
  const choose = h("button", { type: "button", class: "memo-library-button", "aria-label": "切换笔记库", onclick: libraryMenu });
  const more = button("更多", e => fileMenu(e.currentTarget, path), "more");
  const handle = h("div", { class: "memo-divider", role: "separator", tabindex: 0, "aria-label": "文件树宽度",
    "aria-controls": tree.id, "aria-orientation": "vertical", title: "拖动调整文件树宽度，双击恢复默认" });
  const widthObserver = bindTreeWidth(root, handle, "aim.memoTreeWidth." + owner);
  const newNote = h("button", { type: "button", class: "btn primary", "aria-label": "新建笔记",
    onclick: () => run(() => create(false)) }, icon("compose"), "新建");
  const readOnly = () => source?.permission === "read";
  function endpoint(action, file = "", cursor = "") {
    return "/api/memos/" + action + "?" + new URLSearchParams({ source: source.id, path: file,
      ...(source.sharedBy ? { owner: source.sharedBy.id } : {}), ...(action === "file" ? { collab: "1" } : {}), ...(cursor ? { cursor } : {}) });
  }
  const shelfKey = () => readingKey(source) + ".files";
  async function openTrash() {
    const hit = await findMemo(endpoint, shelfKey(), "", true);
    if (!hit) return;
    const result = await api(endpoint("organize", hit.path), {method:"POST", body:{op:"restore"}});
    refreshTree();
    toast("已恢复「" + result.path + "」");
  }
  function highlightHit(term) {
    const needle = term.toLowerCase();
    const walker = document.createTreeWalker(reading, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("[hidden],button,.code-head")) continue;
      const at = node.data.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node,at);
      range.setEnd(node,at+term.length);
      reading.scrollTop += range.getBoundingClientRect().top - reading.getBoundingClientRect().top - reading.clientHeight / 3;
      if (globalThis.Highlight && globalThis.CSS?.highlights) CSS.highlights.set("memo-search",new Highlight(range));
      return;
    }
    // Formatted links and nested markup can split the original phrase across text nodes.
    const block = markdownBody._blocks?.find(b => b.raw.toLowerCase().includes(needle));
    block?.nodes.find(n => n.nodeType === 1)?.scrollIntoView({block:"center"});
  }
  const shortcut = e => {
    if (S.view !== "memos" || !source || busy || document.querySelector(".overlay")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      setCollapsed(false);
      setTreeOpen(true);
      list.query.focus();
    }
  };
  pane.addEventListener("keydown", e => {
    if (e.key === "Escape" && narrow.matches && !ui.menu && !e.isComposing && preview) backToList();
  });
  document.addEventListener("keydown",shortcut);
  async function organize(file, action) {
    if (readOnly() || !(await discardable())) return;
    const op = await organizeDialog(endpoint,file,action);
    if (!op) return;
    const result = await api(endpoint("organize",file),{method:"POST",body:op});
    relocatePreference(shelfKey(),file,op.op === "move" ? result.path : null);
    if (path === file) {
      resetDocument(); forgetPosition(source);
      showEmptyPane();
      if (op.op === "move") await openFile(result.path);
      else setTreeOpen(true);
    }
    refreshTree();
    toast(op.op === "move" ? "已更新文件位置" : "已移入回收站");
  }
  function fileMenu(anchor, file) {
    if (busy || !file) return;
    const current = file === path && !unborn;
    openFileMenu(anchor, {
      favorite: isFavorite(shelfKey(), file),
      onFavorite: () => {
        const added = toggleFavorite(shelfKey(), file);
        list.refreshFavorites();
        toast(added ? "已收藏" : "已取消收藏");
      },
      onOutline: current && preview && outline.available() ? () => outline.open(anchor) : null,
      onHistory: current && editor ? () => run(openHistory) : null,
      onOrganize: readOnly() ? null : action => run(() => organize(file, action)),
    });
  }
  function sync() {
    retryButton.hidden = !saveError || conflict;
    retryButton.disabled = busy || !!saving;
    status.title = saveError;
    modeButton.disabled = busy;
    choose.setAttribute("aria-disabled", String(busy));
    more.setAttribute("aria-disabled", String(busy));
    more.hidden = unborn;
    copyButton.hidden = !conflict || readOnly();
    const state = conflict || saveError ? "error" : saving ? "saving" : dirty ? "pending" : unborn ? "blank" : "saved";
    status.textContent = conflict ? "远端已更改" : saveError ? "保存失败" : saving ? "正在保存…" : dirty ? "待自动保存" : unborn ? "" : "已保存";
    status.dataset.state = state;
    if (state !== lastSaveState) {
      clearTimeout(feedbackTimer);
      footer.hidden = state === "blank" || state === "saved" && !["saving", "pending", "error"].includes(lastSaveState);
      if (state === "saved" && !footer.hidden) feedbackTimer = setTimeout(() => { footer.hidden = true; }, 1400);
      lastSaveState = state;
    }
  }
  function showEmptyPane() {
    fill(pane, h("div", { class: "memo-empty" }, icon("notebook"),
      source ? h("h2", {}, "选择一篇笔记") : entryButton));
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
      if (!preview && pane.offsetWidth && (wasEditing || previousEditor !== editor)) editor?.focus();
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
    unborn = false;
    creationPath = "";
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
    setTreeOpen(true);
    if (s) localStorage.setItem(chooseKey, s.id);
    fillChoices();
    modeButton.hidden = newNote.hidden = readOnly();
    side.hidden = !s;
    root.classList.toggle("no-source", !s);
    if (!s) {
      list.destroy();
      showEmptyPane();
      return;
    }
    list.reset();
    if (!readOnly() && draft?.unborn && draft.source === s.id && typeof draft.path === "string" && typeof draft.text === "string") {
      return showText(draft.path, { text: "", version: null, unborn: true }, true, draft);
    }
    const position = savedPosition(s);
    const recoverDraft = !readOnly() && draft?.source === s.id && typeof draft.path === "string" && typeof draft.text === "string";
    const file = recoverDraft ? draft.path : narrow.matches ? null : position?.path;
    showEmptyPane();
    if (!file) return;
    let data;
    try { data = await api(endpoint("file", file)); }
    catch (err) {
      if (recoverDraft && !s.sharedBy && (err.status === 404 || !err.status || err.status >= 500)) data = { text: null, version: null };
      else {
        showEmptyPane();
        if (err.status === 404 || err.status === 403) {
          if (position?.path === file) forgetPosition(s);
          relocatePreference(shelfKey(), file, null);
          refreshTree();
        }
        toast(err.status === 404 && !recoverDraft ? "找不到上次阅读的「" + file + "」，请从文件目录重新选择。" : err.message);
        return;
      }
    }
    await showText(file, data, recoverDraft, recoverDraft ? draft : null, position?.path === file ? position : null);
  }
  function fillChoices() {
    fill(choose, h("span", {}, source?.name || "笔记库"), icon("down"));
    choose.title = source?.name || "切换笔记库";
  }
  async function reloadSources() {
    const updated = await api("/api/memos/sources");
    if (busy || dirty || saving) return;
    sources = updated;
    const latest = sources.find(s => s.id === source?.id);
    if (!latest || latest.permission !== source.permission) {
      const previous = source;
      await run(() => select(latest ?? sources[0]));
      if (previous && !latest) forgetPosition(previous);
    }
    else {
      Object.assign(source, latest);
      fillChoices();
    }
  }
  function addSource() {
    void run(async () => {
      if (!(await discardable())) return;
      connectSource(async s => { sources.push(s); await run(() => select(s)); });
    });
  }
  function libraryMenu() {
    if (busy || !source) return;
    openLibraryMenu(choose, {source, sources,
      onSelect: selected => run(async () => {
        if (selected.id !== source.id && await discardable()) await select(selected);
      }),
      onConnect: addSource, onTrash: readOnly() ? null : () => run(openTrash),
      onManage: source.sharedBy ? null : () => manageMemoSource(source, {
        onAccess: () => run(() => memoAccessSettings(source)),
        onShare: () => run(() => shareMemoSource(source)),
        onDisconnect: () => run(disconnect),
      }),
    });
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

  function modes() {
    const mode = preview ? "编辑" : "完成";
    modeButton.textContent = mode;
    modeButton.title = mode;
    modeButton.setAttribute("aria-label", mode);
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
              await openFile(file);
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
    pathLabel.textContent = file.split("/").pop().replace(/\.(md|markdown)$/i, "");
  }
  async function showText(file, data, edit, draft, position = null) {
    if (file === path && editor) {
      savePosition();
      position ??= savedPosition(source);
      if (position?.path !== file) position = null;
    }
    resetDocument();
    path = file;
    unborn = !!data.unborn;
    creationPath = unborn && typeof draft?.creationPath === "string" ? draft.creationPath : "";
    original = data.text;
    version = draft?.version ?? data.version;
    dirty = !!draft && draft.text !== data.text;
    conflict = dirty && data.version !== null && draft.version !== data.version;
    root.classList.add("has-file");
    updatePath(file);
    editorHost.classList.toggle("memo-prose", markdown(file));
    fill(toolbar, openTree, foldTree, pathLabel, modeButton, more);
    fill(footer, status, copyButton, retryButton);
    fill(pane, toolbar, editorHost, reading, footer);
    session = conflict ? null : data.collab;
    editor = await createEditor({ parent: editorHost, readOnly: readOnly(), collaboration: session, text: session ? original : draft?.text ?? original, name: file, onSave: () => void saveNow().catch(err => toast(err.message)), onChange: () => {
      if (receiving) return;
      dirty = editor.collaboration ? !!editor.collaboration.pending() : unborn ? !!editor.text().trim() : editor.text() !== original;
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
    if (!unborn) {
      writePosition(pendingPosition);
      rememberFile(shelfKey(), file);
    }
    restorePosition();
    if (edit) editor.focus();
    resumePoll();
    highlight();
  }
  async function openFile(file) {
    if (!(await discardable())) return;
    if (!imageFile(file)) {
      const data = await api(endpoint("file", file));
      const position = savedPosition(source);
      return showText(file, data, false, null, position?.path === file ? position : null);
    }
    resetDocument();
    path = file;
    root.classList.add("has-file");
    updatePath(file);
    fill(toolbar, openTree, foldTree, pathLabel, more);
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

  async function writeFirstVersion(current, text) {
    const folder = parent(path), stem = noteStem(text);
    let number = 1;
    let file = creationPath || join(folder, stem + ".md");
    // A prior request may have committed before the connection was lost. Retrying that exact
    // name conditionally gives a conflict instead of creating duplicates or overwriting a note.
    const uncertain = !!creationPath;
    while (current === editor) {
      creationPath = file;
      persistDraft();
      try {
        const result = await api(endpoint("file", file), { method: "PUT", body: { text, version: null } });
        return { ...result, path: file };
      } catch (err) {
        if (err.status !== 409 || uncertain || current !== editor) throw err;
        // Some providers also return 409 when the parent directory is missing.
        // Only choose a new name after finding the actual occupied name in its directory.
        const occupied = new Set();
        const comparable = name => name.normalize("NFC").toLowerCase();
        let cursor = "";
        const pages = new Set();
        do {
          if (current !== editor || pages.has(cursor)) throw err;
          pages.add(cursor);
          const page = await api(endpoint("tree", folder, cursor));
          for (const entry of page.entries) occupied.add(comparable(entry.name));
          cursor = page.next;
        } while (cursor);
        if (!occupied.has(comparable(file.split("/").pop()))) throw err;
        let name;
        do { name = stem + " (" + ++number + ").md"; } while (occupied.has(comparable(name)));
        file = join(folder, name);
      }
    }
    throw new Error("笔记已关闭");
  }

  // An automatic write owns a snapshot, not the editor. Typing can continue during the PUT.
  async function startSave() {
    if (saving) return saving;
    if (!editor || !dirty || conflict) return;
    const current = editor, text = current.text();
    savingText = text;
    const collaboration = current.collaboration;
    const request = unborn ? writeFirstVersion(current, text) : collaboration ?
      api(changesURL(collaboration.revision()), { method: "POST", headers: { "X-Memo-Client": session.token }, body: { updates: collaboration.outgoing() } }) :
      api(endpoint("file", path), { method: "PUT", body: { text, version } });
    saving = request.then(result => {
      if (editor !== current) return;
      if (collaboration) applyPacket(current, result);
      else {
        version = result.version;
        original = text;
        dirty = current.text() !== original;
        if (unborn) {
          // Clear the stored draft under its temporary name before recording its final path.
          try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
          path = result.path;
          unborn = false;
          creationPath = "";
          updatePath(path);
          pendingPosition = { path, top: 0 };
          writePosition(pendingPosition);
          rememberFile(shelfKey(), path);
          if (preview) modes();
          refreshTree();
        }
        // A save can finish while the user is typing. Attach the collaborative session
        // only when its server snapshot matches this editor, retaining selection and undo.
        if (result.collab && !dirty) {
          current.joinCollaboration(result.collab);
          session = result.collab;
          resumePoll();
        }
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
    if (readOnly()) return;
    const target = copy ? parent(path) : noteDirectory();
    if (!folder && !copy) {
      if (await discardable()) await showText(join(target, "未命名.md"), { text: "", version: null, unborn: true }, true);
      return;
    }
    let name = await askMemoName(folder ? "新建文件夹" : "另存副本",
      folder ? "" : (creationPath || path).split("/").pop().replace(/(\.[^.]+)$/, "-副本$1"), target);
    if (!name) return;
    if (!folder && !name.includes(".")) name += ".md";
    const file = join(target, name);
    if (folder) {
      await api(endpoint("folder", file), { method: "POST" });
      browseFolder(file);
    } else {
      const text = editor.text();
      const data = await api(endpoint("file", file), { method: "PUT", body: { version: null, text } });
      await showText(file, { ...data, text }, true);
    }
    if (copy) refreshTree();
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
  fill(side, h("div", { class: "memo-list-bar" }, choose, newNote),
    list.searchBar, list.section, tree, handle);
  fill(root, side, pane);
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
  function enter() {
    if (source && narrow.matches && !dirty && !saving && !unborn) {
      setTreeOpen(true);
      list.reset();
    }
  }
  return { owner, root, enter, reloadSources, persistDraft, savePosition, pausePoll, resumePoll, flush: () => {
    if (!busy && !conflict) void saveNow().catch(() => {});
  }, pending: () => dirty || busy || !!saving, destroy: () => { document.removeEventListener("keydown",shortcut); narrow.removeEventListener("change", onScreenChange); widthObserver.disconnect(); list.destroy(); clearTimeout(feedbackTimer); resetDocument(); }, measure: () => { editor?.measure(); restorePosition(); } };
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
  else { page.enter(); void page.reloadSources().catch(err => toast(err.message)); }
  fill(ui.msgInner, page.root);
  page.measure();
  page.resumePoll();
}
