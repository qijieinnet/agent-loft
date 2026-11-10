import { h, icon, toast } from "../lib/dom.js";
import { desktop, S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { ensureConversation, updateSendBtn } from "./composer.js";
import { currentAgentId } from "./slash.js";
import { cancelVoice } from "./voice.js";

// ---------- 实时语音对话（只有 Codex） ----------
// 声音经服务器中转：服务器自己和 OpenAI 建 WebRTC（core/realtime-relay.ts），这里和服务器之间走现有的 WebSocket，
// 两头都是 24kHz、16 位、单声道的 PCM（二进制帧）。采集、播放在 AudioWorklet 里做（lib/rt-worklet.js）。
// 这样能打开网页的地方就能语音（反向代理、Cloudflare Tunnel 都能过），浏览器不直连 OpenAI。
// 语音模型把要干的活转交给这条对话里的 Codex：那一轮像打字发的消息一样出现在对话里（用户消息前面带 🎙️）。
// 通话默认打开沉浸式光球界面，也可以收起成输入框位置的通话条。

/** 桌面端（Electron）没申请麦克风权限：macOS 上直接用会被系统拦掉，先不放 */
const supported = !desktop && !!window.AudioWorkletNode && !!navigator.mediaDevices?.getUserMedia;

/**
 * 回复的声音直接从 AudioContext 放出来，iOS / Safari 的回声消除照样管得到；Chrome 等的回声消除只认 WebRTC 放出来的声音，
 * 不绕一下模型会听到自己说话、自己打断自己：在本页里用一对 RTCPeerConnection 环回一下，再交给 <audio> 放
 */
const ua = navigator.userAgent;
const appleAudio = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));

const call = {
  /** idle / connecting / live */
  state: "idle",
  key: null,
  mic: null,
  /** 播放用的 worklet 节点：服务器发来的 PCM 交给它 */
  play: null,
  /** Chrome 等的回声消除环回（见 appleAudio） */
  loop: null,
  audio: null,
  muted: false,
  startedAt: 0,
  raf: 0,
  /** 音量表接上的节点，挂断时断开（AudioContext 本身留着，见 audioCtx） */
  nodes: [],
  micLevel: null,
  outLevel: null,
  /** 字幕：谁在说、说了什么（一句说完 done 之后，下一句同一个人开口就换新的） */
  caption: { role: null, text: "", done: false },
  panel: null,
  dialog: null,
  compact: false,
  session: 0,
  els: null,
};

// ---------- 音色和语言（按设备记在浏览器里） ----------

const PREFS_KEY = "agent-loft.voiceCall";
/** 和服务端 REALTIME_VOICES 一致（就是 ChatGPT 语音模式那几个）；空 = Codex 默认（cove） */
const VOICES = [
  ["", "默认（Cove）"],
  ["cove", "Cove · 男声，沉着直接"],
  ["juniper", "Juniper · 女声，开朗"],
  ["maple", "Maple · 女声，爽朗坦率"],
  ["vale", "Vale · 女声，明亮好奇"],
  ["sol", "Sol · 女声，从容干练"],
  ["spruce", "Spruce · 男声，平和"],
  ["ember", "Ember · 男声，自信乐观"],
  ["arbor", "Arbor · 男声，随和"],
  ["breeze", "Breeze · 活泼真诚"],
];
/** 和服务端 REALTIME_LANGUAGES 一致；空 = 跟着你说的语言 */
const LANGUAGES = [
  ["", "跟着我说的语言"],
  ["zh-CN", "普通话（简体）"],
  ["zh-TW", "国语（繁体）"],
  ["yue", "粤语"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
];

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { voice: typeof p.voice === "string" ? p.voice : "", language: typeof p.language === "string" ? p.language : "" };
  } catch {
    return { voice: "", language: "" };
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // 隐私模式等存不了：这次通话照样用
  }
}

const ICON_WAVE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>';
const ICON_MIC_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6"/><path d="M5 10a7 7 0 0 0 11.7 5.2M19 10a7 7 0 0 1-.6 2.8M12 17v5"/></svg>';

/** 输入框里的「语音对话」按钮 */
export function canCall() {
  return supported && currentAgentId() === "codex";
}

export function callButton() {
  ui.callBtn = h("button", { class: "send-btn call-btn", title: "语音对话", "aria-label": "语音对话", html: ICON_WAVE, onclick: () => void startCall() });
  syncCall();
  return ui.callBtn;
}

