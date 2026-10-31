import { fill, h, icon, ICON, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { desktop, S, ui } from "../state.js";
import { baseName } from "./topbar.js";
import { newDraft, openConversation } from "./messages.js";
import { convExpert, expertIcon, setDraftExpert } from "./experts.js";
import { leaveRemote } from "./remote.js";
import { reportShellState } from "../lib/shell.js";
import { syncSidebarNav } from "./sidebar-nav.js";

// ---------- 侧栏标题跑马灯：名字被省略时，hover 来回滚动显示全名 ----------

export const marquee = { el: null, raf: 0 };

export function startMarquee(el) {
  stopMarquee();
  const dist = el.scrollWidth - el.clientWidth;
  if (dist <= 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  marquee.el = el;
  el.classList.add("marquee");
  const speed = 45; // px/s
  const run = dist / speed * 1000;
  const pause = 700;
  const cycle = (pause + run) * 2;
  let t0 = null;
  const step = (now) => {
    if (marquee.el !== el) return;
    t0 ??= now;
    const t = (now - t0) % cycle;
    // 停 → 滚到末尾 → 停 → 滚回开头
    let x;
    if (t < pause) x = 0;
    else if (t < pause + run) x = ((t - pause) / run) * dist;
    else if (t < pause * 2 + run) x = dist;
    else x = dist - ((t - pause * 2 - run) / run) * dist;
    el.scrollLeft = x;
    marquee.raf = requestAnimationFrame(step);
  };
  marquee.raf = requestAnimationFrame(step);
}

export function stopMarquee() {
  cancelAnimationFrame(marquee.raf);
  if (marquee.el) {
    marquee.el.scrollLeft = 0;
    marquee.el.classList.remove("marquee");
  }
  marquee.el = null;
}

// ---------- 侧栏宽度（桌面端可拖动） ----------

const SIDE_MIN = 200;
const SIDE_MAX = 520;

export function setSideWidth(w) {
  if (w == null) {
    document.documentElement.style.removeProperty("--side-w");
    localStorage.removeItem("aim.sideW");
    return;
  }
  const px = Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, w, innerWidth - 360)));
  document.documentElement.style.setProperty("--side-w", `${px}px`);
  return px;
}

{
  const saved = Number(localStorage.getItem("aim.sideW"));
  if (saved) setSideWidth(saved);
}

export function startSideResize(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const left = ui.sidebar.getBoundingClientRect().left;
  let last = null;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("side-resizing");
  const move = (ev) => (last = setSideWidth(ev.clientX - left));
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    document.body.classList.remove("side-resizing");
    if (last) localStorage.setItem("aim.sideW", String(last));
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

export function openSide() {
  ui.layout.classList.add("side-open");
  nudgeStatusBar();
}

export function closeSide() {
  if (!ui.layout?.classList.contains("side-open")) return;
  ui.layout.classList.remove("side-open");
  nudgeStatusBar();
}

/**
 * iOS 26 的 PWA 会按页面顶部的颜色给状态栏上色，而且元素变了不一定重算，
 * 侧栏遮罩关掉后状态栏还是暗的。重设一遍 theme-color 逼它刷新。
 */
function nudgeStatusBar() {
  requestAnimationFrame(() => {
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const v = meta.getAttribute("content");
      meta.setAttribute("content", "");
      meta.setAttribute("content", v);
    }
  });
}

// ---------- 侧边栏 ----------

let sidebarScheduled = false;
export function scheduleSidebar() {
  if (sidebarScheduled) return;
  sidebarScheduled = true;
  requestAnimationFrame(() => {
    sidebarScheduled = false;
    renderSidebar();
    reportDesktop();
  });
}

/**
 * 把一组会话按分叉关系排成树：父对话也在这一组里的，挂到父对话下面；其余的是根。
 * 节点 { c, kids, at }，at 是整棵子树里最近的活跃时间。根和同级都按 at 从新到旧。
 */
