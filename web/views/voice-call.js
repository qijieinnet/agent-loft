import { h, icon, toast } from "../lib/dom.js";
import { desktop, S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { ensureConversation } from "./composer.js";
import { currentAgentId } from "./slash.js";
import { cancelVoice } from "./voice.js";

// ---------- 实时语音对话（只有 Codex） ----------
// 浏览器建 RTCPeerConnection（麦克风 + oai-events 数据通道），offer 交给服务端，服务端让 Codex app-server 去 OpenAI 建通话，
// answer 拿回来连上。声音在浏览器和 OpenAI 之间直连，不经过 agent-loft。
// 语音模型把要干的活转交给这条对话里的 Codex：那一轮像打字发的消息一样出现在对话里（用户消息前面带 🎙️）。
// 通话时输入框换成通话条：音量动画、状态、字幕、静音、挂断（和 Codex 桌面端的语音模式一样）。

/** 桌面端（Electron）没申请麦克风权限：macOS 上直接用会被系统拦掉，先不放 */
const supported = !desktop && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia;

const call = {
  /** idle / connecting / live */
  state: "idle",
  key: null,
  pc: null,
  mic: null,
  audio: null,
  muted: false,
  startedAt: 0,
  raf: 0,
  ctx: null,
  micLevel: null,
  outLevel: null,
  /** 字幕：谁在说、说了什么（一句说完 done 之后，下一句同一个人开口就换新的） */
  caption: { role: null, text: "", done: false },
  panel: null,
  els: null,
  /** 连接短暂断开（disconnected）时等一会儿再判定挂了 */
  dropTimer: 0,
};

const ICON_WAVE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>';
const ICON_MIC_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6"/><path d="M5 10a7 7 0 0 0 11.7 5.2M19 10a7 7 0 0 1-.6 2.8M12 17v5"/></svg>';

/** 输入框里的「语音对话」按钮 */
export function callButton() {
  ui.callBtn = h("button", { class: "icon-btn call-btn", title: "语音对话", "aria-label": "语音对话", html: ICON_WAVE, onclick: () => void startCall() });
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
    } else if (call.panel && !call.panel.isConnected) {
      mountPanel();
    }
  }
  if (ui.callBtn) ui.callBtn.hidden = !supported || currentAgentId() !== "codex";
}

async function startCall() {
  if (call.state !== "idle") return;
  if (!window.isSecureContext) {
    toast("语音对话要用麦克风，需要 HTTPS 访问（或者本机 localhost）");
    return;
  }
  cancelVoice();
  call.state = "connecting";
  call.muted = false;
  call.caption = { role: null, text: "", done: false };
  // 在点击里建好、先 play 一次：iOS 上不是用户手势里起的播放会被拦
  call.audio = h("audio", { autoplay: true, playsinline: true });
  call.audio.play().catch(() => {});
  mountPanel();
  try {
    const key = await ensureConversation();
    if (call.state === "idle") return;
    call.key = key;
    call.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (call.state === "idle") return stopTracks();
    const pc = new RTCPeerConnection();
    call.pc = pc;
    for (const track of call.mic.getTracks()) pc.addTrack(track, call.mic);
    // OpenAI 要求 offer 里有这个数据通道（事件走这里；字幕我们用服务端转来的）
    pc.createDataChannel("oai-events");
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      call.audio.srcObject = stream;
      call.audio.play().catch(() => {});
      call.outLevel = meter(stream);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      clearTimeout(call.dropTimer);
      if (st === "failed" || st === "closed") endCall("语音连接断开了");
      // 网络抖一下会短暂 disconnected，几秒内没恢复才算断
      else if (st === "disconnected") call.dropTimer = setTimeout(() => endCall("语音连接断开了"), 5000);
    };
    call.micLevel = meter(call.mic);
    await pc.setLocalDescription(await pc.createOffer());
    await iceGathered(pc, 1500);
    if (call.state === "idle") return;
    const res = await WS.request({ t: "rt", op: "start", key, sdp: pc.localDescription.sdp }, 30_000);
    if (call.state === "idle") return;
    await pc.setRemoteDescription({ type: "answer", sdp: res.sdp });
    call.state = "live";
    call.startedAt = Date.now();
    render();
  } catch (err) {
    const message = err?.name === "NotAllowedError" ? "没有麦克风权限，请在浏览器里允许使用麦克风" : err?.name === "NotFoundError" ? "没找到可用的麦克风" : err?.message ?? String(err);
    endCall(`语音对话没能开始：${message}`);
  }
}

