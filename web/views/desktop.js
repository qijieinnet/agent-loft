import RFB from "/vendor/novnc/core/rfb.js";
import { fill, h, icon, isTouch, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { copyText } from "../lib/markdown.js";
import { modal, showMenu } from "../lib/overlay.js";
import { S } from "../state.js";
import { renderSidebar } from "./sidebar.js";
import { createTouch } from "./desktop-touch.js";

// ---------- 远程桌面（noVNC） ----------
// 画面、鼠标、键盘、剪贴板都走 VNC 协议：页面 ↔ /ws/desktop ↔ 服务端的 VNC（Linux 上是 agent-loft 按需起的 x11vnc）。
// 进来时不自动连，点了「连接」才连（Linux 上会起 x11vnc）。
// 离开远程控制页时连接不断，画面在后台照常更新；断线了自己重连，点了「断开」才不连。
// 手机上：触摸事件由 desktop-touch.js 接管（触控板 / 触摸两种模式、双指本地放大），下面多一排按键。

const D = {
  rfb: null,
  /** idle / connecting / connected / error */
  state: "idle",
  message: "",
  /** 用户想不想连着：点了「断开」就是 false，不再自动重连 */
  want: false,
  backoff: 1000,
  retry: 0,
  /** 缩放到窗口里（否则按原始大小、可以滚动）。手机上一直缩放到窗口，靠双指放大 */
  fit: isTouch || localStorage.getItem("aim.deskFit") !== "0",
  /** 按一下就粘住的修饰键（keysym），下一个按键 / 点击带上它们 */
  mods: new Set(),
  viewOnly: false,
  name: "",
  /** 远程那边最近复制的文字 */
  remoteClip: "",
  pane: null,
  tools: null,
  screen: null,
  status: null,
};

function setLive(on) {
  if (S.remoteLive.desktop === on) return;
  S.remoteLive.desktop = on;
  renderSidebar();
}

/** 远程控制页切到「桌面」：没连着时中间一个「连接」按钮，点了才连 */
export function showDesktop(pane, tools) {
  if (!D.pane) {
    D.pane = pane;
    D.status = h("div", { class: "desk-status" });
    D.screen = h("div", { class: "desk-screen" });
    D.zoomBadge = h("button", { class: "desk-zoom", hidden: true, onclick: () => D.touch?.resetZoom() });
    D.hint = h("div", { class: "desk-hint", hidden: true });
    D.idle = h(
      "div",
      { class: "desk-idle", hidden: true },
      icon("monitor"),
      h("div", { class: "muted" }, "远程桌面未连接"),
      h("button", { class: "btn primary", onclick: reconnect }, icon("plug"), "连接桌面"),
    );
    D.keysBtn = isTouch
      ? h("button", { class: "desk-fbtn", title: "按键", "aria-label": "按键", onclick: () => toggleFullKeys() }, icon("keyboard"))
      : null;
    D.exitFull = h("button", { class: "desk-fbtn", title: "退出全屏", "aria-label": "退出全屏", onclick: () => setFull(false) }, icon("shrink"));
    D.fullBar = h("div", { class: "desk-fullbar", hidden: true }, D.exitFull, D.keysBtn);
    D.viewport = h("div", { class: "desk-viewport" }, D.screen, D.zoomBadge, D.hint, D.idle, D.fullBar);
    D.keyInput = isTouch ? mobileKeyInput() : null;
    D.keyRow = isTouch ? keyRow() : null;
    fill(pane, D.status, D.viewport, D.keyRow, D.keyInput);
    if (isTouch) {
      D.touch = createTouch({
        viewport: D.viewport,
        screen: D.screen,
        send: sendPointer,
        active: () => D.state === "connected",
        mods: { down: holdMods, up: releaseMods },
        onZoom: (z) => {
          D.zoomBadge.hidden = z <= 1.01;
          D.zoomBadge.textContent = `${z.toFixed(1)}× · 还原`;
        },
      });
    }
  }
  D.tools = tools;
  renderTools();
  renderStatus();
}

async function connect() {
  clearTimeout(D.retry);
  if (!D.want || D.rfb) return;
  D.state = "connecting";
  D.message = "";
  render();
  let password;
  try {
    ({ password } = await api("/api/desktop/session", { method: "POST" }));
  } catch (err) {
    return fail(err.message, err.status !== 403);
  }
  // 等密码的这会儿里点了断开，或者又发起了一次连接（切回前台、点了重连）：这次作罢
  if (!D.want || D.rfb) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const rfb = new RFB(D.screen, `${proto}://${location.host}/ws/desktop`, { credentials: { password }, shared: true, wsProtocols: [] });
  D.rfb = rfb;
  rfb.scaleViewport = D.fit;
  // 不裁剪：原始大小时 noVNC 的画面容器自己出滚动条
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.viewOnly = D.viewOnly;
  rfb.showDotCursor = true;
  // 画面没铺满时的边：和外框一个颜色，别再多出一圈灰
  rfb.background = "#111";
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.addEventListener("connect", () => {
    D.state = "connected";
    D.backoff = 1000;
    setLive(true);
    render();
    // 第一帧到了画布才有大小
    setTimeout(() => {
      D.touch?.connected();
      rotateHint();
    }, 300);
  });
  rfb.addEventListener("disconnect", (e) => {
    if (D.rfb !== rfb) return;
    D.rfb = null;
    setLive(false);
    if (!D.want) {
      // 认证失败之后 noVNC 还会报一次断开：别把「认证失败」盖成「已断开」
      if (D.state !== "error") D.state = "idle";
      return render();
    }
    // 意外断开（网络、服务重启、x11vnc 被停）：问一下还能不能用，能用就过一会儿重连
    void api("/api/remote").then(
      (r) => {
        if (!r.desktop?.allowed || !r.desktop.available) {
          // 权限或设置变了：侧栏、远程控制页跟着更新
          document.dispatchEvent(new Event("aim:remote"));
          return fail("远程桌面现在用不了了", false);
        }
        fail(e.detail?.clean ? "桌面连接已断开，正在重连…" : "连接断了，正在重连…", true);
      },
      () => fail("连不上服务器，正在重连…", true),
    );
  });
  rfb.addEventListener("credentialsrequired", () => rfb.sendCredentials({ password }));
  rfb.addEventListener("securityfailure", (e) => {
    D.want = false;
    const reason = String(e.detail?.reason ?? "").replace(/[\s!！.。]+$/, "");
    fail(`VNC 认证失败${reason ? `（${reason}）` : ""}。用的是已有的 VNC 服务的话，检查设置里的密码`, false);
  });
  rfb.addEventListener("clipboard", (e) => (D.remoteClip = e.detail.text ?? ""));
  rfb.addEventListener("desktopname", (e) => {
    D.name = e.detail.name ?? "";
    renderStatus();
  });
}

/** 出错了：retry 为真时按退避重连 */
function fail(message, retry) {
  D.state = "error";
  D.message = message;
  setLive(false);
  if (retry && D.want) {
    D.retry = setTimeout(() => void connect(), D.backoff);
    D.backoff = Math.min(D.backoff * 2, 30_000);
  }
  render();
}

function disconnect() {
  D.want = false;
  clearTimeout(D.retry);
  const rfb = D.rfb;
  D.rfb = null;
  D.state = "idle";
  setLive(false);
  rfb?.disconnect();
  render();
}

function reconnect() {
  D.want = true;
  D.backoff = 1000;
  if (D.rfb) {
    const rfb = D.rfb;
    D.rfb = null;
    rfb.disconnect();
  }
  void connect();
}

// 手机切回前台、网络恢复：断着的马上重连
const wake = () => {
  if (D.want && !D.rfb && document.visibilityState === "visible") reconnect();
};
document.addEventListener("visibilitychange", wake);
window.addEventListener("online", wake);

// ---------- 工具栏和状态 ----------

function render() {
  renderTools();
  renderStatus();
}

function renderStatus() {
  if (!D.status) return;
  const text =
    D.state === "connected"
      ? null
      : D.state === "connecting"
        ? "正在连接桌面…"
        : D.state === "error"
          ? D.message
          : null;
  D.status.hidden = !text;
  fill(
    D.status,
    text ? h("span", { class: D.state === "error" ? "error-text" : "muted" }, text) : null,
    D.state === "error" && !D.want ? h("button", { class: "btn small", onclick: reconnect }, "连接") : null,
  );
  // 没连着（还没点过连接、点了断开）：中间的「连接桌面」
  D.idle.hidden = D.state !== "idle";
  D.screen.classList.toggle("dim", D.state !== "connected");
  D.touch?.refresh();
}

/** 手机竖着看横的桌面：提示一次横过来 */
function rotateHint() {
  const c = D.screen.querySelector("canvas");
  if (!isTouch || !c || innerHeight <= innerWidth || c.width <= c.height || sessionStorage.getItem("aim.deskRotate")) return;
  sessionStorage.setItem("aim.deskRotate", "1");
  D.hint.textContent = "横过来看更大 · 双指张开可以放大";
  D.hint.hidden = false;
  setTimeout(() => (D.hint.hidden = true), 5000);
}

/** 手势发来的鼠标：按帧缓冲坐标直接发（noVNC 的公开接口没有这个） */
function sendPointer(x, y, mask) {
  if (D.state !== "connected" || D.viewOnly || !D.rfb?._sock) return;
  RFB.messages.pointerEvent(D.rfb._sock, x, y, mask);
}

function tool(label, iconName, onclick, opts = {}) {
  return h(
    "button",
    { class: `icon-btn desk-tool${opts.on ? " on" : ""}`, title: label, "aria-label": label, disabled: opts.disabled, onclick },
    icon(iconName),
  );
}

function renderTools() {
  if (!D.tools || D.tools.closest(".remote-pane")?.querySelector(".remote-body:not([hidden])") !== D.pane) return;
  const on = D.state === "connected";
  const trackpad = D.touch?.mode === "trackpad";
  fill(
    D.tools,
    D.touch ? tool(trackpad ? "触控板模式（点一下换成触摸模式）" : "触摸模式（点一下换成触控板模式）", trackpad ? "pointer" : "hand", toggleTouchMode) : null,
    D.touch ? tool("手势说明", "help", openGestureHelp) : null,
    tool("剪贴板", "clipboard", openClipboard, { disabled: !on }),
    tool("发送按键", "command", (e) => openKeysMenu(e.currentTarget), { disabled: !on || D.viewOnly }),
    tool(D.viewOnly ? "只看（点一下恢复控制）" : "只看不控制", "eye", toggleViewOnly, { on: D.viewOnly }),
    // 手机上靠双指放大，不切原始大小
    isTouch ? null : tool(D.fit ? "原始大小" : "缩放到窗口", D.fit ? "maximize" : "restore", toggleFit),
    tool("全屏", "expand", () => setFull(true)),
    on || D.state === "connecting" ? tool("断开连接", "unplug", disconnect) : tool("连接", "plug", reconnect),
  );
}

// 全屏：浏览器支持就用真全屏；iPhone 的 Safari 不支持元素全屏，改成铺满整个页面（盖住顶栏、侧栏）
const fsEnabled = () => document.fullscreenEnabled || document.webkitFullscreenEnabled;
const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement;

function setFull(on) {
  if (on) {
    if (fsEnabled()) {
      const req = D.pane.requestFullscreen ?? D.pane.webkitRequestFullscreen;
      // 被浏览器拒了（比如不是用户点的）：退回铺满页面
      Promise.resolve(req?.call(D.pane)).catch(() => D.pane.classList.add("desk-full"));
    } else D.pane.classList.add("desk-full");
  } else {
    D.pane.classList.remove("desk-full");
    if (fsElement() === D.pane) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
  }
  syncFull();
}

/**
 * 全屏时画面左上角「退出全屏」（手机上没有 Esc；真全屏在电脑上按 Esc 就行，不显示）。
 * 手机上全屏时下面那排键先收起来，左上角的「按键」拉出来
 */
function syncFull() {
  if (!D.pane) return;
  const pseudo = D.pane.classList.contains("desk-full");
  const full = pseudo || fsElement() === D.pane;
  if (full !== D.pane.classList.contains("full")) {
    D.pane.classList.toggle("full", full);
    toggleFullKeys(false);
  }
  D.fullBar.hidden = !(pseudo || (isTouch && full));
}

function toggleFullKeys(open = !D.pane.classList.contains("keys-open")) {
  D.pane.classList.toggle("keys-open", open);
  D.keysBtn?.classList.toggle("on", open);
  if (!open && document.activeElement === D.keyInput) D.keyInput.blur();
}
document.addEventListener("fullscreenchange", syncFull);
document.addEventListener("webkitfullscreenchange", syncFull);

function toggleViewOnly() {
  D.viewOnly = !D.viewOnly;
  if (D.rfb) D.rfb.viewOnly = D.viewOnly;
  toast(D.viewOnly ? "只看：鼠标键盘不会发给桌面" : "已恢复控制");
  renderTools();
}

function toggleFit() {
  D.fit = !D.fit;
  localStorage.setItem("aim.deskFit", D.fit ? "1" : "0");
  if (D.rfb) D.rfb.scaleViewport = D.fit;
  renderTools();
}

function toggleTouchMode() {
  const next = D.touch.mode === "trackpad" ? "touch" : "trackpad";
  D.touch.setMode(next);
  toast(next === "trackpad" ? "触控板模式：手指滑动移动指针，轻点单击" : "触摸模式：点哪里就点哪里", 3000);
  renderTools();
}

/** 两种模式各自的手势，当前的排在前面 */
function openGestureHelp() {
  const rows = (list) => h("div", { class: "gesture-list" }, list.map(([g, what]) => h("div", { class: "gesture-row" }, h("b", {}, g), h("span", {}, what))));
  const trackpad = h(
    "div",
    { class: "gesture-sec" },
    h("h4", {}, "触控板模式", D.touch.mode === "trackpad" ? "（现在）" : ""),
    rows([
      ["单指滑动", "移动指针（划得快走得远）"],
      ["轻点", "在指针处单击；连点两下是双击"],
      ["双指轻点 / 长按", "右键"],
      ["长按后拖动", "按住左键拖：选文字、拖窗口"],
      ["双指上下、左右滑", "滚动"],
      ["双指捏合", "放大缩小画面；放大后指针推到边上，画面跟着走"],
    ]),
  );
  const touch = h(
    "div",
    { class: "gesture-sec" },
    h("h4", {}, "触摸模式", D.touch.mode === "touch" ? "（现在）" : ""),
    rows([
      ["轻点", "在手指的位置单击"],
      ["长按", "右键"],
      ["长按后拖动", "按住左键拖"],
      ["单指拖动", "没放大时是按住左键拖；放大后是挪画面"],
      ["双指上下、左右滑", "滚动"],
      ["双指捏合", "放大缩小画面"],
    ]),
  );
  modal({
    title: "手势说明",
    body: h(
      "div",
      { class: "modal-body" },
      D.touch.mode === "trackpad" ? [trackpad, touch] : [touch, trackpad],
      h("div", { class: "muted" }, "下面那排键：Ctrl、Alt、Win 点一下会亮着，下一个按键或点击会带上它，再点一下取消。最左边的键盘按钮弹出键盘打字。"),
    ),
  });
}

// X11 的 keysym
const K = {
  ctrl: 0xffe3,
  alt: 0xffe9,
  super: 0xffeb,
  tab: 0xff09,
  esc: 0xff1b,
  print: 0xff61,
  del: 0xffff,
  f4: 0xffc1,
  enter: 0xff0d,
  back: 0xff08,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  home: 0xff50,
  end: 0xff57,
};

/** 按下 mods、按一下 key、再松开 mods */
function combo(mods, key) {
  const rfb = D.rfb;
  if (!rfb || D.viewOnly) return;
  for (const m of mods) rfb.sendKey(m, null, true);
  rfb.sendKey(key, null);
  for (const m of [...mods].reverse()) rfb.sendKey(m, null, false);
  // 手机上别去抢焦点：软键盘会收起来
  if (!isTouch) rfb.focus();
}

/** 按一个键，带上粘住的修饰键，用完就松开 */
function sendKey(keysym) {
  combo([...D.mods], keysym);
  if (D.mods.size) setMods(new Set());
}

function setMods(next) {
  D.mods = next;
  for (const btn of D.keyRow?.querySelectorAll("[data-mod]") ?? []) btn.classList.toggle("on", D.mods.has(Number(btn.dataset.mod)));
}

/** 手势点击、拖动前后：按下 / 松开粘住的修饰键（Ctrl+点击之类） */
let heldMods = [];
function holdMods() {
  heldMods = D.viewOnly ? [] : [...D.mods];
  for (const m of heldMods) D.rfb?.sendKey(m, null, true);
}
function releaseMods() {
  for (const m of heldMods.reverse()) D.rfb?.sendKey(m, null, false);
  if (heldMods.length) setMods(new Set());
  heldMods = [];
}

/** 手机：画面下面一排键（最左边的键盘按钮弹出软键盘） */
function keyRow() {
  const keys = [
    // 再点一下收起键盘
    [icon("keyboard"), () => (document.activeElement === D.keyInput ? D.keyInput.blur() : D.keyInput.focus()), "打字（再点一下收起）"],
    ["Esc", K.esc],
    ["Tab", K.tab],
    ["Ctrl", K.ctrl, null, true],
    ["Alt", K.alt, null, true],
    ["Win", K.super, null, true],
    ["←", K.left],
    ["↑", K.up],
    ["↓", K.down],
    ["→", K.right],
    ["Home", K.home],
    ["End", K.end],
    ["Del", K.del],
  ];
  return h(
    "div",
    { class: "term-keys desk-keys" },
    keys.map(([label, key, title, mod]) =>
      h(
        "button",
        {
          class: `term-key${typeof key === "function" ? " icon" : ""}`,
          title: title ?? undefined,
          "data-mod": mod ? String(key) : undefined,
          // 按下时别抢走焦点，不然软键盘会收起来
          onpointerdown: (e) => e.preventDefault(),
          onclick: () => {
            if (D.state !== "connected") return;
            if (typeof key === "function") return key();
            if (!mod) return sendKey(key);
            const next = new Set(D.mods);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            setMods(next);
            // 只按了修饰键就松手（比如单按 Win 打开开始菜单）：再点一下发出去
          },
          ondblclick: mod ? () => (setMods(new Set()), combo([], key)) : undefined,
        },
        label,
      ),
    ),
  );
}

function openKeysMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu({ x: r.right - 200, y: r.bottom + 4 }, [
    { label: "Ctrl+Alt+Del", onclick: () => D.rfb?.sendCtrlAltDel() },
    { label: "Win / Super", onclick: () => combo([], K.super) },
    { label: "Alt+Tab", onclick: () => combo([K.alt], K.tab) },
    { label: "Alt+F4", onclick: () => combo([K.alt], K.f4) },
    { label: "Esc", onclick: () => combo([], K.esc) },
    { label: "Print Screen", onclick: () => combo([], K.print) },
  ]);
}