/**
 * 换了对话 / 重画了输入框之后对齐：只有 Codex 的对话显示按钮；通话中切到别的对话就挂断，
 * 输入框重画了就把通话条重新放回去
 */
export function syncCall() {
  // 新对话里点的：会话还在建（call.key 还没有），建好时会重画一次，不算切走
  if (call.state !== "idle") {
    if (call.key && S.current !== call.key) {
      endCall("切换了对话，语音对话已结束");
    } else if (call.panel) {
      ui.composer?.classList.add("in-call");
      if (!call.panel.isConnected || (call.compact && call.panel.previousElementSibling !== ui.composer)) {
        mountPanel();
      }
    }
  }
  updateSendBtn();
}

async function startCall() {
  if (call.state !== "idle") return;
  if (!window.isSecureContext) {
    toast("语音对话要用麦克风，需要 HTTPS 访问（或者本机 localhost）");
    return;
  }
  cancelVoice();
  const session = ++call.session;
  call.state = "connecting";
  call.compact = false;
  call.muted = false;
  call.caption = { role: null, text: "", done: false };
  // 在点击里建好、先 play 一次：iOS 上不是用户手势里起的播放会被拦
  call.audio = h("audio", { autoplay: true, playsinline: true });
  call.audio.play().catch(() => {});
  // AudioContext 也要在点击里建 / 恢复：iOS 上点击之外起的一直是 suspended，第二通起就没声音、录不到
  audioCtx();
  mountPanel();
  try {
    const key = await ensureConversation();
    if (session !== call.session) return;
    call.key = key;
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (session !== call.session) {
      for (const track of mic.getTracks()) track.stop();
      return;
    }
    call.mic = mic;
    // iOS 上偶尔拿到的是已经结束 / 被静音的轨道（音频会话被别的占着）：别假装在听
    const track = call.mic.getAudioTracks()[0];
    if (!track || track.readyState !== "live") throw new Error("麦克风没能打开，请关掉其他在用麦克风的页面或应用后重试");
    track.enabled = !call.muted;
    if (track.muted) await waitUnmute(track, 1500);
    if (session !== call.session) return;
    const ctx = audioCtx();
    if (!ctx) throw new Error("浏览器不支持音频处理");
    await loadWorklet(ctx);
    if (session !== call.session) return;
    // 麦克风 → 采集（重采样到 24kHz，20ms 一块）→ WebSocket
    const src = ctx.createMediaStreamSource(call.mic);
    const capture = new AudioWorkletNode(ctx, "rt-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    // 没有输出接到 destination 的节点有的浏览器不跑：接一个静音的
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(capture);
    capture.connect(sink);
    sink.connect(ctx.destination);
    capture.port.onmessage = (e) => {
      const sock = WS.sock;
      // 网络卡住时别越攒越多（攒下的说出去也晚了）
      if (call.state === "live" && sock?.readyState === 1 && sock.bufferedAmount < 64 * 1024) sock.send(e.data);
    };
    // 服务器发来的 → 播放 → 扬声器
    const play = new AudioWorkletNode(ctx, "rt-play", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    call.play = play;
    call.nodes.push(src, capture, sink, play);
    call.micLevel = meter(src);
    call.outLevel = meter(play);
    if (appleAudio) {
      play.connect(ctx.destination);
    } else {
      const dest = ctx.createMediaStreamDestination();
      play.connect(dest);
      call.nodes.push(dest);
      try {
        const loop = await loopback(dest.stream);
        if (session !== call.session) return loop.close();
        call.loop = loop;
        call.audio.srcObject = call.loop.stream;
        call.audio.play().catch(() => {});
      } catch {
        // 环回建不起来：直接放（可能有回声）
        if (session !== call.session) return;
        play.connect(ctx.destination);
      }
    }
    if (session !== call.session) return;
    const prefs = loadPrefs();
    await WS.request({ t: "rt", op: "start", key, voice: prefs.voice, language: prefs.language }, 40_000);
    if (session !== call.session) return;
    call.state = "live";
    call.startedAt = Date.now();
    render();
  } catch (err) {
    if (session !== call.session) return;
    const message = err?.name === "NotAllowedError" ? "没有麦克风权限，请在浏览器里允许使用麦克风" : err?.name === "NotFoundError" ? "没找到可用的麦克风" : err?.message ?? String(err);
    endCall(`语音对话没能开始：${message}`);
  }
}

/** 挂断。fromServer：服务端已经说结束了，不用再通知它 */
export function endCall(reason, fromServer = false) {
  if (call.state === "idle") return;
  const key = call.key;
  ++call.session;
  call.state = "idle";
  if (key && !fromServer) WS.raw({ t: "rt", op: "stop", key });
  cancelAnimationFrame(call.raf);
  stopTracks();
  call.loop?.close();
  call.loop = null;
  call.play = null;
  if (call.audio) {
    call.audio.pause();
    call.audio.srcObject = null;
  }
  call.audio = null;
  // 不 close：iOS 上关掉接过麦克风的 AudioContext，之后再开麦克风常常是静音的。断开节点、先暂停，下次点击时恢复
  for (const n of call.nodes) {
    try {
      n.disconnect();
    } catch {
      // 已经断开
    }
  }
  call.nodes = [];
  if (sharedCtx?.state === "running") sharedCtx.suspend().catch(() => {});
  call.micLevel = call.outLevel = null;
  call.key = null;
  call.panel?.remove();
  call.dialog?.close();
  call.dialog?.remove();
  call.dialog = null;
  call.panel = call.els = null;
  ui.composer?.classList.remove("in-call");
  syncCall();
  (ui.callBtn && !ui.callBtn.hidden ? ui.callBtn : ui.sendBtn)?.focus({ preventScroll: true });
  if (reason) toast(reason);
}

function stopTracks() {
  for (const t of call.mic?.getTracks() ?? []) t.stop();
  call.mic = null;
}

/** 服务端转来的通话事件（ws 的 t: "rt"） */
export function onRealtimeEvent(msg) {
  if (call.state === "idle" || msg.key !== call.key) return;
  const ev = msg.ev ?? {};
  switch (ev.type) {
    case "transcript": {
      const c = call.caption;
      if (c.role !== ev.role || c.done) call.caption = { role: ev.role, text: ev.delta, done: false };
      else c.text += ev.delta;
      break;
    }
    case "transcript_done":
      call.caption = { role: ev.role, text: ev.text, done: true };
      break;
    case "started":
      break;
    case "error":
      toast(`语音对话出错：${ev.message}`, 4000);
      break;
    case "closed":
      endCall(ev.reason && ev.reason !== "requested" ? `语音对话已结束（${ev.reason}）` : "语音对话已结束", true);
      return;
  }
  renderCaption();
}

// ---------- 通话界面 ----------

function mountPanel() {
  if (!ui.composer) return;
  if (!call.panel) {
    const orb = h("div", { class: "call-orb", "aria-hidden": "true" },
      h("div", { class: "call-orb-surface" }, h("span", { class: "call-orb-cloud cloud-a" }), h("span", { class: "call-orb-cloud cloud-b" }), h("span", { class: "call-orb-cloud cloud-c" })),
    );
    const mute = h("button", { class: "call-ctl", title: "静音", "aria-label": "静音", onclick: toggleMute }, icon("mic"));
    const gear = h("button", { class: "call-ctl", title: "音色和语言", "aria-label": "音色和语言", "aria-expanded": "false", onclick: toggleOpts }, icon("gear"));
    const end = h("button", { class: "call-ctl call-end", title: "结束语音对话", "aria-label": "结束语音对话", onclick: () => endCall() }, icon("x"));
    const minimize = h("button", { class: "call-minimize icon-btn", title: "收起通话", "aria-label": "收起通话", onclick: () => setCompact(true) }, icon("down"));
    const expand = h("button", { class: "call-expand call-ctl", title: "展开通话", "aria-label": "展开通话", onclick: () => setCompact(false) }, icon("expand"));
    const status = h("span", { class: "call-status", role: "status" });
    const time = h("span", { class: "call-time" });
    const who = h("span", { class: "call-who" });
    const text = h("span", { class: "call-text" });
    const opts = optsRow();
    const hint = h("p", { class: "call-hint" }, "直接开口，随时打断");
    call.els = { orb, mute, gear, opts, status, time, who, text, hint, expand, minimize };
    call.panel = h(
      "div",
      { class: "call-panel", role: "region", "aria-label": "语音对话" },
      h("header", { class: "call-header" },
        h("div", { class: "call-brand" }, h("span", { class: "call-brand-icon", html: ICON_WAVE }), h("span", {}, "Codex", h("small", {}, "语音对话"))),
        h("div", { class: "call-session" }, h("span", { class: "call-live-dot" }), time), minimize,
      ),
      h(
        "div",
        { class: "call-main" },
        h("div", { class: "call-stage" }, orb),
        h("div", { class: "call-info" }, status, hint),
      ),
      h("div", { class: "call-caption", "aria-live": "polite", "aria-atomic": "true" }, who, text),
      opts,
      h("footer", { class: "call-footer" }, h("div", { class: "call-ctls" }, expand,
        h("div", { class: "call-control" }, mute, h("span", {}, "麦克风")),
        h("div", { class: "call-control" }, gear, h("span", {}, "音色与语言")),
        h("div", { class: "call-control" }, end, h("span", {}, "结束")),
      ), h("span", { class: "call-footer-note" }, "可以收起通话，查看聊天")),
    );
    call.dialog = h("dialog", { class: "call-dialog", "aria-label": "Codex 语音对话", oncancel: (e) => { e.preventDefault(); setCompact(true); } });
  }
  ui.composer.classList.add("in-call");
  if (call.compact) ui.composer.after(call.panel);
  else {
    if (!call.dialog.isConnected) document.body.append(call.dialog);
    call.dialog.append(call.panel);
    if (!call.dialog.open) call.dialog.showModal();
  }
  render();
  cancelAnimationFrame(call.raf);
  call.raf = requestAnimationFrame(tick);
}

/** 收起只切换视图，麦克风和播放保持连接。Esc 也收起，避免误挂断。 */
function setCompact(compact) {
  if (!call.panel || call.compact === compact) return;
  call.compact = compact;
  call.panel.classList.toggle("compact", compact);
  if (compact) call.dialog.close();
  mountPanel();
  (compact ? call.els.expand : call.els.minimize).focus({ preventScroll: true });
}

/** 通话条下面展开的一行：音色、语言。通话中改了就用新设置重新连一次（Codex 那边对话上下文还在） */
function optsRow() {
  const prefs = loadPrefs();
  const pick = (label, list, value, name) => {
    const sel = h("select", { "aria-label": label }, list.map(([v, t]) => h("option", { value: v }, t)));
    sel.value = list.some(([v]) => v === value) ? value : "";
    sel.addEventListener("change", () => {
      savePrefs({ ...loadPrefs(), [name]: sel.value });
      restartCall();
    });
    return h("label", { class: "call-opt" }, h("span", {}, label), sel);
  };
  return h(
    "div",
    { class: "call-opts", hidden: true },
    pick("音色", VOICES, prefs.voice, "voice"),
    pick("语言", LANGUAGES, prefs.language, "language"),
    h("div", { class: "call-opts-hint" }, "记在这台设备上。通话中改了会重新连接，对话内容不受影响"),
  );
}

function toggleOpts() {
  const { opts, gear } = call.els;
  opts.hidden = !opts.hidden;
  gear.classList.toggle("active", !opts.hidden);
  gear.setAttribute("aria-expanded", String(!opts.hidden));
}

/** 用新的音色 / 语言重连：挂掉当前这通，马上再开（在选择框的操作里，iOS 也允许播放） */
function restartCall() {
  if (call.state === "idle") return;
  const { compact, muted } = call;
  endCall("");
  void startCall();
  if (muted) toggleMute();
  if (compact) setCompact(true);
  // startCall 同步就把新的通话条挂上了：设置行保持展开，方便接着试别的音色
  if (call.els) toggleOpts();
}

function toggleMute() {
  call.muted = !call.muted;
  for (const t of call.mic?.getAudioTracks() ?? []) t.enabled = !call.muted;
  render();
}

function render() {
  if (!call.els) return;
  const { mute } = call.els;
  mute.innerHTML = call.muted ? ICON_MIC_OFF : icon("mic").innerHTML;
  mute.title = call.muted ? "取消静音" : "静音";
  mute.setAttribute("aria-label", mute.title);
  mute.setAttribute("aria-pressed", String(call.muted));
  mute.classList.toggle("on", call.muted);
  call.panel.classList.toggle("connecting", call.state === "connecting");
  call.panel.classList.toggle("muted", call.muted);
  renderCaption();
}

function renderCaption() {
  if (!call.els) return;
  const { who, text } = call.els;
  const c = call.caption;
  const caption = text.parentElement;
  const follow = caption.scrollHeight - caption.scrollTop - caption.clientHeight < 32;
  who.textContent = c.text ? (c.role === "user" ? "你" : "Codex") : "";
  if (text.textContent !== c.text) {
    text.textContent = c.text || "";
    if (follow) requestAnimationFrame(() => { if (caption.isConnected) caption.scrollTop = caption.scrollHeight; });
  }
  call.panel.classList.toggle("has-caption", !!c.text);
}

/** 每帧读取实际音量；光球平滑响应声音，状态和时长仅在变化时写入 DOM。 */
function tick() {
  if (!call.els) return;
  const mic = call.muted ? 0 : (call.micLevel?.() ?? 0);
  const out = call.outLevel?.() ?? 0;
  const speaking = out > 0.02;
  const level = Math.min(1, (speaking ? out : mic) * 6);
  call.els.orb.style.setProperty("--voice-scale", (1 + level * 0.14).toFixed(3));
  call.panel.classList.toggle("speaking", speaking);
  const busy = S.busy && S.current === call.key;
  call.panel.classList.toggle("processing", !!busy && !speaking);
  const status =
    call.state === "connecting" ? "正在连接…" : speaking ? "Codex 正在说" : busy ? "Codex 正在处理…" : call.muted ? "已静音" : "正在听";
  const hint = call.state === "connecting" ? "正在为你接通 Codex" : call.muted ? "麦克风已关闭，仍可听到回复" : busy && !speaking ? "完成后会接着告诉你" : "直接开口，随时打断";
  const time = call.state === "live" ? clock(Date.now() - call.startedAt) : "连接中";
  for (const [el, value] of [[call.els.status, status], [call.els.time, time], [call.els.hint, hint]]) {
    if (el.textContent !== value) el.textContent = value;
  }
  call.raf = requestAnimationFrame(tick);
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 整个页面共用一个 AudioContext（iOS 上反复新建、关闭会把麦克风搞坏），在点击里调用来建 / 恢复 */
let sharedCtx = null;
function audioCtx() {
  try {
    if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new (window.AudioContext ?? window.webkitAudioContext)();
    if (sharedCtx.state !== "running") sharedCtx.resume().catch(() => {});
  } catch {
    sharedCtx = null;
  }
  return sharedCtx;
}

/** 轨道 muted 时等它恢复一会儿；还是不行就报错 */
function waitUnmute(track, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      track.removeEventListener("unmute", ok);
      reject(new Error("麦克风被系统静音了，请检查是否有其他应用在用麦克风，或刷新页面后重试"));
    }, ms);
    const ok = () => {
      clearTimeout(timer);
      resolve();
    };
    track.addEventListener("unmute", ok, { once: true });
  });
}

