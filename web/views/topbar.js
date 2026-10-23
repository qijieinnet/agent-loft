import { agentIcon, fill, h, icon, ICON, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { S, ui } from "../state.js";
import { agentLabel, convTitle, openSide } from "./sidebar.js";
import { closeMenu, confirmDialog, modal, placePopover, showMenu, showPopover } from "../lib/overlay.js";
import { newDraft, openConversation } from "./messages.js";
import { openSchedule } from "./schedule.js";
import { changeCwd, deleteConv, doAction, forkConversation, openModelPicker, renameConv, switchAgent } from "./conv-actions.js";

// ---------- 顶栏 ----------

export function renderTopbar() {
  const c = S.current ? S.convs.get(S.current) : null;
  // 定时任务页：只有标题，模式切换、「更多」都是对话用的
  const tasks = S.view === "tasks";
  fill(ui.topbar,
    h("button", { class: "icon-btn menu-btn", onclick: openSide, title: "会话列表" }, icon("menu")),
    h(
      "div",
      { class: "top-title" },
      tasks ? h("span", { class: "conv-name" }, "定时任务") : c ? h("span", { class: "conv-name", title: convTitle(c) }, convTitle(c)) : null,
    ),
    tasks ? null : ui.modeSlot,
    tasks ? null : h("button", { class: "icon-btn top-more", title: "更多", onclick: (e) => openTopMore(e.currentTarget) }, icon("more")),
  );
  renderContext();
}

/** 顶栏右上角「更多」 */
function openTopMore(anchor) {
  if (ui.menu?.anchor === anchor) return closeMenu();
  showMenu(anchor, [{ label: "定时发送…", onclick: () => openSchedule() }]);
  ui.menu.anchor = anchor;
  // 贴着按钮右边对齐，别超出屏幕
  const r = anchor.getBoundingClientRect();
  ui.menu.style.left = `${Math.max(8, r.right - ui.menu.offsetWidth)}px`;
}

export function baseName(p) {
  return (p ?? "").split(/[\\/]/).filter(Boolean).pop() || p || "";
}

function currentCwd() {
  const c = S.current ? S.convs.get(S.current) : null;
  return c ? c.cwd : (S.draftCwd ?? S.workspaceRoot ?? "");
}

/**
 * 新对话能选的 agent：启用了、并且服务端查过是装好登录了的（available 为 false 的不出现）。
 * 一个能用的都没有时退回到全部启用的，至少能看到报错，而不是什么都选不了。
 */
export function usableAgents() {
  const enabled = S.agents.filter((a) => a.enabled);
  const usable = enabled.filter((a) => a.available !== false);
  return usable.length ? usable : enabled;
}

function pickAgentMenu(anchor) {
  const allowed = usableAgents().map((a) => a.id);
  if (allowed.length < 2) return;
  if (ui.menu?.dataset.for === "agent") return closeMenu();
  const pop = showPopover(anchor, { align: "left" });
  pop.dataset.for = "agent";
  fill(
    pop,
    allowed.map((id) =>
      h(
        "button",
        { class: `pop-item${id === S.draftAgent ? " on" : ""}`, onclick: () => (closeMenu(), switchAgent(id)) },
        agentIcon(id),
        h("span", { class: "grow" }, agentLabel(id)),
        id === S.draftAgent ? h("span", { class: "check" }, "✓") : null,
      ),
    ),
  );
  placePopover(pop, anchor);
}

/** 新对话里选的模型 / 思考程度，按 agent 分开记，创建会话时带过去 */
S.draftPick = JSON.parse(localStorage.getItem("aim.draftPick") || "{}");
export function draftPick(agent = S.draftAgent) {
  return (S.draftPick[agent] ??= {});
}
export function saveDraftPick() {
  localStorage.setItem("aim.draftPick", JSON.stringify(S.draftPick));
}

/** 各 agent 的模型列表（新对话用 + 把模型 id 翻成显示名），按 agent 缓存 */
export const catalogCache = new Map();
/** 已经拿到的：agent → 模型列表 / 没显式选时实际用的 { model, effort } */
export const catalogLoaded = new Map();
export const catalogDefaults = new Map();
export function agentCatalog(agent) {
  if (!catalogCache.has(agent)) {
    const p = api(`/api/agents/${agent}/models`).then((d) => {
      catalogLoaded.set(agent, d.models ?? []);
      catalogDefaults.set(agent, d.defaults ?? {});
      return d.models ?? [];
    });
    p.catch(() => catalogCache.delete(agent));
    catalogCache.set(agent, p);
  }
  return catalogCache.get(agent);
}
/** 列表还没拿到就去拿，拿到后重画输入框的模型按钮 */
function ensureCatalog(agent) {
  if (!agent || catalogLoaded.has(agent) || catalogCache.has(agent)) return;
  void agentCatalog(agent).then(() => renderContext()).catch(() => {});
}

/** 设置里勾选的、输入框模型列表要显示的模型；没设置过（空）就全部显示 */
export function visibleModels(agent, models) {
  const allow = S.agents.find((a) => a.id === agent)?.models ?? [];
  if (!allow.length) return models;
  const shown = models.filter((m) => allow.includes(m.id));
  return shown.length ? shown : models;
}

// Claude 的 id 有几种写法：别名（opus）、完整名（claude-opus-5-5、带日期的、带 [1m] 的）
const bareModelId = (id) => String(id).replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
/** 「Default (recommended)」那一项实际是哪个模型：Claude 写在说明的开头（「Opus 5.5 · …」） */
export function defaultEntryName(m) {
  const head = m.description?.split(" · ")[0]?.trim();
  return head && head.length <= 24 && head !== m.description ? head : null;
}
/**
 * 模型 id → 给人看的名字（Opus 5.5、GPT-6.1-Sol），和选择列表里的写法一致。
 * id 为空 = 没显式选，按 agent 的默认模型算。都对不上时尽量从 id 拼出来，实在不行才显示 id。
 */
export function modelName(agent, id) {
  const models = catalogLoaded.get(agent) ?? [];
  if (!id) id = catalogDefaults.get(agent)?.model;
  if (!id || id === "default") {
    const def = models.find((m) => m.id === "default") ?? models.find((m) => m.isDefault);
    if (!def) return null;
    return def.id === "default" ? (defaultEntryName(def) ?? def.label) : def.label || def.id;
  }
  const exact = models.find((m) => m.id === id) ?? models.find((m) => bareModelId(m.id) === bareModelId(id));
  if (exact) return exact.id === "default" ? (defaultEntryName(exact) ?? exact.label) : exact.label || exact.id;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(bareModelId(id));
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return id;
}

/** 输入框上方的上下文条（目录 / agent）和输入框里的模型按钮 */
export function renderContext() {
  if (!ui.ctxBar) return;
  const c = S.current ? S.convs.get(S.current) : null;
  const cwd = currentCwd();
  const multi = usableAgents().length > 1;
  // 会话里不能换 agent（两个 agent 的会话互不相通），只显示；新对话里可以选
  const agentId = c ? c.agent : S.draftAgent;
  const agentEl = c || !multi
    ? h("span", { class: "ctx-item static" }, agentIcon(agentId), h("span", { class: "label" }, agentLabel(agentId ?? "") || "无可用 agent"))
    : h(
        "button",
        { class: "ctx-item", title: "选择 agent", onclick: (e) => pickAgentMenu(e.currentTarget) },
        agentIcon(agentId),
        h("span", { class: "label" }, agentLabel(agentId ?? "")),
        h("span", { class: "chev", html: ICON.down }),
      );
  fill(
    ui.ctxBar,
    h("button", { class: "ctx-item", title: `工作目录：${cwd}\n点击切换`, onclick: () => changeCwd() }, icon("folder"), h("span", { class: "label" }, baseName(cwd) || "选择目录")),
    agentEl,
  );
  updateCtxVisibility();

  // 直接显示实际的模型名和思考程度（和选择列表里一样的写法），不显示「默认模型」
  let model;
  let effort;
  const modelAgent = c ? c.agent : S.draftAgent;
  if (modelAgent) {
    ensureCatalog(modelAgent);
    const defaults = catalogDefaults.get(modelAgent) ?? {};
    const pick = c ? null : draftPick();
    const id = c ? (c.runtimeModel ?? c.model) : pick.model;
    model = modelName(modelAgent, id) ?? (catalogLoaded.has(modelAgent) ? "选择模型" : "…");
    effort = (c ? (c.runtimeEffort ?? c.effort) : pick.effort) ?? defaults.effort;
  }
  renderCtxRing();
  renderModePill(c);
  fill(
    ui.modelSlot,
    model
      ? h(
          "button",
          { class: "model-pill", title: "切换模型和思考程度", onclick: () => void openModelPicker() },
          h("span", { class: "model-name" }, model),
          effort ? h("span", { class: "sub" }, effort) : null,
          icon("down"),
        )
      : null,
  );
}

/** 输入框里的「聊天 / 工作」切换。会话里切换走服务端（同一条对话接着聊），新对话里只是记下选择 */
function renderModePill(c) {
  if (!ui.modeSlot) return;
  const mode = c ? (c.mode ?? "work") : S.draftMode;
  const chat = mode === "chat";
  fill(
    ui.modeSlot,
    h(
      "button",
      {
        class: `mode-pill${chat ? " chat" : ""}`,
        title: chat
          ? "聊天模式：精简的系统提示，只能联网搜索，不执行命令、不读写文件，每轮开销小很多。点击切到工作模式"
          : "工作模式：agent 原装的全部能力。点击切到聊天模式（更省、更快，适合日常聊天和查资料）",
        onclick: () => void toggleMode(),
      },
      chat ? "💬 聊天" : "🛠 工作",
    ),
  );
}

async function toggleMode() {
  const c = S.current ? S.convs.get(S.current) : null;
  const next = (c ? (c.mode ?? "work") : S.draftMode) === "chat" ? "work" : "chat";
  if (!c) {
    S.draftMode = next;
    localStorage.setItem("aim.mode", next);
    renderContext();
    return;
  }
  // 聊过的聊天对话切到工作模式：工作模式会在对话里留下一大段 Claude Code / Codex 的背景，
  // 之后再切回聊天模式每轮还得带着它，就省不了了。先问一句，建议另开一条工作对话
  if (next === "work" && S.items.length > 0) {
    const choice = await confirmDialog({
      title: "在这条对话里切到工作模式？",
      message:
        "切过去以后，这条对话里会留下工作模式的一大段背景（约 1.7 万 token），之后再切回聊天模式每轮也得带着，就省不了了。切换后的第一轮也会稍贵一些。\n\n要干活的话，建议新开一条工作对话（目录和 agent 跟这条一样），这条留着继续聊天。",
      confirmText: "新开工作对话",
      altText: "就在这里切",
    });
    if (choice === "alt") await doAction("mode", "work");
    else if (choice === true) {
      S.draftAgent = c.agent;
      S.draftCwd = c.cwd;
      S.draftMode = "work";
      localStorage.setItem("aim.mode", "work");
      newDraft();
      toast("已新开工作对话，目录和 agent 跟原来那条一样");
    }
    return;
  }
  await doAction("mode", next);
}

/** 84321 → 84k，1234567 → 1.2M */
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** 输入框里的上下文窗口小圆环，hover 显示详情 */
function renderCtxRing() {
  if (!ui.ctxRing) return;
  const c = S.current ? S.convs.get(S.current) : null;
  const ctx = c?.context;
  if (!ctx) return fill(ui.ctxRing);
  const pct = Math.max(0, Math.min(100, ctx.percent));
  const level = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "";
  const r = 7;
  const len = 2 * Math.PI * r;
  fill(
    ui.ctxRing,
    h(
      "span",
      { class: `ctx-ring ${level}`, tabindex: "0", "aria-label": `上下文已用 ${Math.round(ctx.percent)}%` },
      h("span", {
        class: "ring",
        html: `<svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="${r}" class="track"/><circle cx="9" cy="9" r="${r}" class="bar" stroke-dasharray="${((pct / 100) * len).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>`,
      }),
      h(
        "span",
        { class: "tip" },
        h("span", { class: "tip-title" }, "上下文窗口："),
        h("span", {}, `${Math.round(ctx.percent)}% 已用（剩余 ${Math.max(0, 100 - Math.round(ctx.percent))}%）`),
        h("span", {}, `已用 ${fmtTokens(ctx.used)} tokens，共 ${fmtTokens(ctx.window)}`),
      ),
    ),
  );
}

/** 发出第一条消息、或会话里已经有内容后，就不再显示上下文条 */
export const sentKeys = new Set();
export function updateCtxVisibility() {
  if (ui.ctxBar) ui.ctxBar.hidden = !!S.current && (S.items.length > 0 || sentKeys.has(S.current));
}

/** 侧栏会话的右键菜单：分叉 / 重命名 / 删除 */
export function openConvContextMenu(key, at) {
  const c = S.convs.get(key);
  if (!c) return;
  showMenu(at, [
    {
      label: "分叉",
      onclick: async () => {
        if (c.canFork) return forkConversation(undefined, key);
        // 不支持另开一条的：只能在原对话里分叉，先切过去
        if (key !== S.current) await openConversation(key);
        await doAction("fork");
      },
    },
    { label: "重命名", onclick: () => renameConv(key) },
    ...(c.channel === "web" && S.bots.length > 0 ? [{ label: "在飞书继续…", onclick: () => continueInFeishu(key) }] : []),
    ...(c.channel === "web" ? [{ label: "删除", danger: true, onclick: () => deleteConv(key) }] : []),
  ]);
}

/**
 * 在飞书继续：选一个机器人聊过的飞书聊天，把它接到这条 Web 会话上。
 * 之后在那个聊天里说话就进这条会话，回复、授权、提问也发过去；飞书里发 /detach 退回来。
 * 只有一个聊天可选时直接接上，不弹窗。
 */
async function continueInFeishu(key) {
  let data;
  try {
    data = await api("/api/feishu/targets");
  } catch (err) {
    return toast(err.message);
  }
  const targets = data.bots.flatMap((b) => b.chats.map((c) => ({ bot: b, chat: c })));
  if (data.bots.length === 0) return toast("没有运行中的飞书机器人");
  if (targets.length === 0) return toast("机器人还没有聊天：先在飞书里给它发一条消息，再回来推过去");
  const go = async (t, close) => {
    try {
      const r = await api(`/api/conversations/${encodeURIComponent(key)}/feishu`, {
        method: "POST",
        body: { botId: t.bot.id, chatId: t.chat.chatId },
      });
      close?.();
      toast(r.text);
    } catch (err) {
      toast(err.message);
    }
  };
  if (targets.length === 1) return go(targets[0]);
  const multiBot = data.bots.filter((b) => b.chats.length > 0).length > 1;
  const body = h("div", { class: "modal-body" });
  const close = modal({ title: "在飞书继续", body });
  fill(
    body,
    h("div", { class: "muted" }, "选一个飞书聊天，之后在那里说话就会发进这条会话，回复和授权也会发过去。在飞书里发 /detach 回到那个聊天自己的会话。"),
    ...targets.map((t) => {
      const here = t.chat.attached === key;
      const other = t.chat.attached && !here ? S.convs.get(t.chat.attached) : null;
      const note = here ? "已接着这条" : other ? `正接着「${convTitle(other)}」，选它会换过来` : "";
      return h(
        "button",
        { class: `list-item${here ? " on" : ""}`, onclick: () => go(t, close) },
        h("span", { class: "brand-icon", html: ICON.feishu }),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "t" }, multiBot ? `${t.bot.name} · ${t.chat.label}` : t.chat.label),
          h("div", { class: "s" }, [`${relTime(t.chat.activeAt)}活跃`, t.bot.state !== "connected" ? "机器人未连上" : "", note].filter(Boolean).join(" · ")),
        ),
      );
    }),
  );
}

