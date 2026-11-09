// 设置页：连接苹果日历 / 提醒事项 / 备忘录（只有 macOS，见主进程 apple.js）。

/** 打开前选的签名方式：local 建本机证书（推荐），adhoc 不用证书 */
let appleSigning = "local";

const APPLE_KINDS = [
  ["calendars", "日历"],
  ["reminders", "提醒事项"],
  ["notes", "备忘录"],
];

/** 一项权限现在怎么样、该给什么按钮 */
function applePermText(kind, v) {
  if (kind === "notes") {
    if (v === "granted") return { text: "已授权", ok: true };
    if (v === "denied") return { text: "已拒绝：到系统设置 → 隐私与安全性 → 自动化里，打开 Agent Loft Bridge 下的「备忘录」", fix: "settings" };
    if (v === "notDetermined") return { text: "还没授权", fix: "request" };
    return { text: "不确定（备忘录没在运行）。点「授权」会在后台打开备忘录再检查", fix: "request" };
  }
  const pane = kind === "calendars" ? "日历" : "提醒事项";
  if (v === "fullAccess") return { text: "完全访问", ok: true };
  if (v === "writeOnly") return { text: `只能添加、读不了：到系统设置 → 隐私与安全性 → ${pane}里，把 Agent Loft Bridge 改成「完全访问」`, fix: "settings" };
  if (v === "denied") return { text: `已拒绝：到系统设置 → 隐私与安全性 → ${pane}里打开 Agent Loft Bridge`, fix: "settings" };
  if (v === "restricted") return { text: "被系统限制（家长控制或描述文件），这台 Mac 上改不了" };
  if (v === "notDetermined") return { text: "还没授权", fix: "request" };
  return { text: "读不到状态" };
}

/** 点按钮：转圈期间禁用，出错弹出来，结束后按最新状态重画 */
async function appleAction(e, method, ...args) {
  e.currentTarget.disabled = true;
  try {
    await call(method, ...args);
  } catch (err) {
    alert(errText(err));
  }
  renderManage();
}

function appleSigningPicker() {
  return h(
    "div",
    { class: "row" },
    h(
      "div",
      { class: "grow" },
      "签名方式",
      h(
        "div",
        { class: "sub wrap" },
        appleSigning === "local"
          ? "在这台 Mac 上生成一张只能用来签代码的证书（不用苹果开发者账号，不设信任，不用输密码）。以后更新 Agent Loft，授权都还在。"
          : "不建证书。功能一样，但每次更新 Agent Loft 后系统会当成新程序，日历、提醒事项、备忘录都要重新授权。",
      ),
    ),
    h(
      "div",
      { class: "pick" },
      [
        ["local", "本机证书（推荐）"],
        ["adhoc", "不用证书"],
      ].map(([key, name]) =>
        h(
          "button",
          {
            class: appleSigning === key ? "on" : "",
            "aria-pressed": String(appleSigning === key),
            onclick: () => {
              appleSigning = key;
              renderManage();
            },
          },
          name,
        ),
      ),
    ),
  );
}

/** 复制按钮：点了显示「已复制」一会儿 */
function copyButton(label, what, url) {
  return h(
    "button",
    {
      class: "btn",
      onclick: async (e) => {
        const btn = e.currentTarget;
        try {
          await call("appleMcpCopy", what, url);
          btn.textContent = "已复制";
          setTimeout(() => (btn.textContent = label), 1500);
        } catch (err) {
          alert(errText(err));
        }
      },
    },
    label,
  );
}

/** MCP 服务：地址、访问范围、端口、token、怎么接到智能体上 */
function appleMcpRows(m, busy) {
  if (!m) return null;
  const urls = [m.localUrl, ...m.lanUrls];
  const status = m.error ? m.error : m.running ? "运行中" : "正在启动…";
  const port = h("input", {
    class: "num",
    type: "number",
    min: 1024,
    max: 65535,
    value: m.port,
    onchange: async (e) => {
      try {
        await call("appleMcpPort", Number(e.target.value));
      } catch (err) {
        alert(errText(err));
        e.target.value = m.port;
      }
    },
  });
  return [
    h(
      "div",
      { class: "row" },
      h("span", { class: `dot ${m.error ? "offline" : m.running ? "online" : "unknown"}` }),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "name" }, `MCP 服务 · ${status}`),
        h("div", { class: "sub wrap" }, "智能体只能通过这个 MCP 服务使用日历、提醒事项、备忘录，每个请求都要带 token，本机也一样；不能再直接运行 Bridge。"),
        urls.map((u) => h("div", { class: "sub wrap mono" }, u)),
      ),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "div",
        { class: "grow" },
        "访问范围",
        h(
          "div",
          { class: "sub wrap" },
          m.scope === "lan"
            ? "局域网里的其他电脑也能连（还是要 token）。走的是明文 HTTP，同一个网络里的人可能截获 token，只在家里、公司这类信得过的网络里开。第一次打开时 macOS 防火墙可能问要不要允许 Agent Loft 接受连接。"
            : "只有这台 Mac 上的程序连得上（127.0.0.1）。",
        ),
      ),
      h(
        "div",
        { class: "pick" },
        [
          ["local", "仅本机"],
          ["lan", "局域网"],
        ].map(([key, name]) =>
          h("button", { class: m.scope === key ? "on" : "", "aria-pressed": String(m.scope === key), disabled: busy, onclick: () => call("appleMcpScope", key) }, name),
        ),
      ),
    ),
    h("div", { class: "row" }, h("div", { class: "grow" }, "端口", h("div", { class: "sub" }, "改了以后已经配好的智能体也要改地址。")), port),
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, "Token", h("div", { class: "sub wrap" }, "请求头写 Authorization: Bearer <token>。token 不在界面上显示，点按钮复制。")),
      h(
        "div",
        { class: "actions" },
        copyButton("复制 token", "token"),
        h("button", { class: "btn", disabled: busy, onclick: (e) => appleAction(e, "appleMcpRegenerate") }, "重新生成"),
      ),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "div",
        { class: "grow" },
        "接到智能体上",
        h(
          "div",
          { class: "sub wrap" },
          "agent-loft：网页 → 设置 → MCP → 添加，类型选 http，地址填上面的地址，请求头名 Authorization、值点「复制请求头」粘贴并标成密钥，再在专家里勾上它。Claude Code 等其他客户端可以复制命令或 JSON 配置。",
        ),
      ),
      h("div", { class: "actions" }, copyButton("复制请求头", "header"), copyButton("复制 Claude Code 命令", "claude", urls[0]), copyButton("复制 JSON", "json", urls[0])),
    ),
  ];
}