function forkForest(convs) {
  const byKey = new Map(convs.map((c) => [c.key, c]));
  const nodes = new Map(convs.map((c) => [c.key, { c, kids: [], at: c.activeAt }]));
  // 父链里绕回自己（数据坏了）就当根处理，免得整串都不显示
  const parentOf = (c) => {
    if (!c.forkOf || !byKey.has(c.forkOf)) return null;
    for (let p = byKey.get(c.forkOf), n = 0; p && n < 50; p = byKey.get(p.forkOf), n++) {
      if (p.key === c.key) return null;
    }
    return c.forkOf;
  };
  const roots = [];
  for (const c of convs) {
    const parent = parentOf(c);
    (parent ? nodes.get(parent).kids : roots).push(nodes.get(c.key));
  }
  const settle = (node) => {
    for (const k of node.kids) node.at = Math.max(node.at, settle(k));
    node.kids.sort((a, b) => b.at - a.at);
    return node.at;
  };
  for (const r of roots) settle(r);
  return roots.sort((a, b) => b.at - a.at);
}

/** 整棵子树里所有分叉的 key（不含自己） */
function descendantKeys(node) {
  return node.kids.flatMap((k) => [k.c.key, ...descendantKeys(k)]);
}

/** 标题后面的小三角：朝下是展开，朝右是折叠。onToggle 给了就自己响应点击（不触发整行的点击） */
function caret(folded, onToggle) {
  return h("span", {
    class: `caret${folded ? " folded" : ""}`,
    html: ICON.caret,
    role: onToggle ? "button" : null,
    title: onToggle ? (folded ? "展开分叉" : "折叠分叉") : null,
    onclick: onToggle
      ? (e) => {
          e.stopPropagation();
          onToggle();
        }
      : null,
  });
}

/**
 * 画一棵分叉树：主对话一行（标题后面带三角），分叉缩进挂在下面，左边一条竖线，最后一条拐个圆角（样式见 .fork-node）。
 * 折叠了就只留一行「N 个嵌套会话」。row(c, orphan, fold)
 */
function renderForkNode(node, row) {
  const orphan = !!node.c.forkOf && !node.parentShown;
  if (node.kids.length === 0) return row(node.c, orphan);
  const key = node.c.key;
  const folded = sideState.forkFolded.includes(key);
  const nested = descendantKeys(node);
  const toggle = () => toggleSide("forkFolded", key);
  return h(
    "div",
    { class: "fork-group" },
    row(node.c, orphan, { folded, keys: [key, ...nested], toggle }),
    h(
      "div",
      { class: "fork-children" },
      folded
        ? h("div", { class: "fork-node" }, h("button", { class: "conv-item fork-more", onclick: toggle }, h("span", { class: "title" }, `${nested.length} 个嵌套会话`)))
        : node.kids.map((k) => h("div", { class: "fork-node" }, renderForkNode({ ...k, parentShown: true }, row))),
    ),
  );
}

/** 标题放不下的行加 .clip：尾巴淡出（代替省略号）。重绘、侧栏变宽窄时重新量 */
function markClipped() {
  for (const el of ui.convList.querySelectorAll(".conv-item .title")) {
    el.classList.toggle("clip", el.scrollWidth > el.clientWidth + 1);
  }
}
let clipObserver = null;

/** 分叉出来的对话：提示里写上从哪条来的 */
function forkNote(c) {
  if (!c.forkOf) return "";
  const parent = S.convs.get(c.forkOf);
  return `\n分叉自「${parent ? convTitle(parent) : "已删除的对话"}」`;
}

export function convTitle(c) {
  if (!c) return "新对话";
  if (c.title) return c.title;
  if (c.channel === "feishu") return `飞书会话 ${c.key.split(":")[2]?.slice(-6) ?? ""}`;
  return "新对话";
}

export function agentLabel(id) {
  return S.agents.find((a) => a.id === id)?.label ?? id;
}

/** 会话名后面的专家图标，鼠标悬停在会话行上时显示 */
function convExpertMark(c) {
  if (!c) return null;
  const expert = convExpert(c);
  return h("span", { class: "expert-mark", title: `专家：${expert.name}` }, expertIcon(expert, "expert-mark-icon"));
}

function agentShort(id) {
  return id === "claude" ? "Claude" : id === "codex" ? "Codex" : id;
}

/** 侧栏状态：order 混排目录路径和 feishu:<机器人 id>，兼容原有的目录顺序。 */
export const sideState = { open: [], botOpen: [], more: [], folded: [], forkFolded: [], order: [], ...JSON.parse(localStorage.getItem("aim.side") || "{}") };