/** 剪贴板：看远程那边复制了什么；把文字发到远程的剪贴板 */
function openClipboard() {
  const text = h("textarea", { class: "desk-clip", rows: 6, placeholder: "在这里粘贴，发到远程桌面的剪贴板" });
  text.value = D.remoteClip;
  const body = h(
    "div",
    { class: "modal-body" },
    h("div", { class: "muted" }, D.remoteClip ? "下面是远程桌面最近复制的文字。改好后点「发到远程」，再在远程那边粘贴。" : "粘贴文字后点「发到远程」，再在远程那边粘贴。"),
    text,
  );
  const copy = h("button", { class: "btn", onclick: (e) => void copyText(text.value, e.currentTarget) }, "复制到本机");
  const send = h(
    "button",
    {
      class: "btn primary",
      onclick: () => {
        D.rfb?.clipboardPasteFrom(text.value);
        close();
        toast("已发到远程剪贴板");
      },
    },
    "发到远程",
  );
  const close = modal({ title: "剪贴板", body, foot: h("div", { class: "modal-foot" }, copy, send) });
  text.focus();
}

/**
 * 手机：软键盘打的字逐个发过去（noVNC 自己只认实体键盘）。
 * 用 beforeinput 而不是 keydown：安卓的软键盘大多不报具体按了哪个键（keyCode 229），空输入框里按退格连事件都没有
 */
