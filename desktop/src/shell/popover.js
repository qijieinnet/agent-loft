// 菜单栏面板：各服务器的额度、待处理、运行中。鼠标移到菜单栏图标上弹出（不抢焦点），点击固定。

const $root = document.getElementById("root");
const call = (method, ...args) => window.loft.call(method, ...args);
let state = null;
let refreshing = false;

function render() {
  if (!state) return;
  const dup = duplicateQuotas(state.servers);
  const lastAt = Math.max(0, ...state.servers.map((s) => s.quotaAt ?? 0));

  const refreshBtn = h("button", { class: `tool ${refreshing ? "spin" : ""}`, title: "刷新额度", onclick: refresh });
  refreshBtn.innerHTML =
    '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 4v3.5h-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  fill(
    $root,
    h(
      "div",
      { class: "head" },
      h("img", { class: "logo", src: "../../assets/icon.png", alt: "" }),
      h("span", { class: "title" }, "Agent Loft"),
      lastAt ? h("span", { class: "ago" }, `${agoText(lastAt)}更新`) : null,
      refreshBtn,
    ),
    // 打开主窗口：双击菜单栏图标；设置、退出：右键菜单 / 主窗口里
    h("div", { class: "servers" }, state.servers.length ? state.servers.map((s) => serverBlock(s, dup)) : h("div", { class: "empty" }, "还没有添加服务器")),
  );
  reportSize();
}

function serverBlock(s, dup) {
  const meta = [];
  if (s.busy) meta.push(h("span", { class: "chip busy" }, h("i", { class: "pulse" }), `${s.busy} 个运行中`));
  if (s.status !== "online") meta.push(h("span", { class: `chip state ${s.status}` }, h("span", { class: `dot ${s.status}` }), STATUS_TEXT[s.status] ?? s.status));
  const block = h(
    "div",
    { class: "server" },
    h(
      "button",
      { class: "server-head", title: `打开 ${s.name}`, onclick: () => call("open", s.id) },
      serverIcon(s, "av"),
      h("span", { class: "name" }, s.name),
      meta,
      h("span", { class: "chev" }, "›"),
    ),
  );

  if (s.status === "access") {
    const what = s.access?.kind === "cloudflare" ? "Cloudflare Access" : "登录网关";
    block.append(
      h(
        "div",
        { class: "note warn access-note" },
        h("span", {}, `${what}要求验证，验证前收不到这台服务器的通知`),
        h("button", { class: "go", onclick: () => call("open", s.id) }, "去验证"),
      ),
    );
  } else if (s.status === "login" || s.status === "setup") {
    block.append(h("div", { class: "note warn" }, s.status === "login" ? "在主窗口里登录后才能看到额度" : "先在主窗口里设置登录密码"));
  } else if (s.quotas?.length) {
    for (const q of s.quotas) {
      const same = dup.get(`${s.id}:${q.agent}`);
      block.append(same ? h("div", { class: "same" }, `${q.label}：和「${same}」是同一个账号`) : quotaBlock(q));
    }
  } else if (s.status === "online") {
    block.append(h("div", { class: "note" }, s.quotaError ? `额度读取失败：${s.quotaError}` : s.quotaAt ? "没有可显示的额度" : "正在读取额度…"));
  } else if (s.status === "offline" && s.error) {
    block.append(h("div", { class: "note" }, s.error));
  }

  if (s.server?.updateAvailable && s.server.canUpgrade) {
    block.append(h("button", { class: "note update-note", onclick: () => call("manage") }, `服务端有新版本 ${s.server.latest}，点这里去升级`));
  }
  if (s.pending.length) {
    const shown = s.pending.slice(0, 4);
    block.append(
      h(
        "div",
        { class: "pending" },
        shown.map((p) =>
          h(
            "button",
            { title: `${p.conv}：${p.title}`, onclick: () => call("open", s.id, p.key) },
            h("span", { class: "what" }, p.title),
            h("span", { class: "conv" }, p.conv),
          ),
        ),
        s.pending.length > shown.length ? h("div", { class: "note" }, `还有 ${s.pending.length - shown.length} 个…`) : null,
      ),
    );
  }
  return block;
}

async function refresh() {
  refreshing = true;
  render();
  try {
    await call("refresh");
  } finally {
    // 额度是异步陆续回来的，转一会儿就停
    setTimeout(() => {
      refreshing = false;
      render();
    }, 1200);
  }
}

function reportSize() {
  requestAnimationFrame(() => void call("popoverResize", $root.getBoundingClientRect().height));
}


window.loft.onState((s) => {
  state = s;
  render();
});
window.loft.state().then((s) => {
  state = s;
  render();
});
// 「更新于 x 分钟前」跟着走
setInterval(render, 30_000);
