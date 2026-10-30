import { fill, h, icon, isTouch, starsLoader, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { clockTime, liveDuration, serverNow, setServerTime, tidyFooter } from "../lib/time.js";
import { copyText, patchMarkdown, renderMarkdown } from "../lib/markdown.js";
import { S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { agentLabel, convTitle, renderSidebar } from "./sidebar.js";
import { baseName, renderContext, renderTopbar, updateCtxVisibility, usableAgents } from "./topbar.js";
import { insertCard, renderInteraction, upsertInteraction } from "./interaction.js";
import { renderChips, setBusy, updateSendBtn } from "./composer.js";
import { renderScheduled } from "./schedule.js";
import { changeCwd, doAction, forkConversation } from "./conv-actions.js";
import { scheduleNav } from "./msg-nav.js";
import { linkReplyFiles } from "./file-preview.js";
import { setTodos } from "./todos.js";
import { expertIcon, findExpert } from "./experts.js";
import { preloadCommands } from "./slash.js";

// ---------- 打开会话 ----------

/** 从定时任务页、远程控制回到对话：把输入框放回来 */
function leaveTasksView() {
  if (!S.view) return;
  S.view = null;
  ui.main.classList.remove("tasks-view");
  // 远程控制页藏起来，连接留着（views/remote.js）
  document.dispatchEvent(new Event("aim:leave-view"));
}

export function newDraft() {
  leaveTasksView();
  if (S.current) WS.raw({ t: "unsub", key: S.current });
  S.current = null;
  S.items = [];
  S.turnAi = null;
  turnStartAt = null;
  S.uploads = [];
  S.pinNext = false;
  ui.pinEl = null;
  ui.follow = true;
  setTodos(null);
  setBusy(false);
  renderScheduled();
  history.replaceState(history.state, "", location.pathname);
  WS.presence();
  renderTopbar();
  renderEmpty();
  renderChips();
  renderSidebar();
  scheduleNav();
  if (!isTouch) ui.input?.focus();
  preloadCommands();
}

export function renderEmpty() {
  const enabled = usableAgents();
  const cwd = S.draftCwd ?? S.workspaceRoot ?? "";
  const expert = findExpert(S.draftExpert);
  // 自定义专家：有欢迎语就用它；只能联网的专家不碰目录，不问「在哪个目录里」
  const custom = expert && !expert.builtin;
  const dirTitle = h(
    "h2",
    {},
    "你想让我们在 ",
    h("button", { class: "hero-dir", title: `${cwd}\n点击切换工作目录`, onclick: () => changeCwd() }, baseName(cwd) || "工作区"),
    " 中构建什么？",
  );
  const fillPrompt = (text) => {
    if (!ui.input) return;
    ui.input.value = text;
    ui.input.dispatchEvent(new Event("input"));
    ui.input.focus();
    // 填空题（___）：把光标放到空上
    const blank = text.indexOf("___");
    if (blank >= 0) ui.input.setSelectionRange(blank, blank + 3);
  };
  fill(ui.msgInner,
    h(
      "div",
      { class: "empty hero" },
      expertIcon(expert ?? { id: S.draftAgent }, "hero-logo"),
      !enabled.length
        ? [h("h2", {}, "有什么可以帮你？"), h("div", {}, "还没有启用任何 agent，先去设置里启用。")]
        : custom
          ? [
              expert.welcome ? h("h2", {}, expert.welcome) : expert.access === "web" ? h("h2", {}, `我是${expert.name}，有什么可以帮你？`) : dirTitle,
              expert.welcome && expert.access !== "web" ? h("div", { class: "hero-sub" }, "工作目录：", h("button", { class: "hero-dir", title: `${cwd}\n点击切换工作目录`, onclick: () => changeCwd() }, baseName(cwd) || "工作区")) : null,
              expert.quickPrompts?.length
                ? h(
                    "div",
                    { class: "hero-prompts" },
                    expert.quickPrompts.map((q) => h("button", { class: "hero-prompt", title: q.prompt, onclick: () => fillPrompt(q.prompt) }, q.title)),
                  )
                : null,
            ]
          : dirTitle,
    ),
  );
  renderContext();
}

// 设置里改了专家：新对话页上的专家、欢迎语跟着变
document.addEventListener("aim:experts", () => {
  if (S.current || S.view) return;
  renderTopbar();
  renderEmpty();
});

export async function openConversation(key) {
  leaveTasksView();
  const token = ++S.loadToken;
  if (S.current && S.current !== key) WS.raw({ t: "unsub", key: S.current });
  S.current = key;
  if (S.convs.has(key)) preloadCommands();
  S.items = [];
  S.turnAi = null;
  turnStartAt = null;
  S.uploads = [];
  S.pinNext = false;
  ui.pinEl = null;
  ui.follow = true;
  setTodos(null);
  renderChips();
  renderScheduled();
  history.replaceState(history.state, "", `#${encodeURIComponent(key)}`);
  WS.presence();
  renderTopbar();
  renderSidebar();
  fill(ui.msgInner, h("div", { class: "empty" }, starsLoader("lg")));
  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      data = await api(`/api/conversations/${encodeURIComponent(key)}/history`);
      break;
    } catch (err) {
      if (token !== S.loadToken) return;
      // 503 = 会话正忙着变化，服务端拿不到一致的快照：等一下再拉
      if (err.status === 503 && attempt < 10) {
        await new Promise((r) => setTimeout(r, 500 + attempt * 300));
        if (token !== S.loadToken) return;
        continue;
      }
      fill(ui.msgInner, h("div", { class: "empty" }, err.message));
      return;
    }
  }
  if (token !== S.loadToken) return; // 期间又切到别的会话了
  // 侧栏分页：打开的可能是还没拉到的那条（通知、地址里带的），拿到了就补进侧栏
  const known = S.convs.has(key);
  S.convs.set(key, data.info);
  preloadCommands();
  if (!known) renderSidebar();
  S.allowedAgents = data.allowedAgents;
  if (Number.isFinite(data.serverTime)) setServerTime(data.serverTime);
  // 等历史的时候 WS 刚连上（刚打开页面），订阅回放的进行中这一轮可能已经先画进来了：
  // 下面整页重画、live 会再重放一遍，这里得一起清掉，不然 S.turnAi 还指着被清掉的那个占位，
  // 回复全写进一个不在页面上的元素里
  S.items = [];
  S.turnAi = null;
  turnStartAt = null;
  ui.pinEl = null;
  fill(ui.msgInner, );
  // 历史一次性加进来，最后再统一排版，免得每加一条就强制排版一次
  bulk = true;
  try {
    for (const m of data.messages) {
      if (m.role === "user") addItem({ type: "user", text: m.text, files: m.attachments ?? [], origin: null, anchor: m.anchor });
      else if (m.role === "question") addItem({ type: "ix", id: m.question.id, ix: historyQuestion(key, m) });
      else addItem({ type: "ai", steps: m.steps ?? [], committed: m.text, partial: "", done: true, footer: m.footer, at: m.ts, anchor: m.anchor, segment: m.segment });
    }
    // 任务清单：最后改过的那一份（进行中这一轮又改了的话，下面重放 todos 事件时换成新的）
    setTodos(data.messages.findLast((m) => m.todos)?.todos ?? null);
    S.seq.set(key, 0);
    // 进行中这一轮弹过的卡（含已处理的）：重放到 ix 事件时放回原位
    replayCards = new Map((data.interactions ?? []).map((ix) => [ix.id, ix]));
    for (const env of data.live) applyEvent(env);
    replayCards = new Map();
    S.seq.set(key, Math.max(S.seq.get(key) ?? 0, data.seq));
    for (const ix of data.pending) upsertInteraction(ix);
  } finally {
    bulk = false;
  }
  clampLongUsers(S.items);
  markLatestAi();
  updateCtxVisibility();
  scheduleNav();
  if (S.items.length === 0) {
    ui.msgInner.append(
      h(
        "div",
        { class: "empty" },
        h("h2", {}, convTitle(data.info)),
        h("div", {}, data.info.sessionId ? "这条会话暂时读不到历史记录，直接接着说就行。" : `${agentLabel(data.info.agent)} · ${data.info.cwd}`),
      ),
    );
  }
  setBusy(data.info.busy);
  renderTopbar();
  WS.subscribe(key, S.seq.get(key));
  renderScheduled();
  scrollToBottom();
}