/**
 * 项目和飞书分组共用 sideState.order，新消息不会改变分组位置。
 * 顺序存在服务端、跟着账号走（换设备也一样）；新出现的分组接在最后，
 * 接上之后名次也就定了
 */
function orderSidebarGroups(dirs) {
  const rank = new Map(sideState.order.map((d, i) => [d, i]));
  const ranked = dirs.filter((d) => rank.has(d)).sort((a, b) => rank.get(a) - rank.get(b));
  const fresh = dirs.filter((d) => !rank.has(d));
  if (fresh.length && orderSynced) {
    sideState.order = [...sideState.order, ...fresh];
    saveSideState();
    void putDirOrder({ append: fresh });
  }
  return [...ranked, ...fresh];
}

/** 拿到服务端存的顺序之前不往上写，免得这台设备本地的旧顺序盖掉别处排好的 */
let orderSynced = false;

function saveSideState() {
  localStorage.setItem("aim.side", JSON.stringify(sideState));
}

async function putDirOrder(body) {
  try {
    const data = await api("/api/ui/dir-order", { method: "PUT", body });
    // 追加时以服务端的为准（别的设备可能刚排过）
    if (body.append && data?.order && data.order.join("\n") !== sideState.order.join("\n")) {
      sideState.order = data.order;
      saveSideState();
      scheduleSidebar();
    }
  } catch (err) {
    toast(`保存侧栏顺序失败：${err.message}`);
  }
}

/** 飞书的排序键与绝对目录路径分开，改机器人名称不会影响位置。 */
export const botGroupId = (id) => `feishu:${id}`;

/** 当前侧栏里显示的混合顺序（拖拽 / 右键菜单用） */
export let sidebarGroups = [];
/** 同一批分组按最近活跃的顺序（「按最近活跃重排」用） */
let groupsByActivity = [];

/** 移到另一个分组前 / 后；target 为 null 时置顶。隐藏的分组仍保留在已存顺序中。 */
export function moveSidebarGroup(dir, target, after = false) {
  if (dir === target) return;
  const list = sidebarGroups.filter((d) => d !== dir);
  const idx = target === null ? 0 : list.indexOf(target);
  if (idx < 0) return;
  list.splice(idx + (after ? 1 : 0), 0, dir);
  // 暂时没显示出来的目录（会话都被隐藏了之类）保留原来的名次，排在后面
  setSidebarGroupOrder([...list, ...sideState.order.filter((d) => !list.includes(d))]);
}

/** 按最近活跃重排一次，之后照样固定 */
export function resetSidebarGroupOrder() {
  setSidebarGroupOrder([...groupsByActivity, ...sideState.order.filter((d) => !groupsByActivity.includes(d))]);
}

function setSidebarGroupOrder(order) {
  sideState.order = order;
  saveSideState();
  if (orderSynced) void putDirOrder({ order });
  renderSidebar();
}

/** 拖动过程中暂停重绘，防止被拖的元素被替换；结束后补上更新。 */
let groupDrag = null;
let sidebarStale = false;

function groupDragAttrs(id) {
  const clearDrop = () => ui.convList.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
  const isAfter = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const endDrag = () => {
    groupDrag = null;
    clearDrop();
    if (sidebarStale) renderSidebar();
  };
  return {
    draggable: "true",
    ondragstart: (e) => {
      groupDrag = id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      e.currentTarget.classList.add("dragging");
      stopMarquee();
    },
    ondragend: (e) => {
      e.currentTarget.classList.remove("dragging");
      endDrag();
    },
    ondragover: (e) => {
      if (!groupDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const after = isAfter(e);
      if (!e.currentTarget.classList.contains(after ? "drop-after" : "drop-before")) {
        clearDrop();
        if (groupDrag !== id) e.currentTarget.classList.add(after ? "drop-after" : "drop-before");
      }
    },
    ondragleave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove("drop-before", "drop-after");
    },
    ondrop: (e) => {
      if (!groupDrag) return;
      e.preventDefault();
      const from = groupDrag;
      const after = isAfter(e);
      groupDrag = null;
      clearDrop();
      if (from !== id) moveSidebarGroup(from, id, after);
      else if (sidebarStale) renderSidebar();
    },
  };
}

