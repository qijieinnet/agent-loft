import { agentIcon, fill, h, icon, starsLoader } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { clockTime, liveDuration, serverNow, setServerTime, tidyFooter } from "../lib/time.js";
import { copyText, renderMarkdown } from "../lib/markdown.js";
import { S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { agentLabel, convTitle, renderSidebar } from "./sidebar.js";
import { baseName, renderContext, renderTopbar, updateCtxVisibility, usableAgents } from "./topbar.js";
import { renderInteraction, upsertInteraction } from "./interaction.js";
import { renderChips, setBusy } from "./composer.js";
import { renderScheduled } from "./schedule.js";
import { changeCwd, forkConversation } from "./conv-actions.js";

// ---------- 打开会话 ----------

export function newDraft() {
  if (S.current) WS.raw({ t: "unsub", key: S.current });
  S.current = null;
  S.items = [];
  S.turnAi = null;
  turnStartAt = null;
  S.uploads = [];
  S.pinNext = false;
  ui.pinEl = null;
  ui.follow = true;
  setBusy(false);
  renderScheduled();
  history.replaceState(null, "", location.pathname);
  WS.presence();
  renderTopbar();
  renderEmpty();
  renderChips();
  renderSidebar();
  ui.input?.focus();
}

export function renderEmpty() {
  const enabled = usableAgents();
  const cwd = S.draftCwd ?? S.workspaceRoot ?? "";
  fill(ui.msgInner,
    h(
      "div",
      { class: "empty hero" },
      agentIcon(S.draftAgent, "hero-logo"),
      enabled.length
        ? h(
            "h2",
            {},
            "你想让我们在 ",
            h("button", { class: "hero-dir", title: `${cwd}\n点击切换工作目录`, onclick: () => changeCwd() }, baseName(cwd) || "工作区"),
            " 中构建什么？",
          )
        : [h("h2", {}, "有什么可以帮你？"), h("div", {}, "还没有启用任何 agent，先去设置里启用。")],
    ),
  );
  renderContext();
}

export async function openConversation(key) {
  const token = ++S.loadToken;
  if (S.current && S.current !== key) WS.raw({ t: "unsub", key: S.current });
  S.current = key;
  S.items = [];
  S.turnAi = null;
  turnStartAt = null;
  S.uploads = [];
  S.pinNext = false;
  ui.pinEl = null;
  ui.follow = true;
  renderChips();
  renderScheduled();
  history.replaceState(null, "", `#${encodeURIComponent(key)}`);
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
  S.convs.set(key, data.info);
  S.allowedAgents = data.allowedAgents;
  if (Number.isFinite(data.serverTime)) setServerTime(data.serverTime);
  fill(ui.msgInner, );
  for (const m of data.messages) {
    if (m.role === "user") addItem({ type: "user", text: m.text, files: m.attachments ?? [], origin: null });
    else addItem({ type: "ai", steps: m.steps ?? [], committed: m.text, partial: "", done: true, footer: m.footer, at: m.ts, anchor: m.anchor });
  }
  S.seq.set(key, 0);
  for (const env of data.live) applyEvent(env);
  S.seq.set(key, Math.max(S.seq.get(key) ?? 0, data.seq));
  for (const ix of data.pending) upsertInteraction(ix);
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

// ---------- 消息渲染 ----------

// 滚动规则（和 ChatGPT 一样）：
//   - 自己发出一条消息后，把它顶到视口最上面，下面留白；回复往下长，长到屏幕底部之后才跟着往下滚。
//     留白靠消息列表后面的 ui.spacer 撑出来：高度 = 刚好够那条消息滚到顶，回复越长它越矮，到 0 为止。
//   - 回复过程中只要用户自己滚了（滚轮、触摸、拖滚动条、键盘翻页），就不再自动滚，直到下一次发消息。
//     ui.follow 记着现在要不要自动滚。

function nearBottom(gap = 120) {
  const m = ui.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < gap;
}

/** 内容变了之后：重算留白，要跟随的话贴到底（有留白时「底」正好就是被顶上去的那条消息） */
function afterLayout() {
  if (!ui.messages) return;
  fitSpacer();
  if (ui.follow && performance.now() > (ui.smoothUntil ?? 0)) ui.messages.scrollTop = ui.messages.scrollHeight;
  updateToBottomBtn();
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
  fitSpacer();
  ui.smoothUntil = performance.now() + 450;
  ui.messages.scrollTo({ top: ui.messages.scrollHeight, behavior: "smooth" });
  // 平滑滚动期间留白可能又变了（比如输入框清空变矮），滚完再对齐一次
  setTimeout(afterLayout, 460);
  updateToBottomBtn();
}

/** 用户自己动了滚动：停止自动滚动 */
function userScrolled() {
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
  // 消息区变高（发送后输入框清空变矮）、内容变高都要重算留白；窗口 resize 管不到元素自己变尺寸
  const ro = new ResizeObserver(() => afterLayout());
  ro.observe(m);
  ro.observe(ui.msgInner);
}

/** 只有最后一条回复默认显示底部的操作栏（复制 / 分叉 / 用时…），前面的 hover 才出来 */
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

export function addItem(item) {
  ui.msgInner.querySelector(".empty")?.remove();
  item.el = renderItem(item);
  ui.msgInner.append(item.el);
  S.items.push(item);
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
        item.text ? h("div", { class: "msg-user" }, origin ? h("span", { class: "origin" }, origin) : null, item.text) : null,
        item.text
          ? h("div", { class: "user-actions" }, h("button", { class: "icon-btn", title: "复制", onclick: () => copyText(item.text) }, icon("copy")))
          : null,
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

function renderAi(item) {
  const body = item.committed + (item.partial ? (item.committed ? "\n\n" : "") + item.partial : "");
  const working = !item.done;
  const steps =
    item.steps.length > 0
      ? h(
          "details",
          {
            class: "steps",
            open: item.stepsOpen ?? false,
            ontoggle: (e) => (item.stepsOpen = e.currentTarget.open),
          },
          h(
            "summary",
            {},
            h(
              "span",
              { class: `steps-text${working ? " shimmer" : ""}` },
              working
                ? item.steps[item.steps.length - 1].split("\n")[0]
                : `${item.segment ? "" : "已完成 "}${item.steps.length} 步${item.segment ? "过程" : ""}`,
            ),
            h("span", { class: "chev" }, "›"),
          ),
          h("ol", {}, item.steps.map((s) => h("li", {}, s))),
        )
      : null;
  return h(
    "div",
    { class: "msg-ai" },
    steps,
    body ? renderMarkdown(body) : null,
    // 还在回复：末尾挂上星星动画和实时用时；什么都还没出来时旁边带一句「思考中…」
    working
      ? h(
          "div",
          { class: "thinking" },
          starsLoader(),
          !body && item.steps.length === 0 ? h("span", { class: "shimmer" }, "思考中…") : null,
          item.startAt
            ? h("span", { class: "ai-elapsed", "data-start": item.startAt }, liveDuration(serverNow() - item.startAt))
            : null,
        )
      : null,
    item.error ? h("div", { class: "error-box" }, item.error) : null,
    item.done && !item.segment && (body || item.footer)
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
      : null,
  );
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
    case "user": {
      if (S.turnAi && !S.turnAi.done && S.turnAi.steps.length === 0 && !S.turnAi.committed) {
        // 上一个占位还空着（比如消息被当成了作答），不再多留一个
        S.turnAi.el.remove();
        S.items = S.items.filter((i) => i !== S.turnAi);
        S.turnAi = null;
      }
      // 上一轮还没结束时发的消息会排队，不改正在进行那一轮的开始时间
      if (!S.turnAi || S.turnAi.done) turnStartAt = env.ts;
      const it = addItem({ type: "user", text: ev.text, files: ev.files ?? ev.attachments, origin: ev.origin });
      // 这个页面刚发的：顶到最上面
      if (S.pinNext && ev.origin?.channel === "web") {
        S.pinNext = false;
        pinToTop(it.el);
      }
      currentAi(env.ts);
      return;
    }
    case "step": {
      const ai = currentAi(env.ts);
      ai.steps.push(ev.text);
      updateItem(ai);
      return;
    }
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