/** 打开会话、重放进行中这一轮时，ix 事件对应的卡片内容（见 openConversation） */
let replayCards = new Map();

/** 会话记录里还原出来的提问（问了什么、你怎么答的）→ 画成一张已处理的提问卡 */
function historyQuestion(key, m) {
  const q = m.question;
  return {
    id: q.id,
    convKey: key,
    spec: { kind: "question", title: q.title, questions: q.questions },
    selections: q.selections,
    freeText: q.freeText,
    settled: { settlement: q.skipped ? "skipped" : "answered", by: "", at: m.ts ?? 0 },
  };
}

// ---------- 消息渲染 ----------

// 滚动规则（和 ChatGPT 一样）：
//   - 自己发出一条消息后，把它顶到视口最上面，下面留白；回复往下长，长到屏幕底部之后才跟着往下滚。
//     留白靠消息列表后面的 ui.spacer 撑出来：高度 = 刚好够那条消息滚到顶，回复越长它越矮，到 0 为止。
//   - 回复过程中只要用户自己滚了（滚轮、触摸、拖滚动条、键盘翻页），就不再自动滚，直到下一次发消息。
//     ui.follow 记着现在要不要自动滚。
//   - 排队消息不改变当前定位，也不计入自动跟随的底部；轮到它时再切换定位。

