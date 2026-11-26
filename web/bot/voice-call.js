import { button, byId, h } from "./client.js";
import { closePanel, panel } from "./panel.js";
import { appleAudio, loopback } from "../lib/voice-loopback.js";

let active;
export function stopBotCall() { active?.(); }

// Microphone and speaker share the workbench's 24 kHz PCM worklets and echo-cancelled playback.
export async function startBotCall(thread, botName, shared, report) {
  stopBotCall();
  const state = h("p", { role: "status" }, "正在打开麦克风…");
  const caption = h("p", { class: "call-caption" });
  const mute = button("静音", () => {
    const track = mic?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    mute.setAttribute("aria-pressed", String(!track.enabled));
  });
  mute.disabled = true;
  mute.setAttribute("aria-pressed", "false");
  const live = panel("与" + botName + "实时通话", state, caption,
    h("p", { class: "help" }, shared ? "通话文字保存在本话题，共享成员可见。" : "通话文字保存在这段私聊中。"),
    mute, button("挂断", () => finish("通话已结束。"), "primary"));
  const dialog = byId("panel");
  let mic, ctx, socket, audio, loop, capture, play, timer;
  let ended = false, ready = false, lastRole, completed = true;
  const stop = () => finish();
  function onClose() { if (!live()) stop(); }
  function finish(reason) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    dialog.removeEventListener("close", onClose);
    window.removeEventListener("pagehide", stop);
    if (active === stop) active = undefined;
    mic?.getTracks().forEach(track => track.stop());
    if (capture) capture.port.onmessage = null;
    capture?.disconnect();
    play?.disconnect();
    loop?.close();
    if (audio) { audio.pause(); audio.srcObject = null; }
    void ctx?.close().catch(() => {});
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    if (live()) closePanel();
    if (reason) report(reason);
  }
  active = stop;
  dialog.addEventListener("close", onClose);
  window.addEventListener("pagehide", stop);
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)
      throw new Error("实时通话需要支持麦克风的浏览器。请用 HTTPS 或 localhost 打开 Bot。");
    // Start playback on the user's gesture, before waiting on the permission prompt (iOS).
    ctx = new AudioContext();
    const resumed = ctx.resume();
    void resumed.catch(() => {});
    audio = h("audio", { autoplay: true, playsinline: true });
    void audio.play().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (ended) { stream.getTracks().forEach(track => track.stop()); return; }
    mic = stream;
    const track = mic.getAudioTracks()[0];
    if (!track || track.readyState !== "live") throw new Error("没有可用的麦克风。");
    track.onended = () => finish("麦克风已断开，通话已结束。");
    await Promise.all([resumed, ctx.audioWorklet.addModule("/lib/rt-worklet.js")]);
    if (ended) return;
    capture = new AudioWorkletNode(ctx, "rt-capture", { outputChannelCount: [1] });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    ctx.createMediaStreamSource(mic).connect(capture).connect(sink).connect(ctx.destination);
    capture.port.onmessage = e => {
      if (ready && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 65536) socket.send(e.data);
    };
    play = new AudioWorkletNode(ctx, "rt-play", { numberOfInputs: 0, outputChannelCount: [1] });
    if (appleAudio) play.connect(ctx.destination);
    else {
      const dest = ctx.createMediaStreamDestination();
      play.connect(dest);
      try {
        const output = await loopback(dest.stream);
        if (ended) { output.close(); return; }
        loop = output;
        audio.srcObject = loop.stream;
        await audio.play();
      } catch {
        if (ended) return;
        play.connect(ctx.destination);
      }
    }
    if (ended) return;
    state.textContent = "正在连接 Codex…";
    const url = new URL("/ws/bot-voice/" + encodeURIComponent(thread), location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    timer = setTimeout(() => finish("连接超时，请检查网络后重试。"), 40000);
    socket.onmessage = e => {
      if (ended) return;
      if (e.data instanceof ArrayBuffer) { play.port.postMessage(e.data, [e.data]); return; }
      const event = JSON.parse(e.data);
      if (event.type === "ended") finish(event.reason);
      else if (event.type === "ready") {
        clearTimeout(timer);
        ready = true;
        mute.disabled = false;
        state.textContent = "已接通，可以说话了。";
      } else if (event.type === "caption") {
        if (!event.final && event.role === "user" && (completed || lastRole !== "user")) play.port.postMessage("flush");
        const prefix = event.role === "user" ? "你：" : botName + "：";
        if (completed || lastRole !== event.role || event.final) caption.textContent = prefix;
        caption.append(event.text);
        lastRole = event.role;
        completed = event.final;
      }
    };
    socket.onerror = () => finish("无法连接通话服务，请检查登录状态和代理的 WebSocket 配置。");
    socket.onclose = () => finish("和通话服务的连接已断开。");
  } catch (err) {
    finish(err.name === "NotAllowedError" ? "浏览器未获得麦克风权限。" : err.message || "无法开始通话。");
  }
}
