// 添加 / 编辑服务器的弹窗：图标（emoji）、地址、名称、登录网关。
// 普通脚本，和 shell.js 共用全局的 h / call / state。

/** 常用的服务器图标，也可以自己输入任意 emoji */
const SERVER_EMOJIS = ["💻", "🖥️", "🏠", "🏢", "☁️", "🗄️", "🧪", "🚀", "🐳", "🐧", "🍎", "🤖", "🧠", "🛠️", "📦", "🔒", "🌐", "⚡", "🔥", "🌊", "🌲", "🌙", "⭐", "🎯"];

/** 取第一个「字」：组合 emoji（👨‍💻、🏳️‍🌈）由好几个码点组成，按字形切才不会切坏 */
function firstGrapheme(text) {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of seg.segment(String(text).trim())) return segment;
  return "";
}

let dialogClose = null;

/** 打开弹窗：s 为空是添加，否则编辑 s */
async function openServerDialog(s) {
  dialogClose?.();
  // 弹窗画在桌面端自己的页面里：下面要是挂着服务器页面会把它挡住，先切到管理面板
  if (!state.managing) await call("manage");

  let icon = s?.icon ?? (s ? "" : "🖥️");
  const preview = h("div", { class: "icon-preview" });
  const custom = h("input", { class: "icon-custom", placeholder: "或输入任意 emoji", maxlength: 16, spellcheck: "false" });
  const grid = h("div", { class: "emoji-grid" });
  const renderIcon = () => {
    fill(preview, icon ? h("span", {}, icon) : h("span", { class: "muted" }, "无"));
    for (const b of grid.children) b.classList.toggle("on", b.dataset.emoji === icon);
  };
  for (const e of SERVER_EMOJIS) {
    grid.append(
      h(
        "button",
        {
          type: "button",
          class: "emoji-btn",
          "data-emoji": e,
          onclick: () => {
            icon = e;
            custom.value = "";
            renderIcon();
          },
        },
        e,
      ),
    );
  }
  custom.addEventListener("input", () => {
    const g = firstGrapheme(custom.value);
    if (g) icon = g;
    renderIcon();
  });

  const url = h("input", { id: "d-url", value: s?.url ?? "", placeholder: "http://192.168.1.5:8800 或 https://loft.example.com", spellcheck: "false" });
  const name = h("input", { id: "d-name", value: s?.name ?? "", placeholder: "例如：家里 Mac mini", maxlength: 40 });
  // 登录网关：服务器前面挡着 Cloudflare Access 之类的验证时才需要
  const domains = h("input", { id: "d-domains", value: (s?.authDomains ?? []).join(", "), placeholder: "例如：sso.example.com", spellcheck: "false" });
  const tokenId = h("input", { id: "d-token-id", value: s?.serviceTokenId ?? "", placeholder: "xxxxxxxx.access", spellcheck: "false", autocomplete: "off" });
  const tokenSecret = h("input", {
    id: "d-token-secret",
    type: "password",
    autocomplete: "new-password",
    spellcheck: "false",
    placeholder: s?.serviceTokenId ? "已保存，留空则不改" : "",
  });
  const advanced = h(
    "details",
    { class: "advanced", open: !!(s?.serviceTokenId || s?.authDomains?.length) },
    h("summary", {}, "登录网关（Cloudflare Access 等）"),
    h("p", { class: "hint" }, "服务器前面有 Cloudflare Access 时，打开服务器会先显示它的验证页，直接在窗口里完成就行，不用在这里填。验证过期时会弹通知提醒。"),
    h(
      "div",
      { class: "field" },
      h("label", { for: "d-domains" }, "额外的登录域名（可选）"),
      domains,
      h("div", { class: "hint" }, "不是 Cloudflare、或者 Cloudflare 后面接了自己的 SSO 时，填登录页的域名，多个用逗号隔开。"),
    ),
    h("div", { class: "field" }, h("label", { for: "d-token-id" }, "Service Token · Client ID（可选）"), tokenId),
    h("div", { class: "field" }, h("label", { for: "d-token-secret" }, "Service Token · Client Secret"), tokenSecret),
    h("div", { class: "hint" }, "配了 Service Token 就不用邮箱验证，也不会过期（Access 策略里要加一条 Service Auth 规则）。Secret 用 macOS 钥匙串加密保存；清空 Client ID 再保存即删除。"),
  );
  const error = h("div", { class: "error-text" });
  const submit = h("button", { class: "btn primary", type: "submit" }, s ? "保存" : "添加");

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    dialogClose = null;
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const form = h(
    "form",
    {
      class: "dialog",
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
          const auth = { authDomains: domains.value, serviceToken: { clientId: tokenId.value, secret: tokenSecret.value } };
          if (s) await call("updateServer", s.id, { name: name.value, url: url.value, icon }, auth);
          else await call("addServer", name.value, url.value, auth, icon);
          close();
        } catch (err) {
          error.textContent = errText(err);
          submit.disabled = false;
        }
      },
    },
    h("h2", { class: "dialog-title" }, s ? `编辑「${s.name}」` : "添加服务器"),
    h(
      "div",
      { class: "field" },
      h("label", {}, "图标"),
      h("div", { class: "icon-pick" }, preview, h("div", { class: "icon-side" }, grid, custom)),
    ),
    h("div", { class: "field" }, h("label", { for: "d-url" }, "地址"), url),
    h("div", { class: "field" }, h("label", { for: "d-name" }, "名称（可选，显示在顶栏上）"), name),
    advanced,
    error,
    h(
      "div",
      { class: "dialog-actions" },
      s
        ? h(
            "button",
            {
              type: "button",
              class: "btn danger",
              onclick: async () => {
                if (await call("removeServer", s.id)) close();
              },
            },
            "移除这台服务器",
          )
        : null,
      h("span", { class: "grow" }),
      h("button", { type: "button", class: "btn", onclick: close }, "取消"),
      submit,
    ),
  );
  const backdrop = h("div", { class: "dialog-backdrop", onmousedown: (e) => e.target === backdrop && close() }, form);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  dialogClose = close;
  renderIcon();
  requestAnimationFrame(() => (s ? name : url).focus());
}