function renderAppleCard(el) {
  const a = state.apple;
  if (!a) return fill(el);
  // 正在改端口时别重画，不然光标会跳
  if (el.contains(document.activeElement) && document.activeElement.type === "number") return;
  const busy = !!a.busy;
  const intro = "智能体通过 MCP 服务（要 token）读写这台 Mac 上的日历、提醒事项和备忘录，改动会同步到 iCloud。系统权限只给 Agent Loft Bridge，不会给 node、终端或其他程序。";

  if (!a.installed) {
    fill(
      el,
      h(
        "div",
        { class: "row" },
        h("span", { class: "dot unknown" }),
        h("div", { class: "grow" }, h("div", { class: "name" }, a.busy === "enable" ? "正在连接…" : a.busy === "disable" ? "正在断开…" : "未连接"), h("div", { class: "sub wrap" }, intro)),
        h(
          "div",
          { class: "actions" },
          h("button", { class: "btn primary", disabled: busy || !a.available, onclick: (e) => appleAction(e, "appleEnable", appleSigning) }, "连接"),
        ),
      ),
      appleSigningPicker(),
      a.available ? null : h("div", { class: "row hint wrap" }, "这个版本的桌面端没有带 Agent Loft Bridge。"),
      a.error ? h("div", { class: "row error-text" }, a.error) : null,
    );
    return;
  }

  const p = a.perms ?? {};
  const allOk = APPLE_KINDS.every(([k]) => applePermText(k, p[k]).ok);
  const signingText = a.signing === "adhoc" ? "未用证书签名，更新后要重新授权" : "本机证书签名";
  const busyText = { upgrade: "正在更新 Bridge…", resign: "正在重新签名…", disable: "正在断开…" }[a.busy];
  fill(
    el,
    h(
      "div",
      { class: "row" },
      h("span", { class: `dot ${allOk ? "online" : "login"}` }),
      h("div", { class: "grow" }, h("div", { class: "name" }, busyText ?? (allOk ? "已连接" : "已连接 · 还有权限没给")), h("div", { class: "sub wrap" }, `${signingText}。${intro}`)),
      h("div", { class: "actions" }, h("button", { class: "btn", disabled: busy, onclick: (e) => appleAction(e, "appleDisable") }, "断开")),
    ),
    APPLE_KINDS.map(([kind, name]) => {
      const s = applePermText(kind, p[kind]);
      const requesting = a.busy === `request:${kind}`;
      return h(
        "div",
        { class: "row" },
        h("span", { class: `dot ${s.ok ? "online" : s.fix === "settings" ? "offline" : "unknown"}` }),
        h("div", { class: "grow" }, name, h("div", { class: "sub wrap" }, requesting ? "等你在系统弹窗里点「允许」…" : s.text)),
        s.fix === "request"
          ? h("button", { class: "btn primary", disabled: busy, onclick: (e) => appleAction(e, "appleRequest", kind) }, requesting ? "等待中…" : "授权")
          : s.fix === "settings"
            ? h("button", { class: "btn", onclick: () => call("appleOpenPrivacy", kind) }, "打开系统设置")
            : null,
      );
    }),
    h(
      "div",
      { class: "row switch-row" },
      h(
        "label",
        { for: "p-appleConfirm" },
        h("div", {}, "删除、修改前在这台 Mac 上确认"),
        h(
          "div",
          { class: "sub wrap" },
          a.confirmWrites
            ? "智能体删除或改写事件、提醒、备忘录时，Bridge 弹窗等你点「允许」，2 分钟没人点就拒绝。新建、勾完成、追加内容不用确认。人不在电脑前（比如在手机上用）时，这类操作会失败。"
            : "关着时智能体可以直接删除、改写，不再弹窗确认。",
        ),
      ),
      h("input", { id: "p-appleConfirm", type: "checkbox", class: "switch", checked: a.confirmWrites, disabled: busy, onchange: (e) => call("appleConfirmWrites", e.target.checked) }),
    ),
    appleMcpRows(a.mcp, busy),
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, "签名方式", h("div", { class: "sub wrap" }, a.signing === "adhoc" ? "现在没用证书。改成本机证书后，以后更新就不用再重新授权（这次要重新授权一次）。" : "现在用本机证书。")),
      h(
        "button",
        { class: "btn", disabled: busy, onclick: (e) => appleAction(e, "appleResign", a.signing === "adhoc" ? "local" : "adhoc") },
        a.signing === "adhoc" ? "改用本机证书" : "改成不用证书",
      ),
    ),
    a.error ? h("div", { class: "row error-text" }, a.error) : null,
  );
}
