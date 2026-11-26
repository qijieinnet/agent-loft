import {
  api,
  byId,
  button,
  clearBotNotifications,
  deviceSubscribed,
  disableDevice,
  enableDevice,
  field,
  h,
  icon,
  encoded, photoPayload,
  requestId,
} from "./client.js";
import { releaseLocalPushDevices } from "../lib/push-session.js";
import { fileLinks, voiceInput, stopVoiceInput } from "./attachments.js";
import { startBotCall, stopBotCall } from "./voice-call.js";
import { bindComposerActions } from "./composer-actions.js";
import { newRoutine, openRoutines, routineDraft } from "./routines.js";
import { searchHistory } from "./history-search.js";
import { newReminder } from "./reminder-form.js";
import { action, chooseName, closePanel, divider, note, panel, panelError, run, settingsPanel } from "./panel.js";
import { replyText } from "./format.js";
import { confirmBotChange, manageBot, openArchives } from "./lifecycle.js";
import { openExtensions } from "./extensions.js";
import { memoryEditor, openMemories, openProfile } from "./profile.js";
import { delegationCard, delegationPath, openDelegations, showDelegation } from "./delegations.js";

const gate = byId("gate"),
  chat = byId("chat"),
  scroll = byId("scroll"),
  list = byId("messages");
const input = byId("message"),
  fileInput = byId("photo"),
  send = byId("send");
