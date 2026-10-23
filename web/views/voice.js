import { toast } from "../lib/dom.js";
import { ui } from "../state.js";
import { autosize, updateSendBtn } from "./composer.js";

// ---------- 语音输入（浏览器自带 Web Speech API） ----------
// Chrome / Edge 走各自厂商的在线识别服务，Safari 走系统识别；Firefox 没有这个 API，按钮直接不显示。
// 必须是安全上下文（HTTPS 或 localhost）才能拿到麦克风。

export const SpeechRec = window.SpeechRecognition ?? window.webkitSpeechRecognition;
// Android Chrome 的 continuous 模式会把已确认的结果重复回吐，改成单句识别、说完自动续上
const voiceContinuous = !/Android/i.test(navigator.userAgent);

const VOICE_ERR = {
  "not-allowed": "没有麦克风权限（需要 HTTPS，并在浏览器里允许麦克风）",
  "service-not-allowed": "浏览器不允许使用语音识别服务",
  "audio-capture": "没找到可用的麦克风",
  network: "语音识别需要联网，连不上识别服务",
  "language-not-supported": "不支持当前语言的语音识别",
};

/** rec：当前识别实例；before/after：开始时光标前后的文字；committed：已确认的识别结果 */
const voice = { rec: null, want: false, before: "", after: "", committed: "", target: null, stopTimer: null };

export function toggleVoice() {
  // 点过停止、正在等收尾（按钮已经不亮了）：再点就是要重新开始，先丢掉旧的
  if (voice.rec && !voice.want) cancelVoice();
  if (voice.rec) stopVoice();
  else startVoice();
}

function startVoice() {
  if (!SpeechRec) return toast("当前浏览器不支持语音输入");
  const ta = ui.input;
  voice.target = ta;
  voice.before = ta.value.slice(0, ta.selectionStart);
  voice.after = ta.value.slice(ta.selectionEnd);
  voice.committed = "";
  voice.want = true;
  try {
    listenOnce();
  } catch (err) {
    voice.rec = null;
    voice.want = false;
    toast(`无法启动语音识别：${err.message}`);
  }
  updateMicBtn();
}

/**
 * 正常结束的识别实例留着下次复用：iOS Safari 每次 new 一个新实例，
 * 第二次开始往往一个结果都不回。被 abort / 卡住的实例不复用，下次换新的。
 */
let spareRec = null;

/** voice.rec 是一轮识别（run）：{ rec, heard, shown, done }，事件都按 run 对号入座 */
function listenOnce() {
  const run = { rec: null, heard: "", shown: "", done: false };
  const wire = (rec) => {
    rec.lang = navigator.language || "zh-CN";
    rec.continuous = voiceContinuous;
    rec.interimResults = true;
    rec.onresult = (e) => {
      if (voice.rec !== run) return;
      let fin = "";
      let interim = "";
      for (const r of e.results) {
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      run.heard = fin;
      run.shown = fin + interim;
      showVoiceText(joinVoice(voice.committed, run.shown));
    };
    rec.onerror = (e) => {
      if (voice.rec !== run) return;
      if (e.error === "no-speech" || e.error === "aborted") return;
      voice.want = false;
      toast(VOICE_ERR[e.error] ?? `语音识别出错：${e.error}`);
    };
    rec.onend = () => {
      if (voice.rec !== run) return; // 已被取消 / 已被强制结束
      finishRun(run, true);
    };
    return rec;
  };
  let rec = wire(spareRec ?? new SpeechRec());
  spareRec = null;
  run.rec = rec;
  voice.rec = run;
  try {
    rec.start();
  } catch (err) {
    // 复用的实例还没完全停下（InvalidStateError）：换个新的再来
    if (err?.name !== "InvalidStateError") throw err;
    rec = wire(new SpeechRec());
    run.rec = rec;
    rec.start();
  }
}

/** 一轮识别结束：把这轮听到的定下来，需要的话接着听下一轮 */
function finishRun(run, clean) {
  if (run.done) return;
  run.done = true;
  clearTimeout(voice.stopTimer);
  // Safari 有时整轮都不给 isFinal：没有定稿就以屏幕上显示的为准，不能把已经显示的字吞掉
  const heard = run.heard || run.shown;
  voice.committed = joinVoice(voice.committed, heard);
  showVoiceText(voice.committed);
  if (clean) spareRec = run.rec;
  // 这一轮什么都没听到就当说完了，避免麦克风一直开着
  if (clean && voice.want && heard) {
    try {
      listenOnce();
      return;
    } catch {
      // 续不上就结束
    }
  }
  voice.rec = null;
  voice.want = false;
  updateMicBtn();
}

/** 用户点停止：让浏览器把最后一句定稿后再结束 */
function stopVoice() {
  const run = voice.rec;
  if (!run) return;
  voice.want = false;
  // 先把按钮恢复，用户能立刻看到已经停了
  if (ui.micBtn) ui.micBtn.classList.remove("recording");
  try {
    run.rec.stop();
  } catch {
    // 已经停了
  }
  // iOS 上 stop() 之后有时永远等不来 onend，按钮就一直卡在「录音中」，再点只会又 stop 一次。
  // 等一会儿还没结束就强制收尾，这个实例不再复用
  clearTimeout(voice.stopTimer);
  voice.stopTimer = setTimeout(() => {
    if (voice.rec !== run) return;
    try {
      run.rec.abort();
    } catch {
      // 忽略
    }
    finishRun(run, false);
  }, 1500);
}

/** 发送、切会话、用户手动改输入框时：立刻丢掉识别，不再往输入框写 */
export function cancelVoice() {
  const run = voice.rec;
  if (!run) return;
  clearTimeout(voice.stopTimer);
  run.done = true;
  voice.rec = null;
  voice.want = false;
  try {
    run.rec.abort();
  } catch {
    // 忽略
  }
  updateMicBtn();
}

/** 中日韩直接拼接，其它语言之间补空格 */
function joinVoice(a, b) {
  if (!a || !b) return a + b;
  if (/\s$/.test(a) || /^\s/.test(b) || /^(zh|ja|ko)/i.test(navigator.language)) return a + b;
  return `${a} ${b}`;
}

function showVoiceText(text) {
  const ta = voice.target;
  if (!ta || ta !== ui.input) return;
  ta.value = voice.before + text + voice.after;
  const caret = voice.before.length + text.length;
  ta.setSelectionRange(caret, caret);
  autosize();
  updateSendBtn();
}

function updateMicBtn() {
  if (!ui.micBtn) return;
  const on = !!voice.rec;
  ui.micBtn.classList.toggle("recording", on);
  ui.micBtn.title = on ? "停止语音输入" : "语音输入";
}
