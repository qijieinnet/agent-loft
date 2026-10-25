import { fill, h } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S, ui } from "../state.js";
import { agentLabel } from "./sidebar.js";
import { usableAgents } from "./topbar.js";
import { autosize, hideKeyboardForMenu, sendMessage, updateSendBtn } from "./composer.js";

// ---------- 斜杠命令补全 ----------
//
// 输入框里只有「/xxx」（还没打空格）时弹出命令表，顺序就是设置 → 命令里排好的。
// 列表按 agent + 会话目录缓存一分钟：Claude 的原生命令要起一次进程才问得到。

export const slash = { open: false, shown: false, items: [], index: 0, cache: new Map(), token: 0 };

export function commandUsage(c) {
  return `/${c.name}${c.args ? ` ${c.args}` : ""}`;
}

export function oneLine(text, max = 80) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function currentAgentId() {
  const c = S.current ? S.convs.get(S.current) : null;
  return c?.agent ?? S.draftAgent ?? usableAgents()[0]?.id ?? "claude";
}

async function loadCommands(agent) {
  const cacheKey = `${agent}|${S.current ?? ""}`;
  const hit = slash.cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const q = S.current ? `?key=${encodeURIComponent(S.current)}` : "";
  const data = await api(`/api/agents/${agent}/commands${q}`);
  const list = data.commands.filter((c) => !c.hidden);
  slash.cache.set(cacheKey, { at: Date.now(), list });
  return list;
}

function slashQuery() {
  const v = ui.input.value;
  const m = /^[/／]([^\s]*)$/.exec(v);
  return m ? m[1].toLowerCase() : null;
}

/** 名字前缀匹配排最前，其次名字里包含，最后是说明里包含；同档内保持用户排的顺序 */
function matchCommands(list, q) {
  if (!q) return list;
  const tiers = [[], [], []];
  for (const c of list) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) tiers[0].push(c);
    else if (name.includes(q)) tiers[1].push(c);
    else if (c.description.toLowerCase().includes(q)) tiers[2].push(c);
  }
  return tiers.flat();
}

export async function updateSlashMenu() {
  const q = slashQuery();
  if (q === null) return closeSlashMenu();
  const token = ++slash.token;
  if (!slash.open) renderSlashMenu(null);
  let list;
  try {
    list = await loadCommands(currentAgentId());
  } catch (err) {
    if (token === slash.token) renderSlashMenu(null, err.message);
    return;
  }
  // 等待期间又打了字：以最新的那次为准
  if (token !== slash.token || slashQuery() === null) return;
  const items = matchCommands(list, slashQuery());
  if (items.length === 0) return closeSlashMenu();
  slash.items = items;
  slash.index = Math.min(slash.index, items.length - 1);
  renderSlashMenu(items);
  if (!slash.shown) {
    slash.shown = true;
    hideKeyboardForMenu();
  }
}

function renderSlashMenu(items, error) {
  slash.open = true;
  ui.slashMenu.hidden = false;
  if (!items) {
    fill(ui.slashMenu, h("div", { class: "slash-empty" }, error ? `读取命令失败：${error}` : h("span", { class: "spinner" })));
    return;
  }
  fill(
    ui.slashMenu,
    ...items.map((c, i) =>
      h(
        "button",
        {
          class: `slash-item${i === slash.index ? " on" : ""}`,
          type: "button",
          // mousedown 而不是 click：不然输入框先失焦，手机上键盘会闪一下
          onmousedown: (e) => {
            e.preventDefault();
            void pickSlash(c, false);
          },
          onmousemove: () => {
            if (slash.index !== i) {
              slash.index = i;
              highlightSlash();
            }
          },
        },
        h(
          "div",
          { class: "slash-head" },
          h("span", { class: "slash-name" }, `/${c.name}`),
          c.args ? h("span", { class: "slash-args" }, c.args) : null,
          c.source === "agent" ? h("span", { class: "badge" }, agentLabel(currentAgentId())) : null,
          c.source === "custom" ? h("span", { class: "badge" }, "自定义") : null,
        ),
        h("div", { class: "slash-desc" }, oneLine(c.description, 120) || "（无说明）"),
      ),
    ),
  );
  highlightSlash();
}

function highlightSlash() {
  ui.slashMenu.querySelectorAll(".slash-item").forEach((el, i) => el.classList.toggle("on", i === slash.index));
  ui.slashMenu.querySelector(".slash-item.on")?.scrollIntoView({ block: "nearest" });
}

export function closeSlashMenu() {
  slash.open = false;
  slash.shown = false;
  slash.items = [];
  slash.index = 0;
  slash.token++;
  if (ui.slashMenu) ui.slashMenu.hidden = true;
}

/**
 * 选中一条命令。fillOnly（Tab）只补全；回车 / 点击时，不需要参数的直接发出去，
 * 需要参数的补全成「/name 」等用户接着打。
 */
async function pickSlash(c, fillOnly) {
  const needsArgs = !c.runnable;
  if (fillOnly || needsArgs) {
    ui.input.value = `/${c.name}${c.args ? " " : ""}`;
    closeSlashMenu();
    autosize();
    updateSendBtn();
    ui.input.focus();
    return;
  }
  ui.input.value = `/${c.name}`;
  closeSlashMenu();
  await sendMessage();
}

/** 菜单开着时接管方向键 / Tab / 回车 / Esc；返回 true 表示已处理 */
export function slashKeydown(e) {
  if (!slash.open || slash.items.length === 0) {
    if (slash.open && e.key === "Escape") {
      closeSlashMenu();
      return true;
    }
    return false;
  }
  if (e.isComposing) return false;
  switch (e.key) {
    case "ArrowDown":
      slash.index = (slash.index + 1) % slash.items.length;
      highlightSlash();
      return true;
    case "ArrowUp":
      slash.index = (slash.index - 1 + slash.items.length) % slash.items.length;
      highlightSlash();
      return true;
    case "Tab":
      void pickSlash(slash.items[slash.index], true);
      return true;
    case "Enter":
      if (e.shiftKey) return false;
      void pickSlash(slash.items[slash.index], false);
      return true;
    case "Escape":
      closeSlashMenu();
      return true;
  }
  return false;
}