function nearBottom(gap = 120) {
  const m = ui.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < gap;
}

/** 内容变了之后：重算留白，要跟随的话贴到底（有留白时「底」正好就是被顶上去的那条消息） */
function afterLayout() {
  if (!ui.messages) return;
  const pinTop = fitSpacer();
  if (ui.follow && performance.now() > (ui.smoothUntil ?? 0)) ui.messages.scrollTop = followScrollTop(pinTop);
  updateToBottomBtn();
}

/** 排队消息在当前回复后面：自动滚动只跟随回复，队列再长也不把当前这一轮挤出视口。 */
function followScrollTop(pinTop) {
  if (pinTop === undefined || !S.items.at(-1)?.queued) return ui.messages.scrollHeight;
  const last = S.items.findLast((it) => !it.queued);
  if (!last?.el?.isConnected) return ui.messages.scrollHeight;
  const bottom = last.el.offsetTop + last.el.offsetHeight + parseFloat(getComputedStyle(ui.msgInner).paddingBottom);
  return Math.max(pinTop, bottom - ui.messages.clientHeight);
}

function fitSpacer() {
  const pin = ui.pinEl;
  if (!pin?.isConnected) {
    ui.pinEl = null;
    ui.spacer.style.height = "0px";
    return;
  }
  // 顶栏是叠在消息区上面的：让出它的高度，再留一点空
  const covered = Math.max(0, ui.topbar.getBoundingClientRect().bottom - ui.messages.getBoundingClientRect().top);
  const top = Math.max(0, pin.offsetTop - covered - 12);
  const need = top + ui.messages.clientHeight - ui.msgInner.offsetHeight;
  ui.spacer.style.height = `${Math.max(0, Math.ceil(need))}px`;
  return top;
}

/** 回到跟随模式并贴到底：打开会话、点「回到底部」时用 */
export function scrollToBottom() {
  ui.follow = true;
  afterLayout();
}

/** 把刚发出的这条消息顶到最上面 */
function pinToTop(el) {
  ui.pinEl = el;
  ui.follow = true;
  const pinTop = fitSpacer();
  ui.smoothUntil = performance.now() + 450;
  ui.messages.scrollTo({ top: followScrollTop(pinTop), behavior: "smooth" });
  // 平滑滚动期间留白可能又变了（比如输入框清空变矮），滚完再对齐一次
  setTimeout(afterLayout, 460);
  updateToBottomBtn();
}

/** 用户自己动了滚动（或者点了快速定位、展开了长消息）：停止自动滚动 */
export function userScrolled() {
  ui.follow = false;
  ui.smoothUntil = 0;
}

function updateToBottomBtn() {
  if (ui.toBottom) ui.toBottom.hidden = nearBottom(200);
}