/** 飞书机器人的历史会话：这个机器人的所有聊天，按活跃时间排，点一下打开 */
export function openBotConversations(botId) {
  const bot = S.bots.find((b) => b.id === botId);
  const convs = [...S.convs.values()]
    .filter((c) => c.channel === "feishu" && c.channelId === botId && !c.hidden)
    .sort((a, b) => b.activeAt - a.activeAt);
  const body = h("div", { class: "modal-body" });
  const close = modal({ title: `历史会话${bot ? ` · ${bot.name}` : ""}`, body });
  fill(
    body,
    ...(convs.length === 0
      ? [h("div", { class: "muted" }, "还没有会话")]
      : convs.map((c) =>
          h(
            "button",
            {
              class: `list-item${c.key === S.current ? " on" : ""}`,
              onclick: () => {
                close();
                if (c.key !== S.current) void openConversation(c.key);
              },
            },
            h(
              "div",
              { class: "grow" },
              h("div", { class: "t" }, convTitle(c)),
              h("div", { class: "s" }, `${relTime(c.activeAt)} · ${agentLabel(c.agent)} · ${c.cwd}`),
            ),
            c.key === S.current ? "当前" : c.busy ? h("span", { class: "conv-spin", title: "进行中" }) : null,
          ),
        )),
  );
}
