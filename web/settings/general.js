import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { desktop } from "../state.js";
import { field, saveButton, saveConfig } from "./common.js";

/** 设置 → 对话：所有会话共用的规矩——在哪个目录、多久算新会话、授权卡等多久、Claude 的「总是允许」 */
export async function conversationTab(cfg, page) {
  const root = h("input", { value: cfg.workspaceRoot });
  const ttl = h("input", { type: "number", min: 0, value: Math.round(cfg.sessionTtlMs / 3600000) });
  const approval = h("input", { type: "number", min: 1, value: Math.round(cfg.approvalTimeoutMs / 60000) });
  const allowBox = h("div", { class: "section", "data-form": "" }, h("h4", {}, "Claude「总是允许」名单"), h("span", { class: "spinner" }));
  page.append(
    h(
      "div",
      { class: "section", "data-form": "" },
      h("h4", {}, "会话"),
      field("工作目录（workspace）", root, "所有会话的默认目录，/cd 只能在它之内"),
      field("会话闲置多久自动开新会话（小时）", ttl, "0 表示永不过期"),
      field("授权卡等待多久（分钟）", approval, "agent 要执行命令、改文件时弹出的授权卡，没人处理超过这么久就按拒绝处理"),
      h(
        "div",
        { class: "row" },
        saveButton(() =>
          saveConfig(cfg, {
            workspaceRoot: root.value,
            sessionTtlMs: Number(ttl.value) * 3600000,
            approvalTimeoutMs: Number(approval.value) * 60000,
          }),
        ),
      ),
    ),
    allowBox,
  );
  const allowlist = await api("/api/claude/allowlist");
  const allowText = h("textarea", { rows: 8 });
  allowText.value = allowlist.join("\n");
  fill(
    allowBox,
    h("h4", {}, "Claude「总是允许」名单"),
    h("div", { class: "muted" }, "授权卡上点过「总是允许」的会记在这里，以后同类操作不再弹卡。Bash:git 表示 git 开头的命令都放行；Edit:/路径 表示该目录下的修改都放行。一行一条，删掉即撤销。"),
    allowText,
    h(
      "div",
      { class: "row" },
      saveButton(async () => {
        await api("/api/claude/allowlist", { method: "PUT", body: { list: allowText.value.split("\n") } });
        toast("已保存");
      }),
    ),
  );
}

/** 设置 → 远程控制：终端、桌面各自的开关，没人连着多久结束，桌面从哪来。成员能不能用在「用户」里一个个开 */
export function remoteTab(cfg, page) {
  const r = cfg.remote ?? {};
  const termOn = h("input", { type: "checkbox", checked: r.terminal !== false });
  const deskOn = h("input", { type: "checkbox", checked: r.desktop !== false });
  const keep = h("input", { type: "number", min: 1, max: 1440, value: r.keepAliveMin ?? 30 });
  const source = h(
    "select",
    {},
    h("option", { value: "auto" }, "共享这台机器当前的桌面（Linux，用 x11vnc）"),
    h("option", { value: "vnc" }, "连已有的 VNC 服务（macOS 屏幕共享等）"),
  );
  source.value = r.desktopSource ?? "auto";
  const display = h("input", { value: r.display ?? "", placeholder: "留空自动找，如 :0", autocapitalize: "off", spellcheck: "false" });
  const host = h("input", { value: r.vncHost ?? "127.0.0.1", autocapitalize: "off", spellcheck: "false" });
  const port = h("input", { type: "number", min: 1, max: 65535, value: r.vncPort ?? 5900 });
  const password = h("input", { type: "password", value: r.vncPassword ?? "", autocomplete: "new-password", placeholder: "VNC 密码" });
  const autoBox = h("div", { class: "field-group" }, field("X 显示", display, "一台机器上有好几个桌面（比如登录界面 :0、登录后的桌面 :1）时可以指定"));
  const vncBox = h(
    "div",
    { class: "field-group" },
    field("地址", host),
    field("端口", port),
    field(
      "密码",
      password,
      "macOS：屏幕共享 →「电脑设置…」里勾选「VNC 显示程序可以使用密码控制屏幕」并设这个密码。开通了远程控制的成员连桌面时，页面会拿到这个密码",
    ),
  );
  // 桌面关着时，桌面来源那几项用不上，收起来
  const deskBox = h("div", { class: "field-group" }, field("桌面来源", source), autoBox, vncBox);
  const sync = () => {
    autoBox.hidden = source.value !== "auto";
    vncBox.hidden = source.value !== "vnc";
    deskBox.hidden = !deskOn.checked;
  };
  source.addEventListener("change", sync);
  deskOn.addEventListener("change", sync);
  sync();
  // 终端、桌面用不了时的原因（没装 node-pty、没有图形桌面、没装 x11vnc…）
  const status = h("div", { class: "error-text", hidden: true });
  const loadStatus = () =>
    api("/api/remote").then(
      (st) => {
        const lines = [
          st.terminal.available ? null : `终端：${st.terminal.reason ?? "用不了"}`,
          st.desktop.available ? null : `桌面：${st.desktop.reason ?? "这台机器没有桌面"}（远程控制里只有终端）`,
        ].filter(Boolean);
        fill(status, lines.map((l, i) => [i ? h("br") : null, l]));
        status.hidden = !lines.length;
      },
      () => {},
    );
  void loadStatus();
  page.append(
    h(
      "div",
      { class: "section", "data-form": "" },
      h("h4", {}, "远程控制"),
      h(
        "div",
        { class: "muted" },
        "侧栏「远程控制」里直接操作这台机器的桌面和终端，切回对话时连接留在后台。以运行 agent-loft 的系统用户执行，没有授权卡。管理员能用；成员要在 管理 →「用户」里单独开通。",
      ),
      status,
      h("label", { class: "check" }, termOn, "网页终端"),
      h("label", { class: "check" }, deskOn, "远程桌面"),
      deskBox,
      field("没有页面连着多久后结束（分钟）", keep, "关掉页面、断线后 shell 继续运行，重新打开能接着用；共享桌面用的 x11vnc 也是这么久没人连就停掉"),
      h(
        "div",
        { class: "row" },
        saveButton(async () => {
          const ok = await saveConfig(cfg, {
            remote: {
              terminal: termOn.checked,
              desktop: deskOn.checked,
              keepAliveMin: Number(keep.value),
              desktopSource: source.value,
              display: display.value.trim(),
              vncHost: host.value.trim(),
              vncPort: Number(port.value),
              vncPassword: password.value,
            },
          });
          if (ok) void loadStatus();
          return ok;
        }),
      ),
    ),
  );
}