export function bindScrollWatch() {
  const m = ui.messages;
  m.addEventListener("wheel", userScrolled, { passive: true });
  m.addEventListener("touchmove", userScrolled, { passive: true });
  // 点在滚动条上时事件目标就是滚动容器本身（点在内容上的是里面的元素）
  m.addEventListener("pointerdown", (e) => e.target === m && userScrolled());
  m.addEventListener("keydown", (e) => {
    if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(e.key)) userScrolled();
  });
  m.addEventListener("scroll", updateToBottomBtn, { passive: true });
  // 触屏点消息才展开操作栏；点其它消息或空白处收起，链接、按钮和选中文字保持原来的行为。
  document.addEventListener("click", (e) => {
    if (!matchMedia("(hover: none)").matches) return;
    const message = m.contains(e.target) ? e.target.closest(".msg-user-group, .msg-ai") : null;
    if (message && (e.target.closest("button, a, input, textarea, select, summary, [role='button'], [contenteditable], .ai-actions, .user-actions") || window.getSelection()?.isCollapsed === false)) return;
    const wasOpen = message?.classList.contains("actions-open");
    for (const el of m.querySelectorAll(".actions-open")) el.classList.remove("actions-open");
    if (!wasOpen && message && !message.classList.contains("latest") && message.querySelector(".ai-actions, .user-actions:not([hidden])")) {
      message.classList.add("actions-open");
    }
  });
  // 消息区变高（发送后输入框清空变矮）、内容变高都要重算留白；窗口 resize 管不到元素自己变尺寸
  const ro = new ResizeObserver(() => afterLayout());
  ro.observe(m);
  ro.observe(ui.msgInner);
}

/** 只有最后一条回复默认显示底部操作栏，前面的在桌面 hover、触屏点击时显示 */
function markLatestAi() {
  let latest = null;
  for (let i = S.items.length - 1; i >= 0; i--) {
    const it = S.items[i];
    if (it.type === "ai" && it.done && !it.segment) {
      latest = it;
      break;
    }
  }
  for (const it of S.items) if (it.type === "ai") it.el?.classList.toggle("latest", it === latest);
}

/** 正在批量加历史：addItem 先不排版，加完由 openConversation 统一做 */
let bulk = false;

export function addItem(item) {
  ui.msgInner.querySelector(".empty")?.remove();
  item.el = renderItem(item);
  // 当前回复拆成多段或恢复排队消息时，回复和交互卡仍在后续排队输入之前。
  const activeUser = S.items.findLastIndex((it) => it.type === "user" && !it.queued);
  const queued = item.type === "ai" || item.type === "ix"
    ? S.items.findIndex((it, i) => i > activeUser && it.type === "user" && it.queued)
    : -1;
  if (queued >= 0) {
    S.items[queued].el.before(item.el);
    S.items.splice(queued, 0, item);
  } else {
    ui.msgInner.append(item.el);
    S.items.push(item);
  }
  if (bulk) return item;
  if (item.type === "user") {
    clampLongUsers([item]);
    scheduleNav();
  }
  markLatestAi();
  updateCtxVisibility();
  afterLayout();
  return item;
}

const dirty = new Set();
let flushScheduled = false;
export function updateItem(item) {
  dirty.add(item);
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    for (const it of dirty) {
      if (!it.el?.isConnected) continue;
      // 回复原地更新；其它（交互卡片等）不常变，整个重建
      if (it.type === "ai") {
        patchAi(it);
        continue;
      }
      const next = renderItem(it);
      it.el.replaceWith(next);
      it.el = next;
    }
    dirty.clear();
    markLatestAi();
    afterLayout();
  });
}

const fileUrl = (f, download) => `/api/file?path=${encodeURIComponent(f.path)}${download ? "&download=1" : ""}`;

