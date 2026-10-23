import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { desktop, desktopQuota } from "../state.js";
import { field, saveConfig } from "./common.js";

/** 服务端版本：有新版就能一键升级（npm install -g，系统服务下自动重启） */
export function serverVersionSection() {
  const box = h("div", { class: "section" });
  const load = async (refresh) => {
    fill(box, h("h4", {}, "服务端版本", h("span", { class: "grow" }), h("span", { class: "spinner" })));
    let v;
    try {
      v = await api(`/api/server/version${refresh ? "?refresh=1" : ""}`);
    } catch (err) {
      fill(box, h("h4", {}, "服务端版本"), h("div", { class: "error-text" }, err.message));
      return;
    }
    const recheck = h("button", { class: "btn small", onclick: () => load(true) }, "检查更新");
    const status = v.updateAvailable
      ? `有新版本 ${v.latest}`
      : v.latest
        ? "已是最新版本"
        : `查不到最新版本${v.latestError ? `：${v.latestError}` : ""}`;
    const upgradeBtn =
      v.updateAvailable && v.canUpgrade
        ? h(
            "button",
            {
              class: "btn small primary",
              onclick: async () => {
                upgradeBtn.disabled = true;
                upgradeBtn.textContent = "正在升级…";
                try {
                  const r = await api("/api/server/upgrade", { method: "POST" });
                  toast(r.restarting ? `已升级到 ${r.to}，服务正在重启，页面会自动重连` : `已升级到 ${r.to}，重启 agent-loft 后生效`, 6000);
                  void load(false);
                } catch (err) {
                  toast(`升级失败：${err.message}`, 6000);
                  upgradeBtn.disabled = false;
                  upgradeBtn.textContent = "升级";
                }
              },
            },
            "升级",
          )
        : null;
    fill(
      box,
      h("h4", {}, "服务端版本", h("span", { class: "grow" }), upgradeBtn, recheck),
      h("div", { class: "health-meta" }, `当前 ${v.version} · ${status}`),
      v.updateAvailable && !v.canUpgrade && v.reason ? h("div", { class: "health-meta" }, v.reason) : null,
      v.updateAvailable && v.canUpgrade && !v.service ? h("div", { class: "health-meta" }, "agent-loft 是在前台手动运行的，升级后要自己重启一下。") : null,
    );
  };
  void load(false);
  return box;
}

export function generalTab(cfg, panel) {
  const root = h("input", { value: cfg.workspaceRoot });
  const approval = h("input", { type: "number", min: 1, value: Math.round(cfg.approvalTimeoutMs / 60000) });
  const ttl = h("input", { type: "number", min: 0, value: Math.round(cfg.sessionTtlMs / 3600000) });
  const quotaMin = h("input", { type: "number", min: 0, max: 1440, value: cfg.web?.quotaRefreshMin ?? 10 });
  const quotaOn = h("input", { type: "checkbox", checked: cfg.web?.quotaEnabled !== false });
  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "通用"),
      field("工作目录（workspace）", root, "所有会话的默认目录，/cd 只能在它之内"),
      field("授权等待超时（分钟）", approval, "超时按拒绝处理"),
      field("会话闲置多久自动开新会话（小时）", ttl, "0 表示永不过期"),
      h("label", { class: "check" }, quotaOn, "查询账号额度"),
      h("div", { class: "muted" }, "关掉后侧栏、/status、桌面端都不再去问 agent 的额度（Claude 每次要临时起一个 CLI 进程才查得到）"),
      field(
        "额度自动刷新间隔（分钟）",
        quotaMin,
        desktopQuota
          ? "在桌面端里额度由桌面端统一刷新，以桌面端设置里的间隔为准；这里只对浏览器打开的页面生效"
          : "侧栏底部的额度，空闲时多久刷新一次；0 表示不自动刷新（跑完一轮、点击额度区域仍会刷新）",
      ),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: () =>
              saveConfig(cfg, {
                workspaceRoot: root.value,
                approvalTimeoutMs: Number(approval.value) * 60000,
                sessionTtlMs: Number(ttl.value) * 3600000,
                web: { quotaRefreshMin: Number(quotaMin.value), quotaEnabled: quotaOn.checked },
              }),
          },
          "保存",
        ),
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
  const box = h("div", { class: "section" });
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
    if (!Number.isInteger(p) || p < 1 || p > 65535) return toast("端口要是 1 到 65535 之间的整数");
    // 打开：原来是本机地址就改成所有网卡；原来就是某个具体地址（手改过配置）就保留
    const host = lanOn.checked ? (loopbackHost(cfg.web.host) ? "0.0.0.0" : cfg.web.host) : "127.0.0.1";
    if (host === cfg.web.host && p === cfg.web.port) return toast("没有改动");
    const oldPort = cfg.web.port;
    let next;
    try {
      next = await api("/api/config", { method: "PUT", body: { web: { host, port: p } } });
    } catch (err) {
      toast(err.message, 5000);
      return;
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
      return;
    }
    toast(p !== oldPort ? `已改为端口 ${p}，记得把反向代理 / 隧道也指向它` : "已保存", p !== oldPort ? 6000 : 2600);
    box.replaceWith(networkSection(cfg));
  };

  fill(
    box,
    h("h4", {}, "网络访问"),
    h("label", { class: "check" }, lanOn, "允许局域网内的其他设备访问"),
    hint,
    field("端口", port, "改了立即生效，不用重启"),
    h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => void save() }, "保存")),
  );
  return box;
}