/** 只有本机能连的监听地址（和服务端 listen.ts 的判断一致） */
function loopbackHost(host) {
  const v = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return v === "localhost" || v === "::1" || /^127\./.test(v);
}

/**
 * 网络访问：要不要让局域网里的其他设备打开、监听哪个端口。保存后服务端当场换过去，不用重启；
 * 端口被占用之类的失败会直接报出来，原来的照常工作。
 */
export function networkSection(cfg) {
  const net = cfg.network ?? { lan: [], local: true, listening: null };
  const box = h("div", { class: "section", "data-form": "" });
  const lanOn = h("input", { type: "checkbox", checked: !loopbackHost(cfg.web.host) });
  const port = h("input", { type: "number", min: 1, max: 65535, value: cfg.web.port });
  const hint = h("small", {});
  // 现在这个页面是不是直接连的这个端口（不是经由反代 / 隧道）
  const pagePort = Number(location.port || (location.protocol === "https:" ? 443 : 80));
  const direct = pagePort === cfg.web.port;

  const update = () => {
    const p = Number(port.value) || cfg.web.port;
    const lines = [];
    if (lanOn.checked) {
      lines.push(
        net.lan.length
          ? `局域网里的其他设备用 ${net.lan.map((ip) => `http://${ip}:${p}`).join(" 或 ")} 打开`
          : "这台机器现在没连局域网，连上后其他设备可以用它的局域网地址打开",
      );
    } else {
      lines.push("只有这台机器自己能打开。这台机器上的反向代理、Cloudflare Tunnel 之类不受影响");
    }
    if (!net.local && !lanOn.checked && !loopbackHost(cfg.web.host)) {
      lines.push("⚠️ 你现在是从局域网里的另一台设备访问的，不能在这里关掉，请到运行 agent-loft 的机器上操作");
    }
    if (!direct && p !== cfg.web.port) lines.push(`⚠️ 你是经由反向代理 / 隧道访问的，改端口后要把它指向新端口 ${p}，否则这个页面会打不开`);
    fill(hint, lines.map((l, i) => [i ? h("br") : null, l]));
  };
  lanOn.addEventListener("change", update);
  port.addEventListener("input", update);
  update();

  const save = async () => {
    const p = Number(port.value);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      toast("端口要是 1 到 65535 之间的整数");
      return false;
    }
    // 打开：原来是本机地址就改成所有网卡；原来就是某个具体地址（手改过配置）就保留
    const host = lanOn.checked ? (loopbackHost(cfg.web.host) ? "0.0.0.0" : cfg.web.host) : "127.0.0.1";
    if (host === cfg.web.host && p === cfg.web.port) return true;
    const oldPort = cfg.web.port;
    let next;
    try {
      next = await api("/api/config", { method: "PUT", body: { web: { host, port: p } } });
    } catch (err) {
      toast(err.message, 5000);
      return false;
    }
    Object.assign(cfg, next);
    if (p !== oldPort && direct) {
      // 旧端口已经不再接新连接：带着当前会话跳到新端口
      const url = new URL(location.href);
      url.port = String(p);
      toast(`已改为端口 ${p}，正在跳转…`);
      // 桌面端里由它改掉存着的服务器地址再重新打开（直接跳过去会被当成外部链接）
      if (typeof desktop?.serverMoved === "function") desktop.serverMoved(url.origin);
      else setTimeout(() => (location.href = url.href), 600);
      return true;
    }
    toast(p !== oldPort ? `已改为端口 ${p}，记得把反向代理 / 隧道也指向它` : "已保存", p !== oldPort ? 6000 : 2600);
    box.replaceWith(networkSection(cfg));
    return true;
  };

  fill(
    box,
    h("h4", {}, "网络访问"),
    h("label", { class: "check" }, lanOn, "允许局域网内的其他设备访问"),
    hint,
    field("端口", port, "改了立即生效，不用重启"),
    h("div", { class: "row" }, saveButton(save)),
  );
  return box;
}
