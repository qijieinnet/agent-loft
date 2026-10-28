import { fill, h, icon, ICON, isTouch, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { desktop, S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { agentLabel, renderSidebar } from "./sidebar.js";
import { draftPick, renderContext, renderTopbar, sentKeys, updateCtxVisibility } from "./topbar.js";
import { addItem, openConversation, openLightbox, renderEmpty, scrollToBottom } from "./messages.js";
import { renderScheduled } from "./schedule.js";
import { renderTodos } from "./todos.js";
import { cancelVoice, SpeechRec, toggleVoice } from "./voice.js";
import { closeSlashMenu, commandUsage, oneLine, slashKeydown, updateSlashMenu } from "./slash.js";
import { doAction, openModelPicker, openSessions } from "./conv-actions.js";

// ---------- 输入框 ----------

/**
 * 手机上「/」「@」菜单刚弹出来时收起键盘：不然键盘加菜单把屏幕占满了。
 * 菜单留着，点一条就选；想接着打字筛选就点一下输入框，点别处菜单关掉
 */
let keepMenus = false;
export function hideKeyboardForMenu() {
  if (!isTouch || document.activeElement !== ui.input) return;
  keepMenus = true;
  ui.input.blur();
}
document.addEventListener("pointerdown", (e) => {
  if (!keepMenus || [ui.input, ui.slashMenu].some((el) => el?.contains(e.target))) return;
  keepMenus = false;
  closeSlashMenu();
});

export function renderComposer() {
  cancelVoice();
  ui.input = h("textarea", {
    rows: 1,
    placeholder: "随心输入",
    oninput: () => {
      // 识别过程中用户自己动了输入框，以用户为准，停掉识别
      cancelVoice();
      autosize();
      void updateSlashMenu();
    },
    onfocus: () => (keepMenus = false),
    onblur: () =>
      setTimeout(() => {
        // 为了让出地方收起的键盘（见 hideKeyboardForMenu）：菜单留着；点回输入框也不关
        if (keepMenus || document.activeElement === ui.input) return;
        closeSlashMenu();
      }, 150),
    onkeydown: (e) => {
      if (slashKeydown(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch) {
        e.preventDefault();
        void sendMessage();
      }
    },
    onpaste: (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
  });
  ui.fileInput = h("input", {
    type: "file",
    multiple: true,
    style: { display: "none" },
    onchange: (e) => {
      void addFiles([...e.target.files]);
      e.target.value = "";
    },
  });
  ui.sendBtn = h("button", { class: "send-btn", title: "发送", onclick: () => (S.busy && !hasDraft() ? stopTurn() : sendMessage()) });
  // 桌面端（Electron）里不放语音输入
  ui.micBtn = SpeechRec && !desktop
    ? h("button", { class: "icon-btn mic-btn", title: "语音输入", onclick: toggleVoice }, icon("mic"))
    : null;
  ui.ctxBar = h("div", { class: "ctx-bar" });
  ui.modelSlot = h("span", { class: "model-slot" });
  ui.ctxRing = h("span", { class: "ctx-ring-slot" });
  ui.chips = h("div", { class: "chips" });
  ui.schedBar = h("div", { class: "sched-bar", hidden: true });
  ui.todoBar = h("div", { class: "todo-bar", hidden: true });
  ui.slashMenu = h("div", { class: "slash-menu", hidden: true });
  ui.composer = h(
    "div",
    {
      class: "composer",
      ondragover: (e) => {
        e.preventDefault();
        ui.composer.classList.add("drag");
      },
      ondragleave: () => ui.composer.classList.remove("drag"),
      ondrop: (e) => {
        e.preventDefault();
        ui.composer.classList.remove("drag");
        void addFiles([...(e.dataTransfer?.files ?? [])]);
      },
    },
    ui.slashMenu,
    ui.chips,
    ui.input,
    h(
      "div",
      { class: "composer-row" },
      h("button", { class: "icon-btn add-btn", title: "添加附件", onclick: () => ui.fileInput.click() }, icon("plus")),
      ui.fileInput,
      h("span", { class: "spacer" }),
      ui.ctxRing,
      ui.modelSlot,
      ui.micBtn,
      ui.sendBtn,
    ),
  );
  fill(ui.composerWrap,
    ui.toBottom,
    h("div", { class: "composer-box" }, ui.todoBar, ui.schedBar, ui.ctxBar, ui.composer),
  );
  ui.input.addEventListener("input", updateSendBtn);
  updateSendBtn();
  renderContext();
  renderScheduled();
  renderTodos();
}

export function autosize() {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, innerHeight * 0.4)}px`;
}

function hasDraft() {
  return !!ui.input?.value.trim() || S.uploads.length > 0;
}

export function updateSendBtn() {
  if (!ui.sendBtn) return;
  // 已经点了发送、还在等服务器确认：转圈，不能再点，避免以为没点上又点一次
  if (S.sending) {
    ui.sendBtn.innerHTML = '<span class="send-spinner"></span>';
    ui.sendBtn.title = "发送中…";
    ui.sendBtn.disabled = true;
    return;
  }
  const stop = S.busy && !hasDraft();
  ui.sendBtn.innerHTML = stop ? ICON.stop : ICON.send;
  ui.sendBtn.title = stop ? "停止" : "发送";
  ui.sendBtn.disabled = !stop && !hasDraft();
}

export function setBusy(busy) {
  S.busy = !!busy;
  updateSendBtn();
  renderTodos();
}

export function renderChips() {
  if (!ui.chips) return;
  const remove = (u) => {
    S.uploads = S.uploads.filter((x) => x !== u);
    if (u.url) URL.revokeObjectURL(u.url);
    renderChips();
  };
  fill(ui.chips, 
    ...S.uploads.map((u) =>
      u.url
        ? h(
            "span",
            { class: `chip-img${u.uploading ? " uploading" : ""}`, title: u.name },
            h("img", { src: u.url, alt: u.name, onclick: () => openLightbox(u.url, u.name) }),
            u.uploading ? h("span", { class: "spinner" }) : null,
            h("button", { class: "chip-x", title: "移除", onclick: () => remove(u) }, "×"),
          )
        : h(
            "span",
            { class: "chip" },
            u.uploading ? h("span", { class: "spinner" }) : "📄",
            h("span", {}, u.name),
            h("button", { title: "移除", onclick: () => remove(u) }, "×"),
          ),
    ),
  );
  updateSendBtn();
}

export async function ensureConversation() {
  if (S.current) return S.current;
  if (!S.draftAgent) throw new Error("没有可用的 agent");
  let info;
  try {
    info = await api("/api/conversations", {
      method: "POST",
      body: { expert: S.draftExpert ?? S.draftAgent, cwd: S.draftCwd ?? undefined },
    });
  } catch (err) {
    // 选的目录没了（被删、或工作区改了）：退回根目录，让用户重新确认
    if (err.status === 400 && S.draftCwd) {
      S.draftCwd = null;
      renderEmpty();
    }
    throw err;
  }
  // 新对话里选过模型 / 思考程度：建好会话后先切过去再发消息
  const pick = { ...draftPick() };
  for (const [action, value] of [["model", pick.model], ["effort", pick.effort]]) {
    if (!value) continue;
    try {
      const res = await api(`/api/conversations/${encodeURIComponent(info.key)}/action`, { method: "POST", body: { action, value } });
      info = res.info;
    } catch (err) {
      toast(`${action === "model" ? "切换模型" : "切换思考程度"}失败：${err.message}`);
    }
  }
  S.convs.set(info.key, info);
  S.current = info.key;
  S.allowedAgents = S.agents.filter((a) => a.enabled).map((a) => a.id);
  S.seq.set(info.key, 0);
  history.replaceState(history.state, "", `#${encodeURIComponent(info.key)}`);
  WS.presence();
  fill(ui.msgInner, );
  WS.subscribe(info.key, 0);
  renderTopbar();
  renderSidebar();
  return info.key;
}

async function addFiles(files) {
  if (!files.length) return;
  let key;
  try {
    key = await ensureConversation();
  } catch (err) {
    toast(err.message);
    return;
  }
  for (const file of files) {
    const u = { name: file.name || "粘贴的图片.png", kind: file.type.startsWith("image/") ? "image" : "file", uploading: true };
    // 图片用本地文件直接做缩略图，不用等上传完、也不用再从服务器取
    if (u.kind === "image") u.url = URL.createObjectURL(file);
    S.uploads.push(u);
    renderChips();
    try {
      const res = await api(`/api/conversations/${encodeURIComponent(key)}/upload?name=${encodeURIComponent(u.name)}`, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      Object.assign(u, { id: res.id, kind: res.kind, uploading: false, serverName: res.name });
      if (u.kind !== "image" && u.url) (URL.revokeObjectURL(u.url), delete u.url);
    } catch (err) {
      S.uploads = S.uploads.filter((x) => x !== u);
      if (u.url) URL.revokeObjectURL(u.url);
      toast(`${u.name} 上传失败：${err.message}`);
    }
    renderChips();
  }
}

/** 发送中：按钮转圈、输入框只读（确认后要清空它，期间再打的字会丢） */
function setSending(on) {
  S.sending = on;
  if (ui.input) {
    ui.input.readOnly = on;
    ui.input.classList.toggle("sending", on);
  }
  updateSendBtn();
}

export async function sendMessage() {
  if (S.sending) return;
  cancelVoice();
  const text = ui.input.value;
  if (!text.trim() && S.uploads.length === 0) return;
  if (S.uploads.some((u) => u.uploading)) {
    toast("附件还在上传，稍等");
    return;
  }
  closeSlashMenu();
  let key;
  let res;
  setSending(true);
  // 发出去之后恢复自动滚动；回显的那条用户消息到了就顶到最上面（见 applyEvent）
  S.pinNext = true;
  try {
    key = await ensureConversation();
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    // 命令（比如 /status 要现读额度）可能比普通发送慢，多给点时间
    res = await WS.request({ t: "send", key, text, uploads: S.uploads.map((u) => u.id) }, 45000);
  } catch (err) {
    S.pinNext = false;
    toast(err.message);
    return;
  } finally {
    setSending(false);
  }
  if (!res?.reply) {
    sentKeys.add(key);
    updateCtxVisibility();
  }
  ui.input.value = "";
  autosize();
  for (const u of S.uploads) if (u.url) URL.revokeObjectURL(u.url);
  S.uploads = [];
  renderChips();
  updateSendBtn();
  if (res?.reply) {
    // 命令不进会话记录，没有回显：直接贴到底看结果
    S.pinNext = false;
    await showCommandReply(text.trim(), res.reply, res.info);
    scrollToBottom();
  } else if (!ui.pinEl) ui.follow = true;
}

/** 会改变当前会话（换会话、换目录、换 agent）的命令，执行完要重拉一遍 */
const RELOADING_COMMANDS = new Set(["new", "fork", "resume", "agent", "claude", "codex", "cd"]);

/** agent-loft 命令的结果：只显示给发命令的这个页面，不进会话记录 */
async function showCommandReply(text, reply, info) {
  if (info) S.convs.set(info.key, info);
  renderTopbar();
  const head = text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
  if (RELOADING_COMMANDS.has(head) && S.current) await openConversation(S.current);
  const note = (md) => addItem({ type: "notice", text: md });
  switch (reply.type) {
    case "text":
      note(`\`${text}\`\n\n${reply.text}`);
      return;
    case "sessions":
      await openSessions(reply.allDirs);
      return;
    case "models":
      await openModelPicker();
      return;
    case "agents":
      note(
        `当前 agent：**${agentLabel(reply.current)}**\n\n可切换：${reply.agents.map((a) => `\`/${a.id}\` ${a.label}`).join("　")}`,
      );
      return;
    case "commands":
      note(reply.commands.map((c) => `\`${commandUsage(c)}\` ${oneLine(c.description)}`).join("\n\n") || "没有可用命令");
      return;
  }
}

async function stopTurn() {
  await doAction("stop");
}