const state = { user: null, bots: [], bot: null, thread: null, reminders: [], subscribed: false, pending: false };
const compact = matchMedia("(max-width:759px)");
const listVisible = () => compact.matches && chat.dataset.pane === "list";
let delegations = [], delegationVersion = 0, delegationDirty = true;
const can = (name) => !state.bot?.capabilities || state.bot.capabilities.includes(name);
function avatar(bot) {
  if (bot.isDefault) return h("span", { class: "bot-avatar default-avatar", "aria-hidden": "true" }, icon("chat"));
  const tone = [...bot.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 4;
  return h("span", { class: "bot-avatar tone-" + tone, "aria-hidden": "true" }, Array.from(bot.name.trim())[0] || "B");
}
let view = 0,
  sequence = 0,
  timer,
  rendered = "",
  nextBefore = null,
  earliestLoaded = null;
function newDraft() {
  return { text: "", attachments: [], requestId: null, sending: false, photoVersion: 0, readingPhoto: false };
}
// Drafts belong to this authenticated tab. Switching scope keeps them separate and logging out clears them.
const drafts = new Map();
let draft = newDraft();
let readThrough = 0,
  markingRead = false,
  scrollReadTimer;
let invite =
  new URLSearchParams(location.hash.slice(1)).get("invite") || new URLSearchParams(location.search).get("invite");
const threadPath = (id) => "/api/bots/threads/" + encodeURIComponent(id) + "/messages";
const botPath = (id) => "/api/bots/" + encodeURIComponent(id);
const mark = () => h("img", { class: "mark", src: "/icons/mark.svg", alt: "" });
function status(text = "") {
  const node = byId("status");
  node.classList.remove("success");
  node.textContent = text;
  node.hidden = !text;
}
function success(text) {
  status(text);
  byId("status").classList.add("success");
}
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Persistent selection is optional. */
  }
}
function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lastKey() {
  return "loft.bot.thread." + state.user.id;
}
function queryThread() {
  return new URLSearchParams(location.search).get("thread");
}
function cleanURL(thread, message, delegationId) {
  const url = new URL("/", location.origin);
  if (thread) url.searchParams.set("thread", thread);
  if (message) url.searchParams.set("message", message);
  if (delegationId) url.searchParams.set("delegation", delegationId);
  history.replaceState(thread ? history.state : null, "", url);
}
function setGate(...children) {
  closeComposerActions();
  stopBotCall();
  stopVoiceInput();
  clearTimeout(timer);
  view++;
  state.bot = null;
  state.thread = null;
  state.user = null;
  state.bots = [];
  delegations = [];
  delegationVersion++;
  delegationDirty = true;
  byId("rail-list").replaceChildren();
  byId("rail-search").value = "";
  byId("delegation-cards").replaceChildren();
  state.reminders = [];
  state.subscribed = false;
  state.pending = false;
  drafts.clear();
  draft = newDraft();
  document.title = "Loft Bot";
  closePanel();
  byId("panel-body").replaceChildren();
  byId("panel-error").textContent = "";
  byId("bot-name").textContent = "";
  byId("purpose").textContent = "";
  byId("account-name-label").textContent = "";
  byId("announce").textContent = "";
  chat.hidden = true;
  gate.hidden = false;
  gate.replaceChildren(h("div", { class: "auth-card" }, mark(), ...children));
  input.value = "";
  clearPhoto();
  list.replaceChildren();
  status();
}
const invitationScope = "加入后可以查看 Bot 的职责和说话风格，也能查看当前共享对话里的消息、照片、共享记忆及跟进记录。你与它的私聊仅你可见。";
function login(me, signup = !!invite && !me.needsSetup) {
  const setup = me.needsSetup,
    showName = setup || signup || me.multiUser;
  const name = h("input", {
    id: "account-name",
    autocomplete: "username",
    autocapitalize: "off",
    spellcheck: "false",
    required: showName,
  });
  const pw = h("input", {
    id: "account-password",
    type: "password",
    autocomplete: setup || signup ? "new-password" : "current-password",
    required: true,
    minlength: setup || signup ? 8 : 1,
  });
  const token = h("input", { id: "setup-code", autocomplete: "off", required: setup });
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h(
    "button",
    { type: "submit", class: "primary" },
    setup ? "创建管理员账号" : signup ? "创建账号并加入" : "登录",
  );
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        error.hidden = true;
        try {
          if (setup)
            await api("/api/setup", "POST", { token: token.value.trim(), name: name.value.trim(), password: pw.value });
          else if (signup) {
            const { bot } = await api("/api/bot-join", "POST", {
              token: invite,
              name: name.value.trim(),
              password: pw.value,
            });
            invite = null;
            cleanURL(bot.sharedThreadId);
          } else
            await api("/api/login", "POST", { ...(showName ? { name: name.value.trim() } : {}), password: pw.value });
          await boot();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    setup ? field("启动日志中的设置码", token) : null,
    showName ? field("用户名", name) : null,
    field(setup || signup ? "密码（至少 8 位）" : "密码", pw),
    error,
    submit,
  );
  setGate(
    h("h1", {}, setup ? "设置 Loft Bot" : invite ? "加入共用 Bot" : "登录 Loft Bot"),
    invite && !setup ? note(invitationScope) : null,
    form,
    invite && !setup
      ? button(signup ? "已有账号，去登录" : "创建账号加入", () => login(me, !signup), "secondary")
      : null,
  );
}
async function boot() {
  try {
    const me = await api("/api/me");
    if (!me.authed) {
      login(me);
      return;
    }
    if (state.user && state.user.id !== me.user.id) setGate();
    state.user = me.user;
    if (invite) {
      const captured = invite;
      const joinButton = h("button", { class: "primary", type: "button" }, "接受邀请");
      const message = h("p", { class: "form-error", role: "alert", hidden: true });
      joinButton.onclick = async () => {
        joinButton.disabled = true;
        try {
          const { bot } = await api("/api/bots/join", "POST", { token: captured });
          invite = null;
          cleanURL(bot.sharedThreadId);
          await boot();
        } catch (err) {
          message.textContent = err.message;
          message.hidden = false;
        } finally {
          joinButton.disabled = false;
        }
      };
      setGate(
        h("h1", {}, "加入共用 Bot"),
        note(invitationScope),
        message,
        joinButton,
        button(
          "回到我的 Bot",
          () => {
            invite = null;
            cleanURL();
            boot();
          },
          "secondary",
        ),
      );
      return;
    }
    await refreshBots();
    const desired = queryThread() || stored(lastKey());
    const bot = state.bots.find((b) => desired && (desired === b.privateThreadId || desired === b.sharedThreadId));
    const fallback = state.bots.find((b) => b.isDefault) || state.bots[0];
    if (!fallback) throw new Error("暂时无法打开 Bot，请刷新重试。");
    gate.hidden = true;
    chat.hidden = false;
    const startInList = compact.matches && !queryThread();
    const params = new URLSearchParams(location.search);
    const opening = openThread(
      bot || fallback,
      bot ? desired : fallback.privateThreadId,
      bot ? { message: params.get("message"), delegationId: params.get("delegation"), moveFocus: false } : undefined,
    );
    if (startInList) showConversationList();
    await opening;
    if (desired && !bot) status("这段对话已不可访问，已回到你的私人 Bot。");
    refreshDevice();
  } catch (err) {
    if (err.status === 401) {
      login(await api("/api/me").catch(() => ({})));
      return;
    }
    setGate(h("h1", {}, "暂时无法打开对话"), note(err.message), button("重新连接", boot, "primary"));
  }
}
async function refreshBots() {
  const { bots, userId } = await api("/api/bots");
  if (!state.user || (userId && userId !== state.user.id))
    throw Object.assign(new Error("账号已切换"), { status: 401 });
  const visible = new Set(bots.flatMap(bot => [bot.privateThreadId, bot.sharedThreadId]));
  for (const key of drafts.keys()) if (!visible.has(key)) drafts.delete(key);
  state.bots = bots;
  renderRail();
}
function resizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 142) + "px";
  send.disabled = draft.sending || state.pending || draft.readingPhoto || (!input.value.trim() && !draft.attachments.length);
}
function paintPhoto() {
  const preview = byId("preview");
  preview.replaceChildren();
  preview.hidden = !draft.attachments.length;
  for (const [i, item] of draft.attachments.entries()) {
    const remove = button(icon("x"), () => { if (draft.sending) return; draft.attachments.splice(i, 1); draft.requestId = null; paintPhoto(); }, "icon-button");
    remove.setAttribute("aria-label", item.photo ? "移除照片" : "移除" + item.name);
    remove.disabled = draft.sending;
    preview.append(h("span", { class: "draft-attachment" }, item.photo
      ? h("img", { alt: "待发送的照片", src: "data:" + item.mimeType + ";base64," + item.data })
      : h("span", {}, item.name), remove));
  }
  resizeInput();
}
function clearPhoto() {
  draft.photoVersion++;
  draft.attachments = [];
  draft.readingPhoto = false;
  fileInput.value = "";
  paintPhoto();
}
async function openThread(bot, thread, { message, delegationId, moveFocus = true } = {}) {
  closeComposerActions();
  stopBotCall();
  stopVoiceInput();
  if (!bot || !thread) return;
  chat.dataset.pane = "thread";
  if (state.thread) {
    draft.text = input.value;
    if (!draft.text && !draft.attachments.length && !draft.readingPhoto && !draft.sending) drafts.delete(state.thread);
  }
  draft = drafts.get(thread) || newDraft();
  drafts.set(thread, draft);
  closePanel();
  clearTimeout(timer);
  view++;
  sequence++;
  state.bot = bot;
  byId("choose-call").hidden = true;
  state.thread = thread;
  state.pending = false;
  state.reminders = [];
  delegations = [];
  delegationVersion++;
  delegationDirty = true;
  byId("delegation-cards").replaceChildren();
  byId("delegation-cards").hidden = true;
  delete byId("delegation-cards").dataset.signature;
  rendered = "";
  nextBefore = null;
  earliestLoaded = null;
  readThrough = 0;
  markingRead = false;
  input.value = draft.text;
  fileInput.value = "";
  paintPhoto();
  status();
  list.replaceChildren();
  byId("older").hidden = true;
  showWelcome(false);
  byId("reminders").hidden = true;
  store(lastKey(), thread);
  cleanURL(thread, message, delegationId);
  const shared = bot.sharedThreadId === thread;
  byId("bot-name").textContent = bot.name;
  byId("active-avatar").replaceChildren(avatar(bot));
  byId("welcome-avatar").replaceChildren(bot.isDefault ? mark() : avatar(bot));
  input.placeholder = shared ? "在共享对话中发消息…" : "给" + bot.name + "发消息…";
  byId("audience").textContent = conversationScope(bot, thread);
  byId("greeting").textContent = shared ? "一起聊点什么？" : "有什么想交给我？";
  const purpose = byId("purpose");
  purpose.hidden = true;
  purpose.textContent = "";
  updateStarters();
  renderRail();
  api(botPath(bot.id) + "/profile").then(({ profile }) => {
    if (state.thread === thread) applyProfile(profile);
  }).catch(() => {});
  document.title = bot.name + " · Loft Bot";
  await refreshThread(true);
  if (state.thread !== thread) return;
  if (delegationId) {
    await openDelegationNotice(thread, delegationId);
  } else if (message) await focusMessage(thread, message, moveFocus);
}
function applyProfile(profile) {
  const bot = state.bot;
  if (!bot) return;
  byId("choose-call").hidden = profile.engine !== "codex";
  if (profile.engine !== "codex") stopBotCall();
  bot.capabilities = profile.capabilities;
  if (freshBot()) freshBot().capabilities = profile.capabilities;
  const purpose = byId("purpose");
  purpose.textContent = profile.responsibility;
  purpose.hidden = !profile.responsibility;
  updateStarters();
}
function showWelcome(visible) {
  chat.classList.toggle("welcome", visible);
  byId("empty").hidden = !visible;
  byId("starters").hidden = !visible;
}
function updateStarters() {
  byId("start-reminder").hidden = !can("reminders");
  byId("choose-routine").hidden = !can("reminders");
  byId("choose-reminder").hidden = !can("reminders");
  byId("start-follow").hidden = !can("followups");
}
function showMessage(message, bot, thread) {
  const mine = message.role === "user" && message.authorId === state.user.id;
  const collaborative = message.role === "assistant" && message.requestId == null && message.text?.startsWith("协作结果\n\n");
  const who = message.role === "assistant" ? (message.delegatedBy || (collaborative ? "Bot 协作" : bot.name)) : mine ? "我" : message.authorName || "成员";
  const line = h("li", {
    class: "line " + message.role + (mine ? " mine" : "") + (message.status === "failed" ? " failed" : ""),
    "data-id": message.id,
  });
  const bubble = h("div", { class: "bubble" });
  for (let i = 0; i < (message.imageCount ?? (message.image ? 1 : 0)); i++) {
    const path = threadPath(thread) + "/" + encodeURIComponent(message.id) + "/image" + (i ? "?index=" + i : "");
    bubble.append(
      h(
        "a",
        { href: path, target: "_blank", rel: "noopener noreferrer", "aria-label": "查看照片" },
        h("img", { src: path, alt: "对话中的照片", loading: "lazy" }),
      ),
    );
  }
  bubble.append(...fileLinks(message.files, threadPath(thread) + "/" + message.id));
  const callStates = { pending: "等待确认", approved: "已同意", denied: "已拒绝", cancelled: "已取消", expired: "已过期",
    ready: "准备调用", running: "执行中", done: "已完成", failed: "执行失败", unknown: "结果未确认" };
  for (const call of message.calls || []) {
    const card = h("div", { class: "tool-call" }, h("strong", {}, call.service + " · " + call.name), h("span", {}, callStates[call.status] || call.status));
    if (call.image) {
      const src = "/api/bots/threads/" + thread + "/calls/" + call.id + "/image";
      card.append(h("a", { href: src, target: "_blank", rel: "noopener noreferrer" },
        h("img", { src, alt: "Codex 生成的图片", loading: "lazy", width: 160 })));
    }
    if (call.detail) card.append(h("details", {}, h("summary", {}, "调用结果"), h("pre", {}, call.detail)));
    if (call.args != null) {
      const buttons = h("div", { class: "record-controls" });
      for (const [decision, label] of [["approve", "允许这一次"], ["deny", "拒绝"]]) buttons.append(button(label, async () => {
        for (const b of buttons.children) b.disabled = true;
        try { await api("/api/bots/threads/" + thread + "/calls/" + call.id + "/" + decision, "POST", {}); }
        catch (err) { if (state.thread === thread) status(err.message); }
        finally {
          if (state.thread === thread) await refreshThread(true);
          for (const b of buttons.children) b.disabled = false;
        }
      }, "chip"));
      card.append(h("pre", {}, call.args), buttons);
    }
    line.append(card);
  }
  if (mine && message.canRetry) {
    const retry = button("重新发送", async () => {
      retry.disabled = true;
      try {
        await api(threadPath(thread) + "/" + message.id + "/retry", "POST", { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        if (state.thread === thread) await refreshThread(true);
      } catch (err) {
        if (state.thread === thread) status(err.message);
      } finally { retry.disabled = false; }
    }, "secondary");
    line.append(retry);
  }
  if (message.text) bubble.append(message.role === "assistant" ? replyText(message.text) : h("div", { class: "message-text" }, message.text));
  if (message.sources?.length) {
    const refs = h("ul", { class: "reply-sources", "aria-label": "引用的原消息" });
    for (const source of message.sources) {
      const href = "/?" + new URLSearchParams({ thread, message: String(source.id) });
      const link = h("a", { href }, "查看原消息 · " + source.excerpt);
      link.onclick = event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || state.thread !== thread) return;
        event.preventDefault();
        closePanel();
        focusMessage(thread, source.id);
      };
      refs.append(h("li", {}, link));
    }
    bubble.append(refs);
  }
  if (message.role === "assistant" && message.requestId == null && message.text?.startsWith("跟进「")) {
    bubble.append(button("查看跟进", () => followups(thread, bot).catch((err) => status(err.message)), "secondary"));
  }
  const time = message.createdAt && new Date(message.createdAt);
  let portrait;
  if (message.role === "assistant") {
    if (!collaborative) portrait = avatar(bot);
    else {
      const targets = state.bots.filter((target) => target.name === message.delegatedBy);
      portrait = targets.length === 1 ? avatar(targets[0]) : h("span", { class: "bot-avatar collab-icon", "aria-hidden": "true" }, icon("handoff"));
    }
  }
  const meta = h("span", { class: "who" }, portrait, who);
  if (time) meta.append(h("time", { datetime: time.toISOString() },
    time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })));
  line.prepend(meta, bubble);
  return line;
}
function schedulePoll() {
  clearTimeout(timer);
  if (state.thread && !document.hidden)
    timer = setTimeout(
      () => refreshThread(),
      state.pending || delegations.some((item) => ["queued", "running"].includes(item.status)) ? 1350 : state.bot.sharedThreadId === state.thread ? 3500 : 12000,
    );
}
function nearBottom() {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
}
async function focusMessage(thread, message, moveFocus = true) {
  if (!/^\d+$/.test(String(message)) || !Number.isSafeInteger(Number(message))) return;
  const line = list.querySelector('[data-id="' + message + '"]');
  if (line) {
    if (moveFocus) {
      line.tabIndex = -1;
      line.focus({ preventScroll: true });
    }
    line.scrollIntoView({ block: "center" });
  } else {
    try {
      const data = await api(threadPath(thread) + "?before=" + (Number(message) + 1));
      if (state.thread !== thread) return;
      const match = data.messages.find((row) => row.id === Number(message));
      if (match)
        panel(
          "对话中的消息",
          h("ol", { class: "notification-message" }, showMessage(match, state.bot, thread)),
          button("回到对话", closePanel, "primary"),
        );
      else status("这条消息已不可用。");
    } catch (err) {
      if (state.thread === thread) status(err.message);
    }
  }
  if (state.thread === thread) cleanURL(thread);
}
async function markVisibleRead() {
  if (document.hidden || chat.hidden || listVisible() || markingRead || !state.thread || byId("panel").open) return;
  const thread = state.thread;
  const viewport = scroll.getBoundingClientRect();
  const lines = [...list.querySelectorAll("[data-id]")].reverse();
  const lastVisible = lines.find((line) => {
    const rect = line.getBoundingClientRect();
    return rect.height > 0 && rect.top < viewport.bottom && rect.bottom > viewport.top;
  });
  const through = Number(lastVisible?.dataset.id || 0);
  if (through <= readThrough) return;
  markingRead = true;
  try {
    await api("/api/bot-inbox/read", "POST", { threadId: thread, through });
    clearBotNotifications({ threadId: thread, through });
    if (state.thread === thread) readThrough = through;
  } catch {
    /* The next visible update retries a missed read receipt. */
  } finally {
    if (state.thread === thread) markingRead = false;
  }
}
function scheduleRead() {
  clearTimeout(scrollReadTimer);
  scrollReadTimer = setTimeout(markVisibleRead, 250);
}
scroll.addEventListener("scroll", scheduleRead, { passive: true });
async function refreshThread(force = false) {
  if (!state.thread) return;
  const thread = state.thread,
    bot = state.bot,
    current = ++sequence;
  try {
    const data = await api(threadPath(thread));
    if (current !== sequence || thread !== state.thread) return;
    const messages = data.messages || [],
      signature = JSON.stringify([messages.map((m) => [m.id, m.status, m.text, m.delegatedBy, m.calls]), data.pending]);
    state.pending = !!data.pending;
    resizeInput();
    if (force || delegationDirty || rendered !== signature || delegations.some((item) => ["queued", "running"].includes(item.status)))
      refreshDelegations(thread);
    if (signature !== rendered) {
      const latest = messages.at(-1), currentBot = freshBot();
      if (latest && currentBot) {
        currentBot.previews ??= {};
        currentBot.previews[thread] = { text: latest.text.slice(0,120) || (latest.images?.length || latest.image ? "照片" : latest.files?.[0]?.name || ""), createdAt: latest.createdAt };
        renderRail();
      }
      const pinned = force || !rendered || nearBottom();
      const first = messages[0]?.id;
      if (first != null && earliestLoaded != null) {
        for (const item of [...list.children])
          if (item.dataset.id >= Number(first) || item.classList.contains("pending")) item.remove();
      } else list.replaceChildren();
      list.append(...messages.map((m) => showMessage(m, bot, thread)));
      if (state.pending)
        list.append(h("li", { class: "line pending" }, h("span", { class: "who" }, bot.name + " 正在回复…")));
      showWelcome(messages.length === 0 && byId("delegation-cards").hidden);
      if (earliestLoaded == null) nextBefore = data.nextBefore ?? null;
      byId("older").hidden = nextBefore === null;
      if (rendered && !state.pending && messages.at(-1)?.role === "assistant")
        byId("announce").textContent = bot.name + " 已回复。";
      rendered = signature;
      if (pinned) scroll.scrollTop = scroll.scrollHeight;
    }
    state.reminders = data.reminders || [];
    renderReminderStrip();
    scheduleRead();
    if (byId("status").dataset.network) {
      status();
      delete byId("status").dataset.network;
    }
  } catch (err) {
    if (current !== sequence || thread !== state.thread) return;
    if (err.status === 401) {
      setGate();
      await boot();
      return;
    }
    if ([403, 404].includes(err.status)) {
      try {
        await refreshBots();
        const fallback = state.bots.find((b) => b.isDefault);
        if (current === sequence && fallback && fallback.privateThreadId !== thread) {
          await openThread(fallback, fallback.privateThreadId);
          status("这段对话已不可访问，已回到你的私人 Bot。");
        } else if (current === sequence) {
          setGate(
            h("h1", {}, "无法打开这段对话"),
            note(err.message),
            button(
              "返回我的 Bot",
              () => {
                cleanURL();
                boot();
              },
              "primary",
            ),
          );
        }
      } catch {
        if (current === sequence) {
          setGate();
          await boot();
        }
      }
      return;
    }
    status(err.message);
    byId("status").dataset.network = "1";
  } finally {
    if (current === sequence) schedulePoll();
  }
}
byId("older").onclick = async () => {
  const thread = state.thread,
    cursor = nextBefore,
    control = byId("older");
  if (cursor == null || control.disabled) return;
  control.disabled = true;
  try {
    const data = await api(threadPath(thread) + "?before=" + encodeURIComponent(cursor));
    if (state.thread !== thread) return;
    const height = scroll.scrollHeight,
      top = scroll.scrollTop;
    const existing = new Set([...list.children].map((item) => item.dataset.id));
    const earlier = data.messages.filter((m) => !existing.has(String(m.id)));
    list.prepend(...earlier.map((m) => showMessage(m, state.bot, thread)));
    earliestLoaded = earlier[0]?.id ?? cursor;
    nextBefore = data.nextBefore ?? null;
    control.hidden = nextBefore === null;
    scroll.scrollTop = top + scroll.scrollHeight - height;
  } catch (err) {
    if (state.thread === thread) status(err.message);
  } finally {
    control.disabled = false;
  }
};
byId("compose").onsubmit = async (e) => {
  e.preventDefault();
  if (send.disabled || !state.thread) return;
  const thread = state.thread,
    captured = view;
  const submittedDraft = draft;
  const text = input.value.trim(), attachments = draft.attachments;
  const remember = !attachments.length && /^(?:请|帮我)?记住[\s：:，,]*(.+)$/su.exec(text);
  if (remember) {
    if (!can("memory")) { status("这个 Bot 已关闭记忆，可以在 Bot 资料中查看能力设置。"); return; }
    memoryEditor(memoryContext(), remember[1].trim(), () => {
      if (captured !== view) return;
      input.value = "";
      draft.requestId = null;
      draft.text = "";
      resizeInput();
      closePanel();
      success(state.bot.sharedThreadId === thread && state.bot.ownerId !== state.user.id ? "已交给所有者确认。" : "已记住，可以在「记住的事」中查看。");
    });
    return;
  }
  const routine = !attachments.length && routineDraft(text);
  if (routine) {
    if (!can("reminders")) { status("这个 Bot 已关闭提醒能力。"); return; }
    newRoutine(state.bot.privateThreadId, routine, () => {
      if (view !== captured || input.value.trim() !== text) return;
      input.value = draft.text = "";
      draft.requestId = null;
      resizeInput();
    });
    return;
  }
  // Keep the same id if a network failure hides an already accepted result.
  draft.requestId ||= requestId();
  const id = draft.requestId;
  draft.sending = true;
  paintPhoto();
  status();
  try {
    await api(threadPath(thread), "POST", {
      text,
      requestId: id,
      images: attachments.filter(item => item.photo), files: attachments.filter(item => !item.photo),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (submittedDraft.requestId === id) {
      submittedDraft.attachments = [];
      submittedDraft.text = "";
      submittedDraft.requestId = null;
      if (draft === submittedDraft) { input.value = ""; clearPhoto(); }
    }
    if (draft !== submittedDraft || state.thread !== thread) return;
    state.pending = true;
    await refreshThread(true);
  } catch (err) {
    if (captured === view) {
      status(err.message);
      if (err.status === 409) await refreshThread();
    }
  } finally {
    submittedDraft.sending = false;
    if (draft === submittedDraft) {
      paintPhoto();
    }
  }
};
input.oninput = () => {
  draft.text = input.value;
  draft.requestId = null;
  resizeInput();
};
input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && matchMedia("(pointer:fine)").matches) {
    e.preventDefault();
    if (!send.disabled) byId("compose").requestSubmit();
  }
};
async function addAttachments(files, photo = false) {
  const ownerDraft = draft;
  if (!files.length || ownerDraft.readingPhoto || ownerDraft.sending) return;
  const version = ++ownerDraft.photoVersion;
  ownerDraft.readingPhoto = true;
  resizeInput();
  try {
    if (ownerDraft.attachments.length + files.length > 6) throw new Error("每条消息最多 6 个附件。");
    const batch = [];
    for (const file of files) {
      if (!photo && file.size > 8 * 1024 * 1024) throw new Error("每个文件或录音最多 8 MB。");
      batch.push({ ...await (photo ? photoPayload(file) : encoded(file)), photo, name: file.name });
    }
    if (version !== ownerDraft.photoVersion) return;
    if ([...ownerDraft.attachments, ...batch].reduce((total, f) => total + f.data.length, 0) > 24 * 1024 * 1024)
      throw new Error("单条消息的附件合计最多 18 MB。");
    ownerDraft.attachments.push(...batch);
    ownerDraft.requestId = null;
    if (ownerDraft === draft) status();
  } catch (err) {
    if (ownerDraft === draft && version === ownerDraft.photoVersion) status(err.message);
  } finally {
    if (version === ownerDraft.photoVersion) {
      ownerDraft.readingPhoto = false;
      if (ownerDraft === draft) paintPhoto();
    }
  }
}
for (const control of [fileInput, byId("documents"), byId("audio-file")]) control.onchange = () => {
  const files = Array.from(control.files);
  control.value = "";
  addAttachments(files, control === fileInput);
};
function startVoiceInput() {
  const owner = draft;
  voiceInput({
    appendFile: file => { if (draft === owner) return addAttachments([file]); },
    chooseAudio: () => byId("audio-file").click(),
    appendText: text => {
      if (draft !== owner) return;
      input.value += (input.value ? " " : "") + text;
      input.dispatchEvent(new Event("input"));
    },
  });
}