function mobileKeyInput() {
  const input = h("textarea", { class: "desk-keyinput", autocapitalize: "off", autocomplete: "off", autocorrect: "off", spellcheck: "false", "aria-label": "发给桌面的键盘输入" });
  // 安卓的输入法在空输入框里按退格常常什么事件都没有：里面一直留一个占位的空格，退格删它时就有 beforeinput 了
  // （删除被拦下，空格一直在）
  const SENTINEL = " ";
  const reset = () => {
    input.value = SENTINEL;
    input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  input.addEventListener("focus", reset);
  const typeText = (text) => {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 10) sendKey(K.enter);
      else sendKey(cp < 0x100 ? cp : 0x01000000 | cp);
    }
  };
  input.addEventListener("beforeinput", (e) => {
    // 中文输入法组字中：等选完字（compositionend）再发
    if (e.isComposing || e.inputType === "insertCompositionText") return;
    e.preventDefault();
    if (e.inputType === "insertText" || e.inputType === "insertReplacementText") typeText(e.data ?? "");
    else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") sendKey(K.enter);
    else if (e.inputType === "deleteContentBackward") sendKey(K.back);
    else if (e.inputType === "deleteContentForward") sendKey(K.del);
    else if (e.inputType === "insertFromPaste") typeText(e.dataTransfer?.getData("text/plain") ?? e.data ?? "");
  });
  input.addEventListener("compositionend", (e) => {
    typeText(e.data ?? "");
    reset();
  });
  // 实体键盘（iPad 外接键盘）的这几个键不走 beforeinput
  input.addEventListener("keydown", (e) => {
    const map = { Escape: K.esc, Tab: K.tab, ArrowLeft: K.left, ArrowUp: K.up, ArrowRight: K.right, ArrowDown: K.down };
    if (!(e.key in map)) return;
    e.preventDefault();
    sendKey(map[e.key]);
  });
  return input;
}
