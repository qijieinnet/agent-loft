import { fill, h, icon, ICON, toast } from "../lib/dom.js";
import { desktop, S, ui } from "../state.js";
import { baseName } from "./topbar.js";
import { newDraft, openConversation } from "./messages.js";

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

/** 画一棵分叉树：主对话一行，分叉缩进挂在下面，用虚线连起来（样式见 .fork-node） */
function renderForkNode(node, row, cls = "") {
  const self = row(node.c, !!node.c.forkOf && !node.parentShown);
  if (node.kids.length === 0) return self;
  return h(
    "div",
    { class: "fork-group" },
    self,
    h(
      "div",
      { class: `fork-children${cls}` },
      node.kids.map((k) => h("div", { class: "fork-node" }, renderForkNode({ ...k, parentShown: true }, row))),
    ),
  );
}

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

function agentShort(id) {
  return id === "claude" ? "Claude" : id === "codex" ? "Codex" : id;
}

/** 侧栏里展开 / 收起的状态：哪些项目目录展开了、「最近」和各目录是否显示全部 */
export const sideState = { open: [], more: [], folded: [], order: [], ...JSON.parse(localStorage.getItem("aim.side") || "{}") };

/**
 * 「项目」目录的顺序：没手动排过时按最近活跃；拖过之后按 sideState.order，
 * 之后新出现的目录排在已排好的后面（同样按活跃），不会挤掉用户置顶的目录
 */
function orderProjectDirs(dirs) {
  const rank = new Map(sideState.order.map((d, i) => [d, i]));
  const ranked = dirs.filter((d) => rank.has(d)).sort((a, b) => rank.get(a) - rank.get(b));
  return [...ranked, ...dirs.filter((d) => !rank.has(d))];
}

/** 当前侧栏里显示的目录顺序（renderSidebar 时记下，拖拽 / 右键菜单用） */
export let projDirs = [];

/** 把目录 dir 挪到 target 前面（after 为 true 时挪到后面）；target 为 null 表示挪到最前 */
export function moveProjectDir(dir, target, after = false) {
  if (dir === target) return;
  const list = projDirs.filter((d) => d !== dir);
  const idx = target === null ? 0 : list.indexOf(target);
  if (idx < 0) return;
  list.splice(idx + (after ? 1 : 0), 0, dir);
  // 暂时没显示出来的目录（会话都被隐藏了之类）保留原来的名次，排在后面
  sideState.order = [...list, ...sideState.order.filter((d) => !list.includes(d))];
  localStorage.setItem("aim.side", JSON.stringify(sideState));
  renderSidebar();
}

export function resetProjectOrder() {
  sideState.order = [];
  localStorage.setItem("aim.side", JSON.stringify(sideState));
  renderSidebar();
}

/** 正在拖的目录。拖的过程中侧栏不重绘（重绘会换掉被拖的元素，拖拽就断了），松手后补一次 */
let dirDrag = null;
let sidebarStale = false;

