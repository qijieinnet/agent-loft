import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";

const path = "/api/account/memory/sync";

export async function showMemorySync(body, inviteCode = "") {
  const button = (label, task) => {
    const el = h("button", { class: "btn small" }, label);
    el.onclick = async () => {
      el.disabled = true;
      try {
        await task();
      } catch (err) {
        toast(err.message);
      } finally {
        el.disabled = false;
      }
    };
    return el;
  };
  const post = (action, data = {}) => api(path + "/" + action, { method: "POST", body: data });
  try {
    const state = await api(path);
    const parts = [];
    if (state.mode !== "off") {
      parts.push(
        h("div", {}, state.url ? `中转地址 ${state.url}` : "本实例作为中转"),
        h(
          "div",
          { class: "muted" },
          `最近同步 ${state.lastSync ? relTime(state.lastSync) : "尚未完成"} · 待发送 ${state.pending} · 冲突 ${state.conflicts.length}`,
        ),
        state.error ? h("div", { class: "error-text" }, state.error) : null,
        button("立即同步", async () => {
          try {
            await post("now");
          } finally {
            await showMemorySync(body);
          }
        }),
      );
    }
    if (state.mode !== "client") {
      const code = h("input", { readOnly: true, hidden: !inviteCode, value: inviteCode, "aria-label": "一次性配对码" });
      parts.push(
        h(
          "div",
          { class: "row" },
          button("生成配对码", async () => {
            const invite = await post("invite");
            await showMemorySync(body, invite.code);
          }),
          code,
        ),
        h(
          "div",
          { class: "muted" },
          "在另一台自己的实例上输入中转地址和配对码，10 分钟内有效。配对后双方将交换该账号已有和新增的记忆、摘要及问答正文。",
        ),
      );
    }
    if (state.mode === "off" || (state.mode === "client" && state.error)) {
      const url = h("input", { type: "url", placeholder: "https://…", value: state.url ?? "", "aria-label": "中转地址" });
      const code = h("input", { placeholder: "一次性配对码", autocomplete: "off", "aria-label": "中转实例配对码" });
      parts.push(
        h(
          "div",
          { class: "row" },
          url,
          code,
          button("连接中转", async () => {
            await post("join", { url: url.value, code: code.value });
            await showMemorySync(body);
          }),
        ),
      );
    }
    for (const peer of state.peers) {
      parts.push(
        h(
          "div",
          { class: "row" },
          h("span", {}, `实例 ${peer.device.slice(0, 8)} · ${peer.last_sync ? relTime(peer.last_sync) : "等待首次同步"}`),
          button("撤销凭据", async () => {
            await post("revoke", { device: peer.device });
            await showMemorySync(body);
          }),
        ),
      );
    }
    for (const conflict of state.conflicts) {
      const draft = h("textarea", { "aria-label": "合并后的正文" });
      draft.value = conflict.text;
      parts.push(
        h("h4", {}, conflict.kind === "about" ? "「关于我」有并发修改" : "记忆有并发修改"),
        ...conflict.choices.map((choice) =>
          h(
            "div",
            { class: "row" },
            h("span", {}, choice),
            button("选用", () => {
              draft.value = choice;
            }),
          ),
        ),
        h("div", { "data-form": "" }, draft),
        button("保存合并结果", async () => {
          await post("resolve", { gid: conflict.gid, choices: conflict.choices, text: draft.value });
          await showMemorySync(body);
        }),
      );
    }
    fill(body, ...parts);
    if (inviteCode) body.querySelector('input[aria-label="一次性配对码"]')?.select();
  } catch (err) {
    fill(body, h("div", { class: "error-text" }, err.message));
  }
}
