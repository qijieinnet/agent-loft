// 设置 → 账号 → 微信：用微信扫码，把这个账号和微信 ClawBot 连起来。
// 服务端在后台等扫码（见 channels/weixin/login.ts），这里每两秒取一次状态。
import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { confirmDialog, modal } from "../lib/overlay.js";
import { relTime } from "../lib/time.js";
import { field } from "./common.js";

const STATE_TEXT = {
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "网络有问题，正在重连",
  expired: "登录已失效，请重新扫码",
  stopped: "没有运行",
};

const DELIVERY_TEXT = {
  unconfirmed: "最近一次回复微信接口受理了，但手机可能没收到（微信可能在限制这个账号）",
  failed: "最近一次回复没有发出去",
};

const NOTES = [
  "每个人连自己的微信，这条对话用你的记忆和工具，只认扫码的这个微信号。",
  "微信里只能发文字和语音转文字，授权和提问回复数字处理。网页上能看到同一条对话。",
  "微信限制较多：约 24 小时没在微信里说话后，它不允许主动发消息，定时任务的结果可能发不过去；每条消息之后能发的条数也有限。",
  "消息会经过腾讯服务器。这是腾讯的实验性功能，它可能限制或停止服务，建议先用小号试。不要反复重新扫码，可能触发风控。",
];

export function weixinLinkSection() {
  const box = h("div", { class: "section" });
  const load = async () => {
    let data;
    try {
      data = await api("/api/account/weixin");
    } catch (err) {
      fill(box, h("h4", {}, "微信"), h("div", { class: "error-text" }, err.message));
      return;
    }
    const scan = h("button", { class: data.linked ? "btn" : "btn accent", onclick: () => startLogin(load) }, data.linked ? "重新扫码" : "扫码连接微信");
    const rows = [];
    if (data.linked) {
      const rm = h("button", { class: "btn small danger" }, "断开");
      rm.onclick = async () => {
        const sure = await confirmDialog({
          title: "断开微信？",
          message: "断开后这里不再收发微信消息。微信里的 ClawBot 入口要在手机上自己移除。",
          confirmText: "断开",
          danger: true,
        });
        if (!sure) return;
        rm.disabled = true;
        try {
          await api("/api/account/weixin", { method: "DELETE" });
          toast("已断开");
          void load();
        } catch (err) {
          toast(err.message);
          rm.disabled = false;
        }
      };
      const state = STATE_TEXT[data.status.state] ?? data.status.state;
      const facts = [
        data.wechatShort,
        `绑定于 ${relTime(data.boundAt)}`,
        data.lastInboundAt ? `上次收到消息 ${relTime(data.lastInboundAt)}` : "还没收到过消息，先在微信里发一条",
      ].join(" · ");
      rows.push(h("div", { class: "list-item" }, h("div", { class: "grow" }, h("div", { class: "t" }, state), h("div", { class: "s" }, facts)), rm));
      if (DELIVERY_TEXT[data.status.delivery]) rows.push(h("div", { class: "error-text" }, DELIVERY_TEXT[data.status.delivery]));
      const choices = data.experts;
      const currentAvailable = choices.some((e) => e.id === data.expert);
      const expert = h("select", { disabled: !choices.length, "aria-label": "微信专家", style: { flex: "1", minWidth: "0" } },
        !currentAvailable ? h("option", { value: "", selected: true, disabled: true }, choices.length ? "当前专家已不可用，请重新选择" : "没有可用的专家") : null,
        choices.map((e) => h("option", { value: e.id, selected: e.id === data.expert }, e.label)));
      const change = h("button", { class: "btn", disabled: true }, "切换专家");
      expert.onchange = () => { change.disabled = !expert.value || expert.value === data.expert; };
      change.onclick = async () => {
        change.disabled = true;
        expert.disabled = true;
        try {
          const result = await api("/api/account/weixin", { method: "PATCH", body: { expert: expert.value } });
          toast(result.message);
          await load();
        } catch (err) {
          toast(err.message);
          expert.disabled = !choices.length;
          change.disabled = !expert.value || expert.value === data.expert;
        }
      };
      rows.push(field("微信使用的专家", h("div", { class: "row weixin-expert-row" }, expert, change), "切换会结束当前会话并开启新会话，之后的微信消息使用所选专家。也可以在微信里发 /expert 切换。"));
    }
    fill(
      box,
      h("h4", {}, "微信", h("span", { class: "grow" }), scan),
      h("div", { class: "muted" }, "连接后可以在微信的 ClawBot 里和 agent 聊天。"),
      h("ul", { class: "muted" }, NOTES.map((n) => h("li", {}, n))),
      rows,
    );
  };
  void load();
  return box;
}