/** 挂断。fromServer：服务端已经说结束了，不用再通知它 */
export function endCall(reason, fromServer = false) {
  if (call.state === "idle") return;
  const key = call.key;
  call.state = "idle";
  if (key && !fromServer) WS.raw({ t: "rt", op: "stop", key });
  clearTimeout(call.dropTimer);
  cancelAnimationFrame(call.raf);
  call.pc?.close();
  call.pc = null;
  stopTracks();
  if (call.audio) call.audio.srcObject = null;
  call.audio = null;
  call.ctx?.close().catch(() => {});
  call.ctx = null;
  call.micLevel = call.outLevel = null;
  call.key = null;
  call.panel?.remove();
  call.panel = call.els = null;
  ui.composer?.classList.remove("in-call");
  syncCall();
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

// ---------- 通话条 ----------

function mountPanel() {
  if (!ui.composer) return;
  if (!call.panel) {
    const bars = [0, 1, 2, 3, 4].map(() => h("span", { class: "call-bar" }));
    const mute = h("button", { class: "call-ctl", title: "静音", "aria-label": "静音", onclick: toggleMute }, icon("mic"));
    const end = h("button", { class: "call-ctl call-end", title: "结束语音对话", "aria-label": "结束语音对话", onclick: () => endCall() }, "结束");
    const status = h("span", { class: "call-status" });
    const time = h("span", { class: "call-time" });
    const who = h("span", { class: "call-who" });
    const text = h("span", { class: "call-text" });
    call.els = { bars, mute, status, time, who, text };
    call.panel = h(
      "div",
      { class: "call-panel", role: "region", "aria-label": "语音对话" },
      h(
        "div",
        { class: "call-main" },
        h("div", { class: "call-wave", "aria-hidden": "true" }, bars),
        h("div", { class: "call-info" }, h("div", { class: "call-line" }, status, time), h("div", { class: "call-caption", "aria-live": "polite" }, who, text)),
        h("div", { class: "call-ctls" }, mute, end),
      ),
    );
  }
  ui.composer.classList.add("in-call");
  ui.composer.after(call.panel);
  render();
  cancelAnimationFrame(call.raf);
  call.raf = requestAnimationFrame(tick);
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
  mute.classList.toggle("on", call.muted);
  call.panel.classList.toggle("connecting", call.state === "connecting");
  renderCaption();
}

function renderCaption() {
  if (!call.els) return;
  const { who, text } = call.els;
  const c = call.caption;
  who.textContent = c.text ? (c.role === "user" ? "你" : "Codex") : "";
  text.textContent = c.text || (call.state === "connecting" ? "" : "说点什么吧，可以随时打断它");
  call.panel.classList.toggle("has-caption", !!c.text);
}

/** 每帧：音量条、状态、时长 */
function tick() {
  if (!call.els) return;
  const mic = call.muted ? 0 : (call.micLevel?.() ?? 0);
  const out = call.outLevel?.() ?? 0;
  const speaking = out > 0.02;
  const level = Math.min(1, (speaking ? out : mic) * 6);
  call.els.bars.forEach((bar, i) => {
    const shape = [0.45, 0.75, 1, 0.75, 0.45][i];
    const wobble = call.state === "live" ? 0.15 + 0.85 * level * shape * (0.8 + 0.2 * Math.sin(Date.now() / 120 + i)) : 0.2;
    bar.style.transform = `scaleY(${Math.max(0.15, wobble).toFixed(3)})`;
  });
  call.panel.classList.toggle("speaking", speaking);
  const busy = S.busy && S.current === call.key;
  call.els.status.textContent =
    call.state === "connecting" ? "正在连接…" : speaking ? "Codex 正在说" : busy ? "Codex 正在处理…" : call.muted ? "已静音" : "正在听";
  call.els.time.textContent = call.state === "live" ? clock(Date.now() - call.startedAt) : "";
  call.raf = requestAnimationFrame(tick);
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 一路声音的音量（0~1 的均方根），给动画用 */
function meter(stream) {
  try {
    call.ctx ??= new AudioContext();
    void call.ctx.resume();
    const src = call.ctx.createMediaStreamSource(stream);
    const an = call.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
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

/** 等 ICE 候选收集完（最多 ms 毫秒）：offer 里带上候选，不用另外传 */
function iceGathered(pc, ms) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, ms);
  });
}

window.addEventListener("pagehide", () => endCall());