function fmtSize(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 非图片附件：卡片（图标 + 文件名 + 大小），点一下下载 */
function fileCard(f, gone) {
  const ext = (f.name.match(/\.([^.]+)$/)?.[1] ?? "").slice(0, 4).toUpperCase();
  return h(
    gone ? "span" : "a",
    {
      class: `att-file${gone ? " gone" : ""}`,
      ...(gone ? { title: "文件已清理（开新会话 / 切换目录时会清掉附件）" } : { href: fileUrl(f, true), download: f.name, title: `下载 ${f.name}` }),
    },
    h("span", { class: "att-ext" }, ext || "FILE"),
    h(
      "span",
      { class: "att-meta" },
      h("span", { class: "att-name" }, f.name),
      h("span", { class: "att-size" }, gone ? "已清理" : fmtSize(f.size) || "下载"),
    ),
  );
}

/**
 * 用户消息带的附件，排在气泡上面，顺序和发送时一致。
 * files：新的是 {kind, name, path, size} 对象；老事件里只有「图片 a.png」这样的标签，只能显示名字
 */
function renderUserFiles(files) {
  if (!files?.length) return null;
  return h(
    "div",
    { class: "msg-atts" },
    files.map((f) => {
      if (typeof f === "string") return h("span", { class: "att-file gone" }, h("span", { class: "att-meta" }, h("span", { class: "att-name" }, f)));
      if (f.kind !== "image") return fileCard(f);
      const box = h("button", { class: "att-img", title: f.name, onclick: () => openLightbox(fileUrl(f), f.name, fileUrl(f, true)) });
      const img = h("img", { src: fileUrl(f), alt: f.name, loading: "lazy" });
      // 文件已经被清理：退回成「已清理」的文件卡片
      img.onerror = () => box.replaceWith(fileCard(f, true));
      box.append(img);
      return box;
    }),
  );
}

/** 点缩略图看大图：点任意处或按 Esc 关闭 */
export function openLightbox(src, name, download) {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const overlay = h(
    "div",
    { class: "lightbox", onclick: close },
    h("img", { src, alt: name ?? "" }),
    h(
      "div",
      { class: "lightbox-bar", onclick: (e) => e.stopPropagation() },
      name ? h("span", { class: "lightbox-name" }, name) : null,
      download ? h("a", { class: "lightbox-dl", href: download, download: name ?? "" }, "下载") : null,
    ),
  );
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
}

/** 用户消息超过这个高度（约 10 行）就先收起来，像 ChatGPT；只多出一两行的不收 */
const USER_CLAMP = 260;

/** 太长的用户消息收起来，下面放「展开显示」。先把高度都量完再统一改，只排版一次 */
function clampLongUsers(items) {
  const long = items.filter((it) => {
    if (it.type !== "user" || !it.bubble || it.clampChecked) return false;
    it.clampChecked = true;
    return it.bubble.scrollHeight > USER_CLAMP + 60;
  });
  for (const it of long) {
    const bubble = it.bubble;
    bubble.classList.add("clamped");
    const btn = h(
      "button",
      {
        class: "msg-more",
        onclick: () => {
          // 自己展开 / 收起：别被自动滚动拉回底部
          userScrolled();
          const open = !bubble.classList.toggle("clamped");
          btn.textContent = open ? "收起" : "展开显示";
          // 收起后按钮可能跑到视口上面去了：拉回来
          if (!open) btn.scrollIntoView({ block: "nearest" });
        },
      },
      "展开显示",
    );
    bubble.after(btn);
  }
}

async function editUserMessage(item, queued, button) {
  const key = S.current;
  if (!key || S.editingMessage || S.sending) return;
  S.editingMessage = key;
  button.disabled = true;
  updateSendBtn();
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(key)}/${queued ? "cancel-queued" : "rewind"}`, {
      method: "POST",
      body: { id: item.id, anchor: item.anchor, sessionId: S.convs.get(key)?.sessionId },
    });
    if (S.current !== key) return;
    if (!queued && !result.queued) await openConversation(key);
    if (S.current !== key) return;
    for (const upload of S.uploads) if (upload.url) URL.revokeObjectURL(upload.url);
    S.uploads = result.draft.uploads;
    ui.input.value = result.draft.text;
    renderChips();
    ui.input.dispatchEvent(new Event("input", { bubbles: true }));
    ui.input.focus();
    if (result.draft.missing) toast("部分附件已被清理，请重新添加");
  } catch (err) {
    toast(err.message);
  } finally {
    S.editingMessage = null;
    button.disabled = false;
    updateSendBtn();
  }
}

function editButton(item, queued = false) {
  const label = queued ? "撤销并编辑" : "回退到此处";
  return h("button", {
    class: "icon-btn", title: label, "aria-label": label,
    onclick: (e) => void editUserMessage(item, queued, e.currentTarget),
  }, icon("undo"));
}

/** 排队中的消息可立即发送或撤销编辑；停止后没发出去的显示「没有发出」 */
function queueNote(item, state) {
  if (state === "dropped") return h("div", { class: "queue-note dropped" }, "没有发出");
  return h(
    "div",
    { class: "queue-note" },
    h("span", { class: "shimmer" }, "排队中，等上一条回复完"),
    h("button", { class: "queue-jump", title: "停掉正在进行的回复，马上处理这条", onclick: () => void doAction("jump", item.id) }, "打断并发送"),
    editButton(item, true),
  );
}

/** state：queued / dropped / null（轮到它了，去掉标记） */
function setQueueState(item, state) {
  item.queued = state === "queued";
  const actions = item.el.querySelector(".user-actions");
  if (actions) actions.hidden = item.queued;
  const next = state ? queueNote(item, state) : null;
  if (item.queueEl && next) item.queueEl.replaceWith(next);
  else if (item.queueEl) item.queueEl.remove();
  else if (next) item.el.insertBefore(next, item.el.querySelector(".user-actions"));
  item.queueEl = next;
}

function renderItem(item) {
  switch (item.type) {
    case "user": {
      const origin = item.origin && item.origin.channel !== "web" ? `来自${item.origin.name ?? item.origin.channel}` : "";
      return h(
        "div",
        { class: "msg-user-group" },
        // 只发了附件、没有文字：「来自飞书」挂在附件上面
        !item.text && origin ? h("span", { class: "origin" }, origin) : null,
        renderUserFiles(item.files),
        item.text ? (item.bubble = h("div", { class: "msg-user" }, origin ? h("span", { class: "origin" }, origin) : null, item.text)) : null,
        (item.queueEl = item.queued ? queueNote(item, "queued") : null),
        h("div", { class: "user-actions", hidden: item.queued },
          item.text ? h("button", { class: "icon-btn", title: "复制", onclick: () => copyText(item.text) }, icon("copy")) : null,
          editButton(item),
        ),
      );
    }
    case "ai":
      return renderAi(item);
    case "notice":
      return h("div", { class: "notice" }, renderMarkdown(item.text));
    case "error":
      return h("div", { class: "error-box" }, item.text);
    case "ix":
      return renderInteraction(item);
  }
  return h("div");
}

/** 定时任务的 agent 判断这次不用提醒时，回复第一行写的暗号（见 core/task-prompt.ts） */
const SILENT_MARK = "[[静默]]";

/**
 * 回复流式输出时每帧都会更新：不整条重建，只改变了的部分（item.v 记着各部分的元素）。
 * 前面已经输出完的 markdown 块、步骤列表、星星动画都原地不动，选中的文字和滚动位置也就不会丢。
 */
function renderAi(item) {
  item.v = {};
  item.el = h("div", { class: "msg-ai" });
  patchAi(item);
  return item.el;
}

function patchAi(item) {
  const v = item.v;
  const raw = item.committed + (item.partial ? (item.committed ? "\n\n" : "") + item.partial : "");
  const silent = raw.trimStart().startsWith(SILENT_MARK);
  const body = silent ? raw.trimStart().slice(SILENT_MARK.length).trim() : raw;
  const working = !item.done;

  if (item.steps.length > 0) {
    if (!v.steps) {
      v.stepsText = h("span", { class: "steps-text" });
      v.stepsList = h("ol", {});
      v.steps = h(
        "details",
        { class: "steps", open: item.stepsOpen ?? false, ontoggle: (e) => (item.stepsOpen = e.currentTarget.open) },
        h("summary", {}, v.stepsText, h("span", { class: "chev" }, "›")),
        v.stepsList,
      );
    }
    setText(
      v.stepsText,
      working
        ? item.steps[item.steps.length - 1].split("\n")[0]
        : `${item.segment ? "" : "已完成 "}${item.steps.length} 步${item.segment ? "过程" : ""}`,
    );
    v.stepsText.classList.toggle("shimmer", working);
    // 步骤只会往后加，补上新的就行
    const ol = v.stepsList;
    if (ol.childElementCount > item.steps.length) ol.replaceChildren();
    for (let i = ol.childElementCount; i < item.steps.length; i++) ol.append(h("li", {}, item.steps[i]));
  }

  // 定时任务这次没什么要说的：折叠成一行，展开能看到它顺手记的检查结果
  const bodyKey = silent ? `silent\n${body}` : body ? "md" : "";
  if (v.bodyKey !== bodyKey) {
    v.bodyKey = bodyKey;
    v.body = silent
      ? body
        ? h("details", { class: "silent-run" }, h("summary", {}, "🔕 定时任务：这次无需提醒"), renderMarkdown(body, { enhance: linkReplyFiles }))
        : h("div", { class: "silent-run" }, "🔕 定时任务：这次无需提醒")
      : body
        ? h("div", { class: "md" })
        : null;
  }
  if (bodyKey === "md") patchMarkdown(v.body, body, { live: working, enhance: linkReplyFiles });

  // 还在回复：末尾挂上星星动画和实时用时；什么都还没出来时旁边带一句「思考中…」
  if (working) {
    if (!v.thinking) {
      v.hint = h("span", { class: "shimmer" }, "思考中…");
      v.thinking = h(
        "div",
        { class: "thinking" },
        starsLoader(),
        item.startAt ? h("span", { class: "ai-elapsed", "data-start": item.startAt }, liveDuration(serverNow() - item.startAt)) : null,
      );
    }
    const hint = !body && item.steps.length === 0;
    if (hint && !v.hint.isConnected) v.thinking.firstChild.after(v.hint);
    else if (!hint) v.hint.remove();
  } else v.thinking = null;

  if (!item.error) v.error = null;
  else if (v.error?.textContent !== item.error) v.error = h("div", { class: "error-box" }, item.error);

  placeChildren(item.el, [v.steps, v.body, v.thinking, v.error, renderAiActions(item, body)]);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** 按顺序放好子元素：不要的删掉，缺的插进去，已经在的不挪（挪动会让动画重播、滚动位置复位） */
function placeChildren(parent, nodes) {
  const want = new Set(nodes.filter(Boolean));
  for (const c of [...parent.childNodes]) if (!want.has(c)) c.remove();
  let ref = parent.firstChild;
  for (const n of want) {
    if (n === ref) ref = ref.nextSibling;
    else parent.insertBefore(n, ref);
  }
}

function renderAiActions(item, body) {
  return item.done && !item.segment && (body || item.footer)
    ? h(
        "div",
        { class: "ai-actions" },
        body ? h("button", { class: "icon-btn", title: "复制", onclick: () => copyText(body) }, icon("copy")) : null,
        item.anchor && S.convs.get(S.current)?.canFork
          ? h("button", { class: "icon-btn", title: "从这里分叉成新对话", onclick: () => forkConversation(item.anchor) }, icon("fork"))
          : null,
        item.footer || item.at
          ? h("span", { class: "footer-note" }, [item.at ? clockTime(item.at) : "", tidyFooter(item.footer)].filter(Boolean).join("　"))
          : null,
      )
    : null;
}

/**
 * 这一轮的开始时间（服务端时钟）：从用户发出那条消息算起。中途插了授权 / 提问卡片、
 * 回复拆成好几段时，后面的段接着这个时间算，显示的是整轮的总用时。
 * 没有用户消息就开始的一轮（比如后台任务跑完 agent 自己接着干），从第一个事件算起。
 */
let turnStartAt = null;

function currentAi(ts) {
  if (!S.turnAi || S.turnAi.done) {
    turnStartAt ??= ts ?? serverNow();
    S.turnAi = addItem({ type: "ai", steps: [], committed: "", partial: "", done: false, startAt: turnStartAt });
  }
  return S.turnAi;
}

export function applyEvent(env) {
  if (env.key !== S.current) return;
  const last = S.seq.get(env.key) ?? 0;
  if (env.seq <= last) return;
  S.seq.set(env.key, env.seq);
  const ev = env.ev;
  switch (ev.type) {
    case "user_anchor": {
      const item = S.items.find((it) => it.type === "user" && it.id === ev.id);
      if (item) item.anchor = ev.anchor;
      return;
    }
    case "history_reset": {
      if (S.editingMessage === env.key) return;
      const uploads = S.uploads;
      void openConversation(env.key).then(() => {
        if (S.current !== env.key) return;
        S.uploads = uploads;
        renderChips();
      });
      return;
    }
    case "user": {
      // 排队的消息：正在进行的那一轮照常在上面接着输出，这条等轮到它（queue 事件）再挂占位
      const queued = !!ev.queued;
      if (!queued && S.turnAi && !S.turnAi.done && S.turnAi.steps.length === 0 && !S.turnAi.committed) {
        // 上一个占位还空着（比如消息被当成了作答），不再多留一个
        S.turnAi.el.remove();
        S.items = S.items.filter((i) => i !== S.turnAi);
        S.turnAi = null;
      }
      if (!queued && (!S.turnAi || S.turnAi.done)) turnStartAt = env.ts;
      const it = addItem({ type: "user", text: ev.text, files: ev.files ?? ev.attachments, origin: ev.origin, id: ev.id, queued });
      // 这个页面刚发的：普通消息顶到最上面，排队消息等轮到它时再定位。
      if (S.pinNext && ev.origin?.channel === "web") {
        S.pinNext = false;
        if (queued) it.pinOnStart = true;
        else pinToTop(it.el);
      }
      if (!queued) currentAi(env.ts);
      return;
    }
    case "ix": {
      // 这里弹过一张卡：实时的由 WS 的 ix 消息放（upsertInteraction），这里只管重放时把它放回原位
      const ix = S.pending.get(ev.id) ?? replayCards.get(ev.id);
      if (ix) insertCard(ix);
      return;
    }
    case "queue": {
      const it = S.items.find((i) => i.type === "user" && i.id === ev.id);
      if (it && ev.state === "removed") {
        it.el.remove();
        S.items = S.items.filter((item) => item !== it);
        if (ui.pinEl === it.el) ui.pinEl = null;
        scheduleNav();
        afterLayout();
        return;
      }
      if (it) setQueueState(it, ev.state === "dropped" ? "dropped" : null);
      if (it?.pinOnStart && ev.state === "started") {
        it.pinOnStart = false;
        if (ui.follow) pinToTop(it.el);
      }
      // 轮到它了（上一轮刚出结果）：挂上「思考中」占位，用时从现在算。被当成提问的回答时那一轮还在跑，不用挂
      if (ev.state === "started" && (!S.turnAi || S.turnAi.done)) {
        turnStartAt = env.ts;
        currentAi(env.ts);
      }
      return;
    }
    case "step": {
      const ai = currentAi(env.ts);
      ai.steps.push(ev.text);
      updateItem(ai);
      return;
    }
    case "todos":
      setTodos(ev.todos);
      return;
    case "delta": {
      const ai = currentAi(env.ts);
      ai.partial += ev.text;
      updateItem(ai);
      return;
    }
    case "text": {
      const ai = currentAi(env.ts);
      ai.committed += (ai.committed ? "\n\n" : "") + ev.text;
      ai.partial = "";
      updateItem(ai);
      return;
    }
    case "result": {
      const ai = currentAi(env.ts);
      if (!ai.committed && ev.text) ai.committed = ev.text;
      ai.partial = "";
      ai.done = true;
      ai.footer = ev.footer;
      ai.at = ev.at;
      ai.anchor = ev.anchor;
      updateItem(ai);
      S.turnAi = null;
      turnStartAt = null;
      return;
    }
    case "error": {
      if (S.turnAi && !S.turnAi.done) {
        S.turnAi.done = true;
        S.turnAi.error = ev.message;
        updateItem(S.turnAi);
        S.turnAi = null;
      } else addItem({ type: "error", text: ev.message });
      turnStartAt = null;
      return;
    }
    case "notice":
      addItem({ type: "notice", text: ev.text });
      return;
    case "state":
      setBusy(ev.busy);
      if (!ev.busy && S.turnAi && !S.turnAi.done) {
        S.turnAi.done = true;
        updateItem(S.turnAi);
        S.turnAi = null;
      }
      if (!ev.busy) turnStartAt = null;
      return;
    case "meta":
      return;
  }
}