async function startLogin(onDone) {
  let login;
  try {
    login = await api("/api/account/weixin/login", { method: "POST" });
  } catch (err) {
    toast(err.message);
    return;
  }
  const qr = h("div", { class: "qr", html: login.qrSvg });
  const state = h("div", { class: "muted", style: { textAlign: "center" } });
  const verify = h("div", { hidden: true });
  const hint = h(
    "div",
    { class: "muted" },
    "用手机微信扫码，并在手机上确认。需要微信 8.0.70 以上，「设置 → 插件」里有 ClawBot 才能连。如果手机提示「运行环境存在风险」，是微信拒绝了这次连接，这边不会有提示，可以关掉这个窗口，过一段时间再试。",
  );
  const body = h("div", { class: "modal-body" }, hint, qr, state, verify);
  let finished = false;
  const close = modal({
    title: "扫码连接微信",
    body,
    beforeClose: () => {
      if (!finished) void api(`/api/account/weixin/login/${login.id}`, { method: "DELETE" }).catch(() => {});
      finished = true;
    },
  });
  let shownSvg = login.qrSvg;
  let verifyShown = false;
  const showVerify = (wrong) => {
    state.textContent = wrong ? "数字不对，请重新输入。" : "请输入手机微信上显示的数字。";
    if (verifyShown) return;
    verifyShown = true;
    const input = h("input", { inputmode: "numeric", autocomplete: "one-time-code", placeholder: "手机上显示的数字" });
    const go = h("button", { class: "btn primary" }, "确定");
    go.onclick = async () => {
      go.disabled = true;
      try {
        await api(`/api/account/weixin/login/${login.id}/verify`, { method: "POST", body: { code: input.value } });
        verify.hidden = true;
        verifyShown = false;
        state.textContent = "正在验证…";
      } catch (err) {
        toast(err.message);
      }
      go.disabled = false;
    };
    fill(verify, field("手机上显示的数字", input), h("div", { class: "row", style: { justifyContent: "center", marginTop: "12px" } }, go));
    verify.hidden = false;
    input.focus();
  };
  const poll = async () => {
    if (finished) return;
    let r;
    try {
      r = await api(`/api/account/weixin/login/${login.id}`);
    } catch (err) {
      state.textContent = err.message;
      finished = true;
      return;
    }
    if (r.qrSvg !== shownSvg) {
      shownSvg = r.qrSvg;
      qr.innerHTML = r.qrSvg;
      verify.hidden = true;
      verifyShown = false;
    }
    if (r.state === "confirmed" || r.state === "already") {
      finished = true;
      toast(r.state === "already" ? "这个微信已经连接" : "✅ 已连接。先在微信的 ClawBot 里发一条消息");
      close();
      onDone();
      return;
    }
    if (r.state === "failed") {
      finished = true;
      state.textContent = r.message ?? "连接失败";
      return;
    }
    if (r.state === "need_verifycode") showVerify(false);
    else if (r.state === "verify_wrong") showVerify(true);
    else if (!verifyShown) state.textContent = r.message ?? (r.state === "scaned" ? "已扫码，请在手机上确认…" : "等待扫码…");
    setTimeout(poll, 2000);
  };
  state.textContent = "等待扫码…";
  setTimeout(poll, 2000);
}
