import { api } from "../lib/api.js";
import { h, fill, icon, toast } from "../lib/dom.js";
import { renderMarkdown } from "../lib/markdown.js";
import { confirmDialog } from "../lib/overlay.js";
import { WS } from "../lib/ws.js";
import { S, setContentHash, ui } from "../state.js";
import { createEditor } from "./file-editor.js";
import { askMemoName, chooseMemoVersion, connectSource, memoAccessSettings, shareMemoSource } from "./memo-dialogs.js";
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

function notebook() {
  let sources = [], source, dir = "", path = "", editor, original = "", version, dirty = false, busy = false, preview = false;
  let expanded = new Set(), conflict = false;
  let session, poll, receiving = false;
  const owner = S.user.id;
  const chooseKey = "aim.memoSource." + owner;
  const draftKey = "aim.memoDraft." + owner;
  const pauseMs = 1200;
  let draftTimer, saveTimer, saving, savingText, saveError = "", retryMs = 0;

  function persistDraft() {
    clearTimeout(draftTimer);
    if (!editor) return;
    try {
      if (dirty || (saving && editor.text() !== savingText)) sessionStorage.setItem(draftKey, JSON.stringify({ source: source.id, path, version, text: editor.text() }));
      else sessionStorage.removeItem(draftKey);
    } catch { /* Storage may be full or disabled. The live editor still holds the draft. */ }
  }
  function savedDraft() {
    try { return JSON.parse(sessionStorage.getItem(draftKey)); }
    catch { return null; }
  }
  const root = h("section", { class: "memo-page", "aria-label": "备忘录" });
  const tree = h("div", { class: "memo-tree", "aria-label": "文件目录" });
  const toolbar = h("div", { class: "memo-bar" });
  const pane = h("section", { class: "memo-pane" });
  const editorHost = h("div", { class: "memo-editor" });
  const reading = h("div", { class: "memo-reading" });
  const status = h("span", { class: "memo-status", role: "status" });
  const retryButton = button("重试保存", () => void saveNow().catch(err => toast(err.message)));
  const historyButton = button("版本历史", () => run(openHistory), "clock");
  const toggle = button("预览", () => {
    if (busy || !editor) return;
    preview = !preview;
    modes();
    if (!preview) editor.focus();
  });
  const toggleTree = button("文件目录", () => root.classList.toggle("show-tree"), "folder");
  const copyButton = button("另存副本", () => run(() => create(false, true)));
  const choose = h("select", { class: "input", "aria-label": "切换笔记库", onchange: () => {
    const selected = sources.find(s => s.id === choose.value);
    choose.value = source.id;
    void run(async () => { if (await discardable()) select(selected); });
  } });
  const side = h("aside", { class: "memo-side" });
  const pathLabel = h("strong", { class: "memo-path" });
  const entryButton = button("连接笔记库", () => addSource());
  const accessButton = h("button", { class: "btn", onclick: () => run(() => memoAccessSettings(source)) }, icon("gear"), "智能体访问");
  const shareButton = button("共享给成员", () => run(() => shareMemoSource(source)));
  const disconnectButton = button("断开笔记库", () => run(disconnect), "unplug");
  const newNote = button("新建笔记", () => run(() => create(false)));
  const newFolder = button("新建文件夹", () => run(() => create(true)), "folder");
  const readOnly = () => source?.permission === "read";
  function endpoint(action, file = "", cursor = "") {
    return "/api/memos/" + action + "?" + new URLSearchParams({ source: source.id, path: file,
      ...(source.sharedBy ? { owner: source.sharedBy.id } : {}), ...(action === "file" ? { collab: "1" } : {}), ...(cursor ? { cursor } : {}) });
  }
  function sync() {
    retryButton.hidden = !saveError || conflict;
    retryButton.disabled = busy || !!saving;
    status.title = saveError;
    toggle.disabled = busy;
    choose.disabled = busy;
    shareButton.disabled = accessButton.disabled = busy;
    copyButton.hidden = !conflict || readOnly();
    status.textContent = conflict ? "远端已更改" : saving ? "正在保存…" : saveError ? "保存失败" :
      busy ? "处理中…" : dirty ? "待自动保存" : readOnly() ? "只读" : editor ? "已保存" : "";
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
    fill(reading);
  }
  function select(s) {
    resetDocument();
    source = s;
    dir = "";
    expanded = new Set();
    root.classList.add("show-tree");
    if (s) localStorage.setItem(chooseKey, s.id);
    fillChoices();
    if (s) choose.value = s.id;
    accessButton.hidden = shareButton.hidden = disconnectButton.hidden = !!s?.sharedBy;
    toggle.hidden = newNote.hidden = newFolder.hidden = readOnly();
    side.hidden = !s;
    root.classList.toggle("no-source", !s);
    if (!s) {
      fill(pane, h("div", { class: "memo-empty" }, icon("clipboard"), h("h2", {}, "连接你的笔记库"), h("p", {}, "从 WebDAV 目录或 S3 存储桶打开笔记。"), entryButton));
      return;
    }
    fill(pane, h("div", { class: "memo-blankbar" }, toggleTree), h("div", { class: "memo-empty" }, icon("file"), h("p", {}, readOnly() ? "选择文件查看。" : "选择文件，或在当前目录新建笔记。")));
    refreshTree();
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
    if (!latest || latest.permission !== source.permission) select(latest ?? sources[0]);
    else {
      Object.assign(source, latest);
      fillChoices();
      choose.value = latest.id;
    }
  }
  function addSource() {
    void run(async () => {
      if (!(await discardable())) return;
      connectSource(async s => { sources.push(s); select(s); });
    });
  }
  async function disconnect() {
    if (!(await discardable())) return;
    if (!(await confirmDialog({ title: "断开笔记库？", message: `将移除「${source.name}」的连接，并撤回这个库的所有共享。远端文件和本地版本历史会保留。${dirty ? "当前草稿尚未保存。" : ""}`, confirmText: "断开连接" }))) return;
    await api(endpoint("sources"), { method: "DELETE" });
    sources = sources.filter(s => s.id !== source.id);
    select(sources[0]);
  }

  function highlight() {
    for (const el of tree.querySelectorAll("[data-path]")) {
      el.classList.toggle("selected", el.dataset.path === (el.dataset.directory ? dir : path));
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
          const row = h("button", { class: "memo-row", title: full, "data-path": full, "data-directory": item.directory ? "1" : null },
            icon(item.directory ? "folder" : "file"), h("span", {}, item.name));
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
          } else row.onclick = () => run(() => openFile(full));
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
  function refreshTree() {
    if (!source) return;
    const home = h("button", { class: "memo-row memo-root", "data-path": "", "data-directory": "1", onclick: () => { dir = ""; highlight(); } }, icon("folderOpen"), source.name);
    fill(tree, home, branch(""));
    highlight();
  }

  function modes() {
    toggle.textContent = preview ? "编辑" : "预览";
    toggle.setAttribute("aria-label", toggle.textContent);
    toggle.title = toggle.textContent;
    reading.hidden = !preview;
    editorHost.hidden = preview;
    if (!preview) { editor?.measure(); return; }
    const text = editor.text();
    if (!markdown(path)) { fill(reading, h("pre", {}, text)); return; }
    fill(reading, renderMarkdown(text, { sanitizeOptions: noteMarkup, prepare(box) {
      for (const el of box.querySelectorAll("[class]")) {
        const language = el.tagName === "CODE" && /^language-[\w+-]+$/.test(el.className);
        if (!language) el.removeAttribute("class");
      }
      for (const input of box.querySelectorAll("input")) { input.type = "checkbox"; input.disabled = true; }
      for (const img of box.querySelectorAll("img")) {
        const file = relativePath(path, img.getAttribute("src"));
        img.removeAttribute("srcset");
        if (file && imageFile(file)) img.src = endpoint("image", file);
        else img.removeAttribute("src");
      }
      for (const a of box.querySelectorAll("a")) {
        const ref = a.getAttribute("href");
        if (/^https?:\/\//i.test(ref)) continue;
        const file = relativePath(path, ref);
        a.removeAttribute("href");
        if (file) {
          a.href = "#memos";
          a.onclick = e => { e.preventDefault(); void run(() => openFile(file)); };
        }
      }
    } }));
  }
  async function showText(file, data, edit, draft) {
    resetDocument();
    path = file;
    dir = parent(file);
    original = data.text;
    version = draft?.version ?? data.version;
    dirty = !!draft && draft.text !== data.text;
    conflict = dirty && data.version !== null && draft.version !== data.version;
    root.classList.add("has-file");
    pathLabel.textContent = file;
    fill(toolbar, toggleTree, pathLabel, status, toggle, historyButton, copyButton, retryButton);
    fill(pane, toolbar, editorHost, reading);
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
    if (edit) editor.focus();
    resumePoll();
    root.classList.remove("show-tree");
    highlight();
  }
  async function openFile(file) {
    if (!(await discardable())) return;
    if (!imageFile(file)) return showText(file, await api(endpoint("file", file)), false);
    resetDocument();
    path = file; dir = parent(file);
    root.classList.add("has-file");
    pathLabel.textContent = file;
    fill(toolbar, toggleTree, pathLabel);
    fill(pane, toolbar, h("div", { class: "memo-reading" }, h("img", { alt: file, src: endpoint("image", file), onerror: () => toast("图片读取失败") })));
    root.classList.remove("show-tree");
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
  fill(side, h("div", { class: "memo-sources" }, choose, accessButton, shareButton, button("连接其他笔记库", addSource, "plus"), disconnectButton),
    h("div", { class: "memo-tree-tools" }, newNote, newFolder, button("刷新目录", refreshTree, "refresh"), h("button", { class: "btn memo-return", onclick: () => root.classList.remove("show-tree") }, "返回文件")), tree);
  fill(root, side, pane);
  async function init() {
    fill(pane, h("div", { class: "memo-empty" }, "正在读取笔记库…"));
    try {
      sources = await api("/api/memos/sources");
      const draft = savedDraft();
      select(sources.find(s => s.id === (draft?.source ?? localStorage.getItem(chooseKey))) ?? sources[0]);
      if (source && !readOnly() && draft?.source === source.id && typeof draft.text === "string") {
        await run(async () => {
          let data;
          try { data = await api(endpoint("file", draft.path)); }
          catch (err) { if (source.sharedBy) throw err; data = { text: null, version: null }; }
          for (let p = parent(draft.path); p; p = parent(p)) expanded.add(p);
          await showText(draft.path, data, true, draft);
          refreshTree();
        });
      }
    }
    catch (err) { fill(pane, h("div", { class: "memo-empty" }, err.message, button("重试", init))); }
  }
  side.hidden = true;
  void init();
  return { owner, root, reloadSources, persistDraft, pausePoll, resumePoll, flush: () => {
    if (!busy && !conflict) void saveNow().catch(() => {});
  }, pending: () => dirty || busy || !!saving, destroy: resetDocument, measure: () => editor?.measure() };
}

let page;
document.addEventListener("aim:leave-view", () => page?.pausePoll());
window.addEventListener("pagehide", () => page?.persistDraft());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { page?.persistDraft(); page?.flush(); }
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
