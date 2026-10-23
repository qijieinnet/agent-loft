import { fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S, ui } from "../state.js";
import { quotaState } from "./quota.js";
import { modal } from "../lib/overlay.js";
import { autosize, ensureConversation, updateSendBtn } from "./composer.js";
import { currentAgentId, oneLine } from "./slash.js";

// ---------- 定时发送 ----------
// 额度用完、要等刷新才能接着干活时：先把下一条排好，到点由服务端发出（页面关了也会发）。只支持文字。

function fmtWhen(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === 2) return `后天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** <input type="datetime-local"> 要的本地时间格式 */
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 输入框上方：这条对话排着的定时消息，可以取消 */
export function renderScheduled() {
  if (!ui.schedBar) return;
  const list = (S.current && S.convs.get(S.current)?.scheduled) || [];
  ui.schedBar.hidden = list.length === 0;
  fill(ui.schedBar,
    list.map((m) =>
      h(
        "div",
        { class: "sched-item", title: m.text },
        icon("clock"),
        h("span", { class: "sched-when" }, fmtWhen(m.at)),
        h("span", { class: "sched-text" }, oneLine(m.text, 200)),
        h("button", { class: "sched-act", title: "改时间或内容", onclick: () => openSchedule(m) }, "编辑"),
        h("button", { class: "sched-act", title: "取消这条定时消息", onclick: () => cancelScheduled(m.id) }, "取消"),
      ),
    ),
  );
}

async function cancelScheduled(id, quiet) {
  const key = S.current;
  if (!key) return false;
  try {
    const info = await api(`/api/conversations/${encodeURIComponent(key)}/scheduled?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    S.convs.set(info.key, info);
    renderScheduled();
    return true;
  } catch (err) {
    if (!quiet) toast(err.message);
    return false;
  }
}

/** 选时间的弹窗。edit：改已经排着的那条（先删旧的再排新的） */
export function openSchedule(edit) {
  if (!edit && S.uploads.length) return toast("定时发送暂不支持附件，先移除附件");
  const text = h("textarea", { class: "sched-input", rows: 4, placeholder: "到点要发的内容" });
  text.value = edit ? edit.text : ui.input.value;
  const when = h("input", { type: "datetime-local", class: "sched-time" });
  // 当前 agent 的额度窗口（5 小时 / 7 天）什么时候重置：小字提示，默认排在 5 小时窗口重置后 5 分钟
  const agent = currentAgentId();
  const windows = (quotaState.data ?? []).find((q) => q.agent === agent)?.windows ?? [];
  const resets = windows.filter((w) => /^(5h|7d)$/.test(w.short) && w.resetsAt > Date.now());
  const session = resets.find((w) => w.short === "5h");
  when.value = toLocalInput(edit ? edit.at : session ? session.resetsAt + 5 * 60_000 : Date.now() + 5 * 3600_000);
  const body = h(
    "div",
    { class: "modal-body sched-body" },
    text,
    h("label", { class: "sched-row" }, h("span", {}, "发送时间"), when),
    h(
      "div",
      { class: "muted sched-hint" },
      resets.length
        ? `额度重置：${resets.map((w) => `${w.short === "5h" ? "5 小时" : "7 天"}额度 ${fmtWhen(w.resetsAt)}`).join("，")}。`
        : "",
      "到点由服务端发出，关掉页面也会发。",
    ),
  );
  const go = h("button", { class: "btn primary" }, edit ? "保存" : "定时发送");
  const close = modal({ title: edit ? "编辑定时消息" : "定时发送", body, foot: h("div", { class: "modal-foot" }, go) });
  text.focus();
  go.onclick = async () => {
    const at = new Date(when.value).getTime();
    if (!text.value.trim()) return toast("内容不能为空");
    if (!Number.isFinite(at)) return toast("选一下发送时间");
    if (at <= Date.now()) return toast("发送时间要在现在之后");
    go.disabled = true;
    try {
      const key = await ensureConversation();
      // 先排新的再删旧的：中途失败也不会把原来那条弄丢
      const info = await api(`/api/conversations/${encodeURIComponent(key)}/scheduled`, { method: "POST", body: { text: text.value, at } });
      S.convs.set(info.key, info);
      if (edit) await cancelScheduled(edit.id, true);
      renderScheduled();
      // 用的是输入框里的草稿：排好了就清掉
      if (!edit && text.value === ui.input.value) {
        ui.input.value = "";
        autosize();
        updateSendBtn();
      }
      close();
      toast(`已排好，${fmtWhen(at)} 发送`);
    } catch (err) {
      go.disabled = false;
      toast(err.message);
    }
  };
}