/** 「最近」「项目」分组标题：点击折叠 / 展开，hover 时显示箭头 */
function groupHead(label, id, folded) {
  return h(
    "button",
    { class: `conv-group${folded ? " collapsed" : ""}`, title: folded ? "展开" : "折叠", onclick: () => toggleSide("folded", id) },
    label,
    h("span", { class: "chev", html: ICON.down }),
  );
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

/** 待处理的授权 / 提问和正在跑的会话，报给桌面端显示在菜单栏里 */
export function reportDesktop() {
  if (!desktop) return;
  const pending = [...S.pending.values()]
    .filter((i) => !i.settled)
    .map((i) => ({ id: i.id, key: i.convKey, title: i.spec.title, conv: convTitle(S.convs.get(i.convKey)) }));
  const busy = [...S.convs.values()].filter((c) => c.busy).length;
  desktop.setState({ pending, busy });
}

export function renderSidebar() {
  if (!ui.convList) return;
  if (dirDrag) {
    sidebarStale = true;
    return;
  }
  sidebarStale = false;
  ui.tasksNav?.classList.toggle("active", S.view === "tasks");
  ui.skillsNav?.classList.toggle("active", S.view === "skills");
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
  };
  const more = (list, id, expanded) =>
    h("button", { class: "conv-more", onclick: () => toggleSide(list, id) }, expanded ? "收起" : "展开显示");

  // 一行会话。orphan：是分叉出来的、但父对话不在这一组里（删了 / 在别的目录），没有连线可画，用图标标一下
  const convRow = (c, cls, detail, orphan) =>
    h(
      "button",
      {
        class: `conv-item${cls}${c.key === S.current ? " active" : ""}`,
        "data-key": c.key,
        title: `${convTitle(c)}${forkNote(c)}\n${detail}\n双击重命名，右键更多操作`,
        onclick: () => open(c.key),
      },
      orphan ? h("span", { class: "brand-icon lead fork-mark", html: ICON.fork }) : null,
      // 定时任务的专用对话
      c.taskId ? h("span", { class: "brand-icon lead task-mark", title: "定时任务的对话", html: ICON.clock }) : null,
      h("span", { class: "title" }, convTitle(c)),
      status([c.key]),
    );

  // ---- 最近：Web 会话 + 每个飞书机器人一行（点开它最近活跃的聊天），按活跃时间混排 ----
  // 分叉出来的对话挂在主对话下面，整棵树按里面最近活跃的那条排
  const recent = [];
  for (const node of forkForest(visible.filter((c) => c.channel !== "feishu"))) {
    recent.push({ at: node.at, el: renderForkNode(node, (c, orphan) => convRow(c, "", `${agentLabel(c.agent)} · ${c.cwd}`, orphan)) });
  }
  for (const bot of S.bots) {
    const convs = visible.filter((c) => c.channel === "feishu" && c.channelId === bot.id);
    if (bot.enabled === false && convs.length === 0) continue;
    const latest = convs[0];
    recent.push({
      at: latest?.activeAt ?? 0,
      el: h(
        "button",
        {
          class: `conv-item${cur?.channel === "feishu" && cur.channelId === bot.id ? " active" : ""}`,
          "data-bot": bot.id,
          title: latest ? `飞书 · ${bot.name}\n${agentLabel(latest.agent)} · ${latest.cwd}` : `飞书 · ${bot.name}\n还没有会话`,
          onclick: () => (latest ? open(latest.key) : toast("这个机器人还没有会话，先在飞书里给它发条消息")),
        },
        h("span", { class: "brand-icon lead", title: "飞书", html: ICON.feishu }),
        h("span", { class: "title" }, bot.name),
        status(convs.map((c) => c.key)),
      ),
    });
  }
  recent.sort((a, b) => b.at - a.at);
  const recentAll = sideState.more.includes("@recent");
  const recentFolded = sideState.folded.includes("@recent");
  const nodes = [groupHead("最近", "@recent", recentFolded)];
  if (!recentFolded) {
    if (recent.length === 0) nodes.push(h("div", { class: "conv-empty" }, "还没有会话"));
    nodes.push(...recent.slice(0, recentAll ? recent.length : RECENT_LIMIT).map((r) => r.el));
    if (recent.length > RECENT_LIMIT) nodes.push(more("more", "@recent", recentAll));
  }

  // ---- 项目：Web 会话按工作目录分组，目录按最近活跃排序 ----
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
  const projFolded = sideState.folded.includes("@projects");
  if (byDir.size) nodes.push(groupHead("项目", "@projects", projFolded));
  projDirs = orderProjectDirs([...byDir.keys()]);
  if (byDir.size && !projFolded) {
    const clearDrop = () => ui.convList.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    const endDrag = () => {
      dirDrag = null;
      clearDrop();
      if (sidebarStale) renderSidebar();
    };
    for (const dir of projDirs) {
      const convs = byDir.get(dir);
      const expanded = sideState.open.includes(dir);
      const showAll = sideState.more.includes(dir);
      // 鼠标在目标行的上半截就插到它前面，下半截插到后面
      const isAfter = (e, row) => {
        const r = row.getBoundingClientRect();
        return e.clientY > r.top + r.height / 2;
      };
      nodes.push(
        h(
          "div",
          {
            class: "proj-row",
            "data-dir": dir,
            draggable: "true",
            ondragstart: (e) => {
              dirDrag = dir;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", dir);
              e.currentTarget.classList.add("dragging");
              stopMarquee();
            },
            ondragend: (e) => {
              e.currentTarget.classList.remove("dragging");
              endDrag();
            },
            ondragover: (e) => {
              if (!dirDrag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const after = isAfter(e, e.currentTarget);
              if (!e.currentTarget.classList.contains(after ? "drop-after" : "drop-before")) {
                clearDrop();
                if (dirDrag !== dir) e.currentTarget.classList.add(after ? "drop-after" : "drop-before");
              }
            },
            ondragleave: (e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove("drop-before", "drop-after");
            },
            ondrop: (e) => {
              if (!dirDrag) return;
              e.preventDefault();
              const from = dirDrag;
              const after = isAfter(e, e.currentTarget);
              dirDrag = null;
              clearDrop();
              if (from !== dir) moveProjectDir(from, dir, after);
              else if (sidebarStale) renderSidebar();
            },
          },
          h(
            "button",
            { class: "conv-item proj", title: `${dir}\n拖动可调整顺序，右键可置顶`, onclick: () => toggleSide("open", dir) },
            h("span", { class: "proj-icon", html: expanded ? ICON.folderOpen : ICON.folder }),
            h("span", { class: "title" }, baseName(dir)),
            expanded ? null : status(convs.map((c) => c.key)),
          ),
          h(
            "button",
            {
              class: "proj-new",
              title: `在 ${baseName(dir)} 中开新对话`,
              onclick: () => {
                S.draftCwd = dir === S.workspaceRoot ? null : dir;
                newDraft();
                closeSide();
              },
            },
            icon("edit"),
          ),
        ),
      );
      if (!expanded) continue;
      // 「展开显示」按主对话算条数，分叉跟着主对话一起出现
      const forest = forkForest(convs);
      for (const node of forest.slice(0, showAll ? forest.length : PROJECT_LIMIT)) {
        nodes.push(renderForkNode(node, (c, orphan) => convRow(c, " sub", agentLabel(c.agent), orphan), " in-proj"));
      }
      if (forest.length > PROJECT_LIMIT) nodes.push(h("div", { class: "sub-more" }, more("more", dir, showAll)));
    }
  }
  // 重绘会换掉 DOM：如果鼠标正停在某个标题上，重绘后接着滚
  const hovered = marquee.el ? marquee.el.textContent : null;
  stopMarquee();
  fill(ui.convList, ...nodes);
  if (hovered) {
    requestAnimationFrame(() => {
      const el = ui.convList.querySelector(".conv-item:hover .title");
      if (el?.textContent === hovered) startMarquee(el);
    });
  }
  const asks = askKeys.size;
  document.title = asks ? `(${asks}) 待处理 · Agent Loft` : "Agent Loft";
}