function conversationScope(bot, id) {
  if (id !== bot.sharedThreadId) return "仅你可见";
  return "成员共享 · " + bot.members.length + " 位成员";
}
function showConversationList(focus = false) {
  chat.dataset.pane = "list";
  closeComposerActions();
  stopBotCall();
  stopVoiceInput();
  closePanel();
  cleanURL();
  if (focus && compact.matches) byId("rail-title").focus({ preventScroll: true });
}
function chooseBot(bot, id, keyboard) {
  if (listVisible()) history.pushState({ fromBotList: true }, "", location.href);
  if (state.thread === id) {
    chat.dataset.pane = "thread";
    cleanURL(id);
    scheduleRead();
  } else openThread(bot, id);
  if (keyboard && compact.matches) scroll.focus({ preventScroll: true });
}
function previewTime(stamp) {
  const date = new Date(stamp), today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour:"2-digit", minute:"2-digit" });
  today.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString() ? "昨天" : date.toLocaleDateString("zh-CN", { month:"short", day:"numeric" });
}
function renderRail() {
  if (!state.user) return;
  const search = byId("rail-search").value.trim().toLocaleLowerCase();
  const threads = state.bots.flatMap(bot => [bot.privateThreadId, bot.sharedThreadId].filter(Boolean)
    .map(id => ({ id, bot, scope: conversationScope(bot,id), preview: bot.previews?.[id] })));
  threads.sort((a,b) => (b.preview?.createdAt || 0) - (a.preview?.createdAt || 0));
  const rows = threads.filter(({bot,scope,preview}) => [bot.name, scope, preview?.text].some(text => text?.toLocaleLowerCase().includes(search)))
    .map(({id,bot,scope,preview}) => {
      const heading = h("span", { class: "choice-heading" }, h("strong", {}, bot.name),
        preview && h("time", { datetime: new Date(preview.createdAt).toISOString() }, previewTime(preview.createdAt)));
      const content = h("span", { class: "choice-name" }, heading,
        preview?.text && h("span", { class: "choice-preview" }, preview.text), h("small", {}, scope));
      const row = button(content, event => chooseBot(bot, id, event.detail === 0), "bot-choice");
      row.prepend(avatar(bot));
      row.dataset.thread = id;
      if (id === state.thread) row.setAttribute("aria-current","true");
      return row;
    });
  const rail = byId("rail-list"), focused = rail.contains(document.activeElement) ? document.activeElement.dataset.thread : null;
  rail.replaceChildren(...rows);
  if (focused) rows.find(row => row.dataset.thread === focused)?.focus({preventScroll:true});
  byId("rail-empty").hidden = rows.length > 0;
  byId("initial").textContent = Array.from(state.user.name || "?")[0].toUpperCase();
  byId("account-name-label").textContent = state.user.name;
}
function createBot() {
  chooseName("新建私人 Bot", "", async (name) => {
    const { bot } = await api("/api/bots", "POST", { name });
    await refreshBots();
    await openThread(bot, bot.privateThreadId);
  }, closePanel);
}
function memoryContext() {
  const thread = state.thread, bot = state.bot;
  return { bot, shared: bot.sharedThreadId === thread, owner: bot.ownerId === state.user.id, enabled: can("memory"),
    live: () => state.thread === thread, path: "/api/bots/threads/" + encodeURIComponent(thread) + "/memories" };
}
function delegationContext(thread = state.thread) {
  const bot = state.bot;
  return { bot, shared: bot.sharedThreadId === thread, enabled: can("delegation"), createBot, path: delegationPath(thread), live: () => state.thread === thread,
    focus: (id) => focusMessage(thread, id), update: (item) => {
      if (state.thread !== thread) return;
      delegationVersion++;
      delegations = [item, ...delegations.filter((old) => old.id !== item.id)];
      renderDelegations();
      refreshThread();
    } };
}
function renderDelegations() {
  const node = byId("delegation-cards");
  const active = delegations.filter((item) => ["proposed", "queued", "running"].includes(item.status));
  if (!active.length && delegations[0]?.status === "failed") active.push(delegations[0]);
  const signature = JSON.stringify(active);
  if (node.dataset.thread === state.thread && node.dataset.signature === signature) return;
  node.dataset.thread = state.thread;
  node.dataset.signature = signature;
  const pinned = nearBottom();
  node.hidden = !active.length;
  node.replaceChildren(...active.map((item) => delegationCard(delegationContext(), item)));
  showWelcome(list.childElementCount === 0 && node.hidden);
  if (pinned) scroll.scrollTop = scroll.scrollHeight;
}
async function refreshDelegations(thread) {
  const request = ++delegationVersion;
  try {
    const data = await api(delegationPath(thread));
    if (request !== delegationVersion || state.thread !== thread) return;
    delegations = data.delegations;
    delegationDirty = false;
    renderDelegations();
    schedulePoll();
  } catch (err) {
    if (request === delegationVersion && state.thread === thread) {
      delegationDirty = true;
      if (delegations.length) status(err.message);
    }
  }
}
function freshBot() {
  return state.bots.find((bot) => bot.id === state.bot?.id) || state.bot;
}
async function followups(thread, bot, startNew = false, initialId) {
  const { openFollowups } = await import("./followups.js");
  const members = thread === bot.sharedThreadId ? (await api(botPath(bot.id) + "/members")).members : [state.user];
  if (state.thread !== thread) return;
  await openFollowups({ threadId: thread, userId: state.user.id, members, startNew, initialId, onChange: () => refreshThread() });
}
function setting(label, symbol, handler) {
  const control = action(h("span", {}, label), handler, "setting");
  control.setAttribute("aria-label", label);
  const glyph = icon(symbol);
  glyph.setAttribute("aria-hidden", "true");
  control.prepend(glyph);
  control.append(h("span", { class: "disclose", "aria-hidden": "true" }, "›"));
  return control;
}
function settingsGroup(name, ...items) {
  return h("section", { class: "settings-group" }, h("h3", {}, name), ...items);
}
function settings() {
  const bot = freshBot();
  if (!bot) return;
  const owner = bot.ownerId === state.user.id, thread = state.thread;
  const configuration = [
    setting("Bot 资料", "spark", () => openProfile({ bot, owner, back: settings, onChange: (profile) => {
      if (state.bot?.id === bot.id) applyProfile(profile);
    } })),
    owner && setting("技能与工具", "gear", () => openExtensions(bot, settings)),
  ];
  const controls = [
    setting("待我确认", "outline", myDecisions),
    setting("记住的事", "bookmark", () => openMemories(memoryContext())),
    can("followups") && setting("跟进的事", "outline", () => followups(thread, bot)),
    setting("请其他 Bot 帮忙", "handoff", () => openDelegations(delegationContext())),
    setting("周期任务", "clock", () => openRoutines(bot.privateThreadId, can("reminders"))),
    can("reminders") && setting("查看我的提醒", "clock", remindersPanel),
  ];
  const manage = [];
  if (owner) {
    manage.push(setting("邀请成员", "plus", () => invitePanel(bot)));
    if (bot.sharedThreadId) manage.push(setting("管理共用成员", "shield", () => membersPanel(bot)));
    manage.push(setting("修改 Bot 名称", "edit", () =>
      chooseName("修改 Bot 名称", bot.name, async (name) => {
        const { bot: updated } = await api(botPath(bot.id), "PATCH", { name });
        await refreshBots();
        await openThread(updated, thread);
      }, settings)));
  } else manage.push(setting("查看共用成员", "shield", () => membersPanel(bot)));
  if (bot.hasArchives) manage.push(setting("共享归档", "bookmark", () => openArchives(bot, settings)));
  manage.push(setting(owner ? "管理 Bot" : "退出这个 Bot", "shield", () => manageBot(bot, {
    owner, back: settings, refresh: async (id) => {
      await refreshBots();
      const next = state.bots.find(b => b.id === id) || state.bots.find(b => b.isDefault) || state.bots[0];
      await openThread(next, next.privateThreadId);
    },
  })));
  const otherScope = bot.sharedThreadId && (thread === bot.sharedThreadId ?
    setting("打开我的私聊", "chat", () => openThread(bot, bot.privateThreadId)) :
    setting("打开成员共享对话", "chat", () => openThread(bot, bot.sharedThreadId)));
  settingsPanel(h("div", { class: "settings-layout" },
    h("div", { class: "settings-summary" },
      h("div", { class: "contact-detail" }, avatar(bot),
        h("strong", {}, bot.name), h("small", {}, conversationScope(bot, thread))),
      otherScope),
    h("div", { class: "settings-main" },
      settingsGroup("Bot 配置", ...configuration),
      settingsGroup("协作与记录", ...controls),
      settingsGroup("成员与管理", ...manage)),
    settingsGroup("通知", setting("最近通知", "chat", inbox), setting("账号和通知", "gear", accountPanel))), settings);
}
async function openDelegationNotice(thread, id) {
  const ctx = delegationContext(thread);
  try {
    const { delegation } = await api(ctx.path + "/" + encodeURIComponent(id));
    if (!ctx.live()) return;
    showDelegation(ctx, delegation);
    await api("/api/bot-inbox/read", "POST", { threadId: thread, delegationId: id });
    const { clearBotNotifications } = await import("./client.js");
    await clearBotNotifications({ threadId: thread, delegationId: id });
    if (ctx.live()) cleanURL(thread);
  } catch (err) { if (ctx.live()) status(err.message); }
}
async function inbox() {
  const { openBotInbox } = await import("./inbox.js");
  return openBotInbox(async (id, message, delegationId) => {
    await refreshBots();
    const target = state.bots.find((b) => b.privateThreadId === id || b.sharedThreadId === id);
    if (target) await openThread(target, id, { message, delegationId });
    else status("这段对话已不可访问。");
  });
}
async function myDecisions() {
  const { openMyDecisions } = await import("./followups.js");
  await openMyDecisions(async (thread, id) => {
    await refreshBots();
    const bot = state.bots.find(b => thread === b.privateThreadId || thread === b.sharedThreadId);
    if (!bot) { closePanel(); status("这段对话已不可访问。"); return; }
    await openThread(bot, thread);
    if (state.thread === thread) await followups(thread, bot, false, id);
  });
}
function accountPanel() {
  panel("账号和通知", note("当前账号 · " + state.user.name), setting("最近通知", "chat", inbox),
    setting(state.subscribed ? "此设备的通知已开启" : "开启此设备的通知", "clock", devicePanel),
    divider(), action("退出登录", async () => {
      const localPushEndpoints = await releaseLocalPushDevices().catch(() => []);
      await api("/api/logout", "POST", { localPushEndpoints });
      state.subscribed = false;
      setGate();
      cleanURL();
      await boot();
    }, "row danger"));
}
function invitePanel(bot) {
  panel(
    "邀请成员",
    note("对方可以查看「" + bot.name + "」的职责和说话风格，以及当前共享对话里已有和后续的消息、照片、共享记忆和跟进记录。你们各自的私聊仅自己可见。"),
    action(
      "生成邀请链接",
      async () => {
        const { token } = await api(botPath(bot.id) + "/invites", "POST", {});
        await refreshBots();
        state.bot = freshBot();
        const url = new URL("/", location.origin);
        url.hash = "invite=" + encodeURIComponent(token);
        const link = h("input", { id: "invite-link", type: "url", readonly: true, value: url.href });
        const copy = action(
          "复制邀请链接",
          async () => {
            if (!navigator.clipboard?.writeText) {
              link.focus();
              link.select();
              return;
            }
            try {
              await navigator.clipboard.writeText(url.href);
              copy.textContent = "已复制";
            } catch {
              link.focus();
              link.select();
              panelError("请复制已选中的邀请链接。");
            }
          },
          "primary",
        );
        panel(
          "邀请链接已准备好",
          note("请发给要邀请的人。链接在 24 小时内可用一次，重新生成会替换旧链接。"),
          field("邀请链接", link),
          copy,
          typeof navigator.share === "function"
            ? action(
                "分享…",
                async () => {
                  try {
                    await navigator.share({ title: "加入 " + bot.name, url: url.href });
                  } catch (err) {
                    if (err.name !== "AbortError") throw err;
                  }
                },
                "secondary",
              )
            : null,
          action("进入共享对话", () => {
            const now = freshBot();
            return openThread(now, now.sharedThreadId);
          }),
        );
      },
      "primary",
    ),
    button("返回", settings, "secondary"),
  );
}
async function membersPanel(bot) {
  const { members } = await api(botPath(bot.id) + "/members");
  if (state.bot?.id !== bot.id) return;
  const owner = bot.ownerId === state.user.id;
  const rows = members.map((member) => {
    const row = h(
      "div",
      { class: "row" },
      h("span", {}, member.name),
      member.id === bot.ownerId ? h("small", {}, "所有者") : null,
    );
    if (owner && member.id !== bot.ownerId)
      row.append(
        action(
          "移除",
          () =>
            panel(
              "移除 " + member.name + "？",
              note("对方将失去这个 Bot 的访问权限。"),
              button("保留成员", () => membersPanel(bot), "secondary"),
              action(
                "确认移除",
                async () => {
                  await api(botPath(bot.id) + "/members/" + encodeURIComponent(member.id), "DELETE");
                  await refreshBots();
                  await membersPanel(freshBot());
                },
                "row danger",
              ),
            ),
          "secondary",
        ),
      );
    return row;
  });
  panel(
    "共用成员",
    ...rows,
    owner
      ? action("收回为仅自己可用", () =>
          confirmBotChange("停止共用？",
            "你将回到私聊。原共享消息、照片、共享记忆和跟进记录会保存到你的「共享归档」，供你只读查看。其他成员会失去访问权限，下一次共用将从空白对话开始。",
            "停止共用", async () => {
              const { bot: updated } = await api(botPath(bot.id) + "/sharing", "DELETE");
              await refreshBots();
              await openThread(updated, updated.privateThreadId);
            }, () => membersPanel(bot)),
        )
      : null,
    button("返回", settings, "secondary"),
  );
}
function renderReminderStrip() {
  const node = byId("reminders"),
    count = state.reminders.length;
  const key = count + ":" + state.subscribed;
  if (node.dataset.key !== key || (count && !node.childElementCount)) {
    node.dataset.key = key;
    const controls = [button(count + " 个待提醒", remindersPanel, "")];
    if (!state.subscribed) controls.push(button("开启手机通知", devicePanel, ""));
    node.replaceChildren(...controls);
  }
  node.hidden = !count;
}
async function refreshDevice() {
  const user = state.user?.id;
  if (!user) return;
  const subscribed = await deviceSubscribed().catch(() => false);
  if (state.user?.id !== user) return;
  state.subscribed = subscribed;
  renderReminderStrip();
}
function devicePanel() {
  if (state.subscribed) {
    panel(
      "设备通知",
      note("这台设备可以接收你的提醒。"),
      action("试发本机通知", async () => {
        const thread = state.thread;
        const { testDeviceNotification } = await import("./client.js");
        await testDeviceNotification(thread);
        if (state.thread === thread) panel("测试通知已安排", note("约 15 秒后提醒你，可以锁屏试试。"), button("完成", closePanel, "primary"));
      }, "primary"),
      action(
        "关闭此设备的通知",
        async () => {
          await disableDevice();
          state.subscribed = false;
          renderReminderStrip();
          closePanel();
        },
        "secondary",
      ),
    );
  } else {
    panel(
      "手机通知",
      note("允许后，关闭页面也能收到提醒。"),
      action(
        "开启通知",
        async () => {
          await enableDevice();
          state.subscribed = true;
          renderReminderStrip();
          closePanel();
        },
        "primary",
      ),
      button("暂时跳过", closePanel, "secondary"),
    );
  }
}
const formatDate = (n) =>
  new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(n);