function toggleSide(list, id) {
  const set = new Set(sideState[list]);
  set.has(id) ? set.delete(id) : set.add(id);
  sideState[list] = [...set];
  localStorage.setItem("aim.side", JSON.stringify(sideState));
  renderSidebar();
}

let autoOpenedFor = null;
const RECENT_LIMIT = 10;
const PROJECT_LIMIT = 5;
/** 「展开显示」一次多显示几条 */
const MORE_STEP = 10;

// ---------- 分页（服务端见 channels/web/conv-pages.ts） ----------
// 打开页面只拿「最近」的前 10 条、展开着的目录各自的前 5 条（一条 = 主对话连同它的分叉），
// 正在跑的、等你处理的、每个飞书机器人最近的一条也都在；点「展开显示」多显示 10 条，本地不够再按页拉。
// 新出现的、变活跃的会话经 WebSocket 的 conv 消息补进 S.convs。
// next：下一页的游标；null = 没有更多了；undefined = 这个目录还没拉过。

/** full：老版本服务端一次给了全部，不用再拉 */
const pages = { recent: { show: RECENT_LIMIT, next: null, loading: false }, dirs: new Map(), bots: new Map(), dirAt: new Map(), full: false };

function dirState(dir) {
  let st = pages.dirs.get(dir);
  if (!st) pages.dirs.set(dir, (st = { show: PROJECT_LIMIT, next: pages.full ? null : undefined, loading: false }));
  return st;
}

function botState(id) {
  let st = pages.bots.get(id);
  if (!st) pages.bots.set(id, (st = { show: PROJECT_LIMIT, next: pages.full ? null : undefined, loading: false }));
  return st;
}

/** /api/bootstrap 的参数：按现在显示了多少条要（重连后整份换掉时，已经展开的不会缩回去） */
export function bootstrapQuery() {
  const q = new URLSearchParams({ recent: String(pages.recent.show), open: JSON.stringify(sideState.open.map((d) => [d, dirState(d).show])) });
  // 正开着的会话；刚打开页面时是地址里带的那条（可能在后面几页）
  const current = S.current ?? decodeURIComponent(location.hash.slice(1));
  if (current) q.set("current", current);
  return `?${q}`;
}

export function applyBootstrap(data) {
  S.sidebarNav = data.sidebarNav ?? null;
  S.convs = new Map(data.conversations.map((c) => [c.key, c]));
  pages.full = !data.sidebar;
  // bootstrap 只带每个机器人最近的一条；展开的列表需要重新补齐。
  for (const st of pages.bots.values()) {
    st.next = pages.full ? null : undefined;
    st.failed = false;
  }
  pages.recent.next = data.sidebar?.recent.next ?? null;
  pages.dirAt = new Map((data.sidebar?.dirs ?? []).map((d) => [d.dir, d.at]));
  const fetched = new Map((data.sidebar?.dirs ?? []).filter((d) => "next" in d).map((d) => [d.dir, d.next]));
  for (const [dir, st] of pages.dirs) {
    // 这次要了的（展开着的）目录用新游标；没要的下次展开时重新拉
    st.next = pages.full ? null : sideState.open.includes(dir) ? (fetched.get(dir) ?? null) : undefined;
  }
  for (const [dir, next] of fetched) dirState(dir).next = next;
  // 老版本服务端没有这个字段：顺序只存在本地
  if ("dirOrder" in data) {
    if (data.dirOrder) {
      sideState.order = data.dirOrder;
      saveSideState();
    } else if (sideState.order.length) {
      // 以前只存在这台设备上的顺序，第一次搬到服务端
      void putDirOrder({ order: sideState.order });
    }
    orderSynced = true;
  }
}

/** 拉下一页，合进 S.convs。失败了不自动重试（否则每次重绘都去拉），点「展开显示」再试 */
async function fetchPage(st, params) {
  if (st.loading) return;
  st.loading = true;
  st.failed = false;
  try {
    const q = new URLSearchParams(params);
    if (st.next) {
      q.set("at", String(st.next.at));
      q.set("key", st.next.key);
    }
    const data = await api(`/api/conversations/page?${q}`);
    for (const c of data.conversations) S.convs.set(c.key, c);
    st.next = data.next;
  } catch (err) {
    st.failed = true;
    toast(`会话列表加载失败：${err.message}`);
  } finally {
    st.loading = false;
    scheduleSidebar();
  }
}

