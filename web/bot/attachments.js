import { button, h } from "./client.js";
import { closePanel, panel, panelError } from "./panel.js";

export function fileLinks(files, base) {
  return (files || []).map(file => {
    const url = base + "/files/" + file.slot;
    return h("div", { class: "bot-file" },
      h("a", { href: url, download: file.name }, file.name),
      file.mediaType.startsWith("audio/") && h("audio", { controls: true, preload: "none", loading: "lazy", src: url, "aria-label": file.name }),
      file.transcript && h("details", {}, h("summary", {}, "转写文字"), h("p", {}, file.transcript)));
  });
}

let cancelVoice;
export function stopVoiceInput() {
  cancelVoice?.();
}
export function voiceInput({ appendFile, appendText, chooseAudio }) {
  stopVoiceInput();
  const dialog = document.getElementById("panel");
  let stream, recorder, recognition, timer, cancelled = false, keep = false;
  const hint = h("p", { role: "status" }, "可录成语音消息，或把说的话转成可编辑的文字。");
  const record = button("开始录音", async () => {
    if (recorder?.state === "recording") { keep = true; recorder.stop(); record.disabled = true; return; }
    record.disabled = dictate.disabled = true;
    keep = false;
    try {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器无法录音。请通过 HTTPS 打开，或选择已有录音。");
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelled || !live()) { release(); return; }
      recorder = new MediaRecorder(stream);
      const chunks = [];
      let size = 0;
      recorder.ondataavailable = e => {
        if (!e.data.size || cancelled) return;
        chunks.push(e.data);
        size += e.data.size;
        if (size > 8 * 1024 * 1024 && recorder.state === "recording") { keep = false; recorder.stop(); }
      };
      recorder.onstop = async () => {
        const ok = keep && !cancelled && live();
        const mime = recorder.mimeType || chunks[0]?.type || "audio/webm";
        release();
        if (!ok || !size || size > 8 * 1024 * 1024) {
          if (!cancelled && live()) panelError("录音未保存，请重新录制不超过 8 MB 的声音。");
          return;
        }
        closePanel();
        const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
        await appendFile(new File(chunks, "语音消息." + ext, { type: mime }));
      };
      recorder.onerror = () => { release(); if (!cancelled && live()) panelError("录音中断，请重试。"); };
      recorder.start(500);
      timer = setTimeout(() => { if (recorder.state === "recording") { keep = true; recorder.stop(); } }, 180000);
      record.textContent = "完成录音";
      dictate.disabled = true;
      hint.textContent = "正在录音，最多 3 分钟。完成后可随消息发送。";
    } catch (err) { release(); if (!cancelled && live()) panelError(err.name === "NotAllowedError" ? "麦克风权限未开启。" : err.message); }
    finally { record.disabled = false; }
  });
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dictate = button("语音输入文字", () => {
    if (!Speech) { panelError("此浏览器未提供语音识别，可使用系统键盘听写。"); return; }
    try {
      recognition = new Speech();
      recognition.lang = document.documentElement.lang || "zh-CN";
      recognition.onresult = e => {
        const text = Array.from(e.results, row => row[0].transcript).join("").trim();
        if (!cancelled && live() && text) { appendText(text); closePanel(); }
      };
      recognition.onend = () => { if (!cancelled && live()) { dictate.disabled = record.disabled = false; hint.textContent = "识别已结束。"; } };
      recognition.onerror = () => { if (!cancelled && live()) panelError("语音识别未完成，可重试或改用键盘听写。"); };
      recognition.start();
      dictate.disabled = record.disabled = true;
      hint.textContent = "请说话，识别完成后可编辑文字再发送。";
    } catch (err) { panelError(err.message); }
  });
  const live = panel("语音消息", hint, record, dictate, button("选择已有录音", () => { clean(); closePanel(); chooseAudio(); }));
  function release() {
    clearTimeout(timer);
    if (recorder) {
      recorder.onstop = recorder.onerror = recorder.ondataavailable = null;
      if (recorder.state === "recording") recorder.stop();
      recorder = undefined;
    }
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    record.textContent = "开始录音";
    dictate.disabled = record.disabled = false;
  }
  function onClose() { if (!live()) clean(); }
  function clean() {
    cancelled = true;
    release();
    recognition?.abort();
    dialog.removeEventListener("close", onClose);
    window.removeEventListener("pagehide", clean);
    if (cancelVoice === clean) cancelVoice = undefined;
  }
  cancelVoice = clean;
  dialog.addEventListener("close", onClose);
  window.addEventListener("pagehide", clean);
}