function remindersPanel() {
  if (!state.reminders.length) {
    panel(
      "我的提醒",
      note("这段对话还没有待提醒的事。"),
      button(
        "写个提醒",
        () => {
          closePanel();
          startReminder();
        },
        "primary",
      ),
    );
    return;
  }
  panel(
    "我的提醒",
    ...state.reminders.map((reminder) => {
      const control = action(h("span", {}, reminder.text), () => editReminder(reminder));
      control.append(h("small", {}, formatDate(reminder.dueAt)));
      return control;
    }),
  );
}
function editReminder(reminder) {
  const thread = state.thread;
  const date = new Date(reminder.dueAt);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const when = h("input", { id: "reminder-time", type: "datetime-local", value: local, required: true });
  const submit = h("button", { type: "submit", class: "primary" }, "保存时间");
  const updateId = requestId(),
    cancelId = requestId();
  const change = async (kind, dueAt) => {
    await api("/api/bot-reminders/" + encodeURIComponent(reminder.id), "POST", {
      threadId: thread,
      requestId: kind === "cancel" ? cancelId : updateId,
      kind,
      ...(dueAt ? { dueAt } : {}),
    });
    if (state.thread !== thread) return;
    await refreshThread();
    closePanel();
  };
  panel(
    "调整提醒",
    note(reminder.text),
    h(
      "form",
      {
        class: "sheet-form",
        onsubmit: (e) => {
          e.preventDefault();
          const stamp = new Date(when.value).getTime();
          if (!(stamp > Date.now())) {
            panelError("请选择将来的时间。");
            return;
          }
          run(submit, () => change("update", stamp));
        },
      },
      field("提醒时间", when),
      submit,
    ),
    action("取消这个提醒", () => change("cancel"), "row danger"),
  );
}
function startReminder() {
  const thread = state.thread;
  if (!thread || !can("reminders")) return;
  newReminder(thread, thread === state.bot.sharedThreadId, destination => {
    if (state.thread !== thread) return;
    status(destination === thread ? "已添加提醒。" : "已添加到你与这个助手的私聊。");
    refreshThread();
  });
}
byId("choose").append(icon("back"));
byId("choose").onclick = () => {
  if (history.state?.fromBotList) history.back();
  else {
    showConversationList(true);
    refreshBots().catch(err => status(err.message));
  }
};
byId("rail-search").oninput = renderRail;
byId("history-search").onsubmit = async event => {
  event.preventDefault();
  const term = byId("rail-search").value.trim();
  if (!term) return;
  await searchHistory(term, async (thread, message, live) => {
    await refreshBots();
    if (!live()) return;
    const bot = state.bots.find(b => b.privateThreadId === thread || b.sharedThreadId === thread);
    if (!bot) throw new Error("这段对话已不可访问。");
    byId("rail-search").value = "";
    await openThread(bot, thread, { message });
  });
};
byId("search-glyph").append(icon("search"));
byId("manage").onclick = settings;
byId("rail-add").append(icon("edit"));
for (const [id, handler, glyph] of [
  ["rail-inbox", inbox, "inbox"], ["rail-decisions", myDecisions, "clipboard"],
]) {
  const control = byId(id);
  control.prepend(icon(glyph));
  control.onclick = () => handler().catch(err => status(err.message));
}
byId("rail-add").onclick = createBot;
byId("rail-account").onclick = accountPanel;
byId("start-follow").prepend(icon("outline"));
byId("start-follow").onclick = () => followups(state.thread, state.bot, true).catch((err) => status(err.message));
byId("start-photo").prepend(icon("library"));
byId("start-photo").onclick = () => fileInput.click();
byId("start-reminder").prepend(icon("clock"));
byId("start-reminder").onclick = startReminder;
const closeComposerActions = bindComposerActions(() => fileInput.click(), startReminder, () => openRoutines(state.bot.privateThreadId), () => byId("documents").click(), startVoiceInput, () => {
  const thread = state.thread;
  if (!thread) return;
  stopVoiceInput();
  startBotCall(thread, state.bot.name, thread === state.bot.sharedThreadId, reason => {
    if (state.thread === thread) { status(reason); void refreshThread(true); }
  });
});
send.append(icon("send"));
window.addEventListener("popstate", () => {
  if (!state.user || chat.hidden) return;
  const id = queryThread();
  if (!id) {
    showConversationList(true);
    refreshBots().catch(err => status(err.message));
    return;
  }
  const bot = state.bots.find(item => id === item.privateThreadId || id === item.sharedThreadId);
  if (bot) openThread(bot, id);
  else boot();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else if (state.thread) checkCurrentAccount();
});
async function checkCurrentAccount() {
  const id = state.user?.id;
  try {
    const me = await api("/api/me");
    if (!me.authed || me.user.id !== id) {
      setGate();
      await boot();
      return;
    }
    await refreshThread();
    refreshDevice();
  } catch (err) {
    status(err.message);
    schedulePoll();
  }
}
window.addEventListener("pageshow", (e) => {
  if (e.persisted) {
    setGate();
    boot();
  }
});
window.addEventListener("online", () => {
  if (state.thread) refreshThread();
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type !== "open") return;
    const url = new URL(e.data.url, location.origin);
    if (url.origin !== location.origin || url.pathname !== "/") return;
    const thread = url.searchParams.get("thread");
    const message = url.searchParams.get("message"), delegationId = url.searchParams.get("delegation");
    // Navigate inside this authenticated tab so that an incoming notice can't discard another thread's draft.
    refreshBots().then(async () => {
      const bot = state.bots.find(b => b.privateThreadId === thread || b.sharedThreadId === thread);
      if (!bot) { status("这段对话已不可访问。"); return; }
      await openThread(bot, thread, { message, delegationId });
    }).catch(async err => {
      if (err.status === 401) { setGate(); await boot(); }
      else status(err.message);
    });
  });
}
boot();