/** 一个节点的音量（0~1 的均方根），给动画用 */
function meter(node) {
  try {
    const ctx = audioCtx();
    if (!ctx) return null;
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    node.connect(an);
    call.nodes.push(an);
    const buf = new Float32Array(an.fftSize);
    return () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.sqrt(sum / buf.length);
    };
  } catch {
    return null;
  }
}

/** 每个 AudioContext 加载一次 worklet */
const workletLoaded = new WeakMap();
function loadWorklet(ctx) {
  let p = workletLoaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(new URL("../lib/rt-worklet.js", import.meta.url));
    p.catch(() => workletLoaded.delete(ctx));
    workletLoaded.set(ctx, p);
  }
  return p;
}

/** 本页里一对 RTCPeerConnection 把声音环回一下，让浏览器的回声消除认得它（见 appleAudio） */
async function loopback(stream) {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const close = () => {
    a.close();
    b.close();
  };
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const got = new Promise((resolve, reject) => {
      b.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]));
      setTimeout(() => reject(new Error("环回超时")), 3000);
    });
    for (const t of stream.getTracks()) a.addTrack(t, stream);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    return { stream: await got, close };
  } catch (err) {
    close();
    throw err;
  }
}

/** 服务器转来的回复声音（WebSocket 二进制帧：24kHz 16 位 PCM） */
export function onRealtimeAudio(buf) {
  if (call.state === "idle" || !call.play) return;
  call.play.port.postMessage(buf, [buf]);
}

/** WebSocket 断了：声音走不了了，挂断 */
export function onSocketLost() {
  endCall("和服务器的连接断开了，语音对话已结束", true);
}

window.addEventListener("pagehide", () => endCall());