/**
 * 只显示连续拉到的那一段：比下一页游标还旧的（正在跑的、地址里带的老会话先拉来了），
 * 中间还隔着没拉的，先不显示，免得顺序看着跳
 */
const loadedPrefix = (st, list) => (st.next ? list.filter((x) => x.at >= st.next.at) : list);

/** 「展开显示」「收起」：count 是能显示的条数，limit 是默认显示几条 */
function moreButton(st, count, limit, load) {
  if (st.loading) return h("button", { class: "conv-more", disabled: true }, "加载中…");
  if (count > st.show || st.next) {
    return h(
      "button",
      {
        class: "conv-more",
        onclick: () => {
          st.show += MORE_STEP;
          if (count < st.show && st.next) void load(Math.max(MORE_STEP, st.show - count));
          renderSidebar();
        },
      },
      "展开显示",
    );
  }
  if (st.show > limit) return h("button", { class: "conv-more", onclick: () => ((st.show = limit), renderSidebar()) }, "收起");
  return null;
}

/** 待处理的授权 / 提问和正在跑的会话，报给桌面端显示在菜单栏里 */
export function reportDesktop() {
  const open = [...S.pending.values()].filter((i) => !i.settled);
  const busy = [...S.convs.values()].filter((c) => c.busy).length;
  // 多服务器：左上角切换列表里这台的角标
  reportShellState(open.length, busy);
  if (!desktop) return;
  const pending = open.map((i) => ({ id: i.id, key: i.convKey, title: i.spec.title, conv: convTitle(S.convs.get(i.convKey)) }));
  desktop.setState({ pending, busy });
}

export function renderSidebar() {
  if (!ui.convList) return;
  if (groupDrag) {
    sidebarStale = true;
    return;
  }
  sidebarStale = false;
  syncSidebarNav();
  const askKeys = new Set([...S.pending.values()].filter((i) => !i.settled).map((i) => i.convKey));
  const visible = [...S.convs.values()].filter((c) => !c.hidden).sort((a, b) => b.activeAt - a.activeAt);
  const cur = S.current ? S.convs.get(S.current) : null;
  const status = (keys) =>
    keys.some((k) => askKeys.has(k))
      ? h("span", { class: "dot ask", title: "等你处理" })
      : keys.some((k) => S.convs.get(k)?.busy)
        ? h("span", { class: "conv-spin", title: "进行中" })
        : null;
  const open = (key) => {
    closeSide();
    if (key !== S.current) void openConversation(key);
    // 在远程控制页上点进来之前那条对话：对话没动过，退出远程控制就露出来了
    else if (S.view === "remote") leaveRemote();
  };
  // 一行会话。orphan：是分叉出来的、但父对话不在这一组里（删了 / 在别的目录），没有连线可画，用图标标一下。
  // fold：有分叉的主对话，标题后面挂三角；折叠着时分叉的状态也显示在这一行
  const convRow = (c, cls, detail, orphan, fold) =>
    h(
      "button",
      {
        class: `conv-item${cls}${c.key === S.current && !S.view ? " active" : ""}`,
        "data-key": c.key,
        title: `${convTitle(c)}${forkNote(c)}\n${detail}\n双击重命名，右键更多操作`,
        onclick: () => open(c.key),
      },
      orphan ? h("span", { class: "brand-icon lead fork-mark", html: ICON.fork }) : null,
      h("span", { class: "title" }, convTitle(c)),
      fold ? caret(fold.folded, fold.toggle) : null,
      status(fold?.folded ? fold.keys : [c.key]),
      convExpertMark(c),
      c.taskId ? h("span", { class: "brand-icon task-mark", title: "定时任务的对话", html: ICON.clock }) : null,
    );

  // 飞书和项目共用排序，展开后的会话跟随所属分组。
  if (cur?.channel === "feishu" && cur.key !== autoOpenedFor) {
    autoOpenedFor = cur.key;
    if (!sideState.botOpen.includes(cur.channelId)) {
      sideState.botOpen.push(cur.channelId);
      saveSideState();
    }
  }
  const botRows = [];
  for (const bot of S.bots) {
    const convs = visible.filter((c) => c.channel === "feishu" && c.channelId === bot.id);
    if (bot.enabled === false && convs.length === 0) continue;
    const latest = convs[0];
    const expanded = sideState.botOpen.includes(bot.id);
    const rows = [h(
      "div",
      { class: "proj-row bot-row", "data-bot": bot.id, ...groupDragAttrs(botGroupId(bot.id)) },
      h(
        "button",
        {
          class: "conv-item proj",
          title: `飞书 · ${bot.name}\n拖动可调整顺序，右键更多操作`,
          "aria-expanded": String(expanded),
          onclick: () => toggleSide("botOpen", bot.id),
        },
        h("span", { class: "title" }, bot.name),
        caret(!expanded),
        expanded ? null : status(convs.map((c) => c.key)),
      ),
      h(
        "button",
        {
          class: "proj-new bot-new",
          title: `使用 ${bot.name} 的专家和工作目录开新对话`,
          "aria-label": `使用 ${bot.name} 的专家和工作目录开新对话`,
          onclick: () => {
            S.draftCwd = latest?.cwd && latest.cwd !== S.workspaceRoot ? latest.cwd : null;
            S.draftCwdPicked = true;
            const expert = latest?.expert?.id ?? latest?.agent ?? bot.agents?.[0];
            if (expert) setDraftExpert(expert);
            newDraft();
            closeSide();
          },
        },
        h("span", { class: "brand-icon feishu-mark", html: ICON.feishu, "aria-hidden": "true" }),
        h("span", { class: "bot-plus", "aria-hidden": "true" }, icon("plus")),
      ),
    )];
    if (expanded) {
      const st = botState(bot.id);
      const load = (limit) => fetchPage(st, { scope: "bot", bot: bot.id, limit: String(limit) });
      if (st.next === undefined && !st.loading && !st.failed) void load(st.show);
      const forest = loadedPrefix(st, forkForest(convs));
      for (const node of forest.slice(0, st.show)) {
        rows.push(renderForkNode(node, (c, orphan, fold) => convRow(c, " sub", `${agentLabel(c.agent)} · ${c.cwd}`, orphan, fold)));
      }
      if (!convs.length && !st.loading && !st.failed) rows.push(h("div", { class: "conv-empty sub" }, "还没有会话"));
      if (st.failed) rows.push(h("button", { class: "conv-more", onclick: () => { void load(st.show); renderSidebar(); } }, "加载失败，点击重试"));
      const btn = moreButton(st, forest.length, PROJECT_LIMIT, load);
      if (btn) rows.push(h("div", { class: "sub-more" }, btn));
    }
    botRows.push({
      id: botGroupId(bot.id),
      at: latest?.activeAt ?? 0,
      rows,
    });
  }

  // ---- Web 会话直接按工作目录分组，目录按用户排的顺序（见 orderSidebarGroups） ----
  const byDir = new Map();
  for (const c of visible.filter((c) => c.channel === "web")) {
    if (!byDir.has(c.cwd)) byDir.set(c.cwd, []);
    byDir.get(c.cwd).push(c);
  }
  // 切到某个会话时，把它所在的目录展开一次（之后用户可以自己收起）
  if (cur?.channel === "web" && cur.key !== autoOpenedFor) {
    autoOpenedFor = cur.key;
    if (!sideState.open.includes(cur.cwd)) {
      sideState.open.push(cur.cwd);
      localStorage.setItem("aim.side", JSON.stringify(sideState));
    }
  }
  // 目录行要全部显示：服务端给了每个目录最近的活跃时间，加上本地已有的（刚建的、刚变活跃的）
  const dirAt = new Map(pages.dirAt);
  for (const [dir, convs] of byDir) dirAt.set(dir, Math.max(dirAt.get(dir) ?? 0, convs[0].activeAt));
  const dirsByActivity = [...dirAt.keys()].sort((a, b) => dirAt.get(b) - dirAt.get(a));
  const groupRows = new Map(botRows.map((group) => [group.id, group.rows]));
  const groupAt = new Map([...dirAt, ...botRows.map((group) => [group.id, group.at])]);
  groupsByActivity = [...groupAt.keys()].sort((a, b) => groupAt.get(b) - groupAt.get(a));
  sidebarGroups = orderSidebarGroups([...dirsByActivity, ...botRows.sort((a, b) => b.at - a.at).map((group) => group.id)]);
  if (dirAt.size) {
    for (const dir of dirsByActivity) {
      const convs = byDir.get(dir) ?? [];
      const expanded = sideState.open.includes(dir);
      const rows = [];
      groupRows.set(dir, rows);
      rows.push(
        h(
          "div",
          { class: "proj-row", "data-dir": dir, ...groupDragAttrs(dir) },
          h(
            "button",
            { class: "conv-item proj", title: `${dir}\n拖动可调整顺序，右键可置顶`, onclick: () => toggleSide("open", dir) },
            h("span", { class: "title" }, baseName(dir)),
            caret(!expanded),
            expanded ? null : status(convs.map((c) => c.key)),
          ),
          h(
            "button",
            {
              class: "proj-new",
              title: `在 ${baseName(dir)} 中开新对话`,
              onclick: async (e) => {
                const button = e.currentTarget;
                button.disabled = true;
                try {
                  let latest = convs[0];
                  // 收起的项目可能只加载了旧会话，先补齐最近一棵树，再按会话活跃时间选。
                  if (!pages.full && (!latest || latest.activeAt < (pages.dirAt.get(dir) ?? 0))) {
                    const q = new URLSearchParams({ scope: "dir", dir, limit: "1" });
                    const data = await api(`/api/conversations/page?${q}`);
                    for (const c of data.conversations) S.convs.set(c.key, c);
                    latest = [...S.convs.values()]
                      .filter((c) => !c.hidden && c.channel === "web" && c.cwd === dir)
                      .sort((a, b) => b.activeAt - a.activeAt)[0];
                  }
                  S.draftCwd = dir === S.workspaceRoot ? null : dir;
                  S.draftCwdPicked = true;
                  if (latest) setDraftExpert(latest.expert?.id ?? latest.agent);
                  newDraft();
                  closeSide();
                } catch (err) {
                  toast(`新对话创建失败：${err.message}`);
                } finally {
                  button.disabled = false;
                }
              },
            },
            icon("plus"),
          ),
        ),
      );
      if (!expanded) continue;
      // 刚展开、还没拉过这个目录：去拉第一页（本地可能已经有几条正在跑的，先显示着）
      const st = dirState(dir);
      const load = (limit) => fetchPage(st, { scope: "dir", dir, limit: String(limit) });
      if (st.next === undefined && !st.loading && !st.failed) void load(st.show);
      // 「展开显示」按主对话算条数，分叉跟着主对话一起出现
      const forest = loadedPrefix(st, forkForest(convs));
      for (const node of forest.slice(0, st.show)) {
        rows.push(renderForkNode(node, (c, orphan, fold) => convRow(c, " sub", agentLabel(c.agent), orphan, fold)));
      }
      const btn = moreButton(st, forest.length, PROJECT_LIMIT, load);
      if (btn) rows.push(h("div", { class: "sub-more" }, btn));
    }
  }
  const nodes = sidebarGroups.flatMap((id) => groupRows.get(id) ?? []);
  if (!nodes.length) nodes.push(h("div", { class: "conv-empty" }, "还没有会话"));
  paintList(nodes, askKeys.size);
}

/** 把一组节点画进会话列表 */
function paintList(nodes, asks) {
  // 重绘会换掉 DOM：如果鼠标正停在某个标题上，重绘后接着滚
  const hovered = marquee.el ? marquee.el.textContent : null;
  stopMarquee();
  fill(ui.convList, ...nodes);
  markClipped();
  if (!clipObserver) {
    clipObserver = new ResizeObserver(() => markClipped());
  }
  clipObserver.disconnect();
  clipObserver.observe(ui.convList);
  // hover 显示专家图标时，标题的可用宽度也会变化
  for (const el of ui.convList.querySelectorAll(".conv-item .title")) clipObserver.observe(el);
  if (hovered) {
    requestAnimationFrame(() => {
      const el = ui.convList.querySelector(".conv-item:hover .title");
      if (el?.textContent === hovered) startMarquee(el);
    });
  }
  document.title = asks ? `(${asks}) 待处理 · Agent Loft` : "Agent Loft";
}
