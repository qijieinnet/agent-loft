import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { confirmDialog, showMenu } from "../lib/overlay.js";
import { field, saveButton } from "./common.js";
import { networkSection } from "./general.js";
import { deviceList } from "./security.js";

/** null 沿用全部；指定列表可以全部取消，新增资源不会自动加入。 */
function permissionFields(resources, permissions = {}) {
  const pickers = {};
  const el = h("div", { class: "user-permissions" });
  for (const [kind, label] of [["experts", "共享专家"], ["agents", "内置 Agent"], ["servers", "服务器切换"]]) {
    const selected = permissions[kind];
    const items = resources?.[kind] ?? [];
    const known = new Set(items.map((item) => item.id));
    const missing = (selected ?? []).filter((id) => !known.has(id)).map((id) => ({ id, name: `${id}（暂不可用）` }));
    const mode = h("select", { "aria-label": `${label}范围` },
      h("option", { value: "all", selected: selected == null }, "全部允许（含以后新增）"),
      h("option", { value: "pick", selected: selected != null }, "仅允许勾选项（可全部取消）"));
    const inputs = [...items, ...missing].map((item) => ({ id: item.id, input: h("input", { type: "checkbox", checked: selected == null || selected.includes(item.id) }), name: item.name }));
    const list = h("div", { class: "check-list" }, inputs.length
      ? inputs.map(({ input, name }) => h("label", { class: "check-item" }, input, h("span", {}, name)))
      : h("small", {}, kind === "servers" ? "尚未添加其他服务器" : "暂无可选项"));
    const sync = () => { list.hidden = mode.value !== "pick"; };
    mode.onchange = sync;
    sync();
    pickers[kind] = () => mode.value === "all" ? null : inputs.filter((x) => x.input.checked).map((x) => x.id);
    el.append(h("div", { class: "field" }, h("span", {}, label), mode, list));
  }
  el.append(h("small", {}, "自己创建的专家仍可使用。内置 Agent 权限只控制直接使用 Claude Code / Codex，不影响已获授权的专家。当前服务器保持可用；其他服务器仍需各自登录，由对应服务器管理账号权限。"));
  return { el, value: () => Object.fromEntries(Object.entries(pickers).map(([kind, value]) => [kind, value()])) };
}

// ---------- 用户（管理员） ----------

export async function usersTab(page) {
  const box = h("div", { class: "section" }, h("h4", {}, "用户"), h("span", { class: "spinner" }));
  const addBox = h("div", { class: "section", "data-form": "" });
  const devicesBox = h("div", { class: "section" });
  fill(page, box, addBox, devicesBox);
  const reload = () => {
    fill(page);
    void usersTab(page);
  };
  let data;
  try {
    data = await api("/api/users");
  } catch (err) {
    fill(box, h("h4", {}, "用户"), h("div", { class: "error-text" }, err.message));
    return;
  }
  /** 菜单里的一项：做完重新拉一遍；fn 返回 false = 取消了 */
  const act = (fn) => async () => {
    try {
      if ((await fn()) !== false) reload();
    } catch (err) {
      toast(err.message);
    }
  };
  const patch = (u, body) => api(`/api/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body });

  const permissionsRow = (u, holder) => {
    const picker = permissionFields(data.resources, u.permissions);
    const save = saveButton(async () => {
      await patch(u, { permissions: picker.value() });
      toast(`已更新「${u.name}」的使用权限`);
      reload();
    }, "保存使用权限");
    fill(holder, h("div", { "data-form": "" }, h("h4", {}, "使用权限"), picker.el,
      h("div", { class: "row" }, save, h("button", { class: "btn", onclick: () => fill(holder) }, "取消"))));
  };

  /** 重置密码：就地展开一个输入框 */
  const resetRow = (u, holder) => {
    const pw = h("input", { type: "password", autocomplete: "new-password", placeholder: "新密码（至少 8 位）" });
    const ok = h("button", { class: "btn small primary" }, "确定");
    const cancel = h("button", { class: "btn small", onclick: () => fill(holder) }, "取消");
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await patch(u, { password: pw.value });
        toast(`已重置「${u.name}」的密码，他的设备已下线`);
        reload();
      } catch (err) {
        toast(err.message);
        ok.disabled = false;
      }
    };
    pw.onkeydown = (e) => e.key === "Enter" && !e.isComposing && ok.click();
    fill(holder, h("div", { class: "row user-reset" }, pw, ok, cancel));
    pw.focus();
  };

  /** 一个用户能做的事：常用的直接放在行上，其余收进「⋯」 */
  const actions = (u, self, extra) => {
    const items = [{ label: "重置密码", onclick: () => resetRow(u, extra) }];
    if (!self) {
      items.push({ label: u.role === "admin" ? "设为成员" : "设为管理员", onclick: act(() => patch(u, { role: u.role === "admin" ? "member" : "admin" })) });
      items.push({
        label: u.disabled ? "启用账号" : "停用账号…",
        onclick: act(async () => {
          if (!u.disabled) {
            const sure = await confirmDialog({
              title: `停用「${u.name}」？`,
              message: "他的设备会立刻下线，之后登录不了。对话、记忆都保留，随时可以再启用。",
              confirmText: "停用",
              danger: true,
            });
            if (!sure) return false;
          }
          await patch(u, { disabled: !u.disabled });
          toast(u.disabled ? "已启用" : "已停用");
        }),
      });
    }
    // 远程控制：管理员一直能用，成员要单独开
    if (u.role !== "admin") {
      items.push({
        label: u.remote ? "关闭远程控制" : "开通远程控制…",
        onclick: act(async () => {
          if (!u.remote) {
            const sure = await confirmDialog({
              title: `给「${u.name}」开通远程控制？`,
              message:
                "他能在网页里直接用这台机器的终端和桌面，以运行 agent-loft 的系统用户（和登录桌面的人）做任何事，不经过授权卡：读写这台机器上的所有文件（包括别人的对话记录和配置里的密钥）、装软件、停掉服务。只开给完全信任的人。",
              confirmText: "开通",
              danger: true,
            });
            if (!sure) return false;
          }
          await patch(u, { remote: !u.remote });
          toast(u.remote ? "已关闭，他开着的终端和桌面已经断开" : "已开通");
        }),
      });
    }
    items.push("sep");
    if (u.feishuLinks) {
      items.push({
        label: "解除飞书绑定",
        onclick: act(async () => {
          await api(`/api/users/${encodeURIComponent(u.id)}/feishu`, { method: "DELETE" });
          toast("已解除，他和机器人的私聊交还给管理员");
        }),
      });
    }
    items.push({
      label: "清空记忆…",
      danger: true,
      onclick: act(async () => {
        const sure = await confirmDialog({
          title: `清空「${u.name}」的记忆？`,
          message: "他的「关于我」和所有记住的事都会删除，不能恢复。管理员看不到记忆的内容，只能清空。",
          confirmText: "清空",
          danger: true,
        });
        if (!sure) return false;
        await api(`/api/users/${encodeURIComponent(u.id)}/memory`, { method: "DELETE" });
        toast("已清空");
      }),
    });
    if (!self) {
      items.push({
        label: "删除用户…",
        danger: true,
        onclick: act(async () => {
          const sure = await confirmDialog({
            title: `删除用户「${u.name}」？`,
            message: "他的设备会立刻下线，记忆和飞书绑定一起删除。他的对话不会删除，之后归管理员。",
            confirmText: "删除",
            danger: true,
          });
          if (!sure) return false;
          await api(`/api/users/${encodeURIComponent(u.id)}`, { method: "DELETE" });
          toast("已删除");
        }),
      });
    }
    const more = h("button", { class: "btn small", "aria-haspopup": "menu" }, "管理 ▾");
    more.onclick = () => showMenu(more, items);
    return more;
  };

  fill(
    box,
    h("h4", {}, `用户（${data.users.length}）`),
    h("div", { class: "muted" }, "每个人只看得到自己的对话、授权和通知。管理员能改所有设置，还能看到飞书机器人的对话。"),
    h(
      "div",
      { class: "error-text" },
      "注意：账号不是安全隔离。所有 agent 都以服务器上的同一个系统用户运行，任何用户都能让 agent 读到这台机器上的文件（包括别人的对话记录和配置里的密钥），用的也是同一个 Claude / Codex 订阅。只把账号给你信任的人。",
    ),
    data.users.map((u) => {
      const self = u.id === data.me;
      const extra = h("div");
      return h(
        "div",
        { class: "list-item user-entry" },
        h("div", { class: "user-entry-head" },
        h(
          "div",
          { class: "grow" },
          h(
            "div",
            { class: "t" },
            u.name,
            self ? "（你）" : "",
            " ",
            h("span", { class: "status-tag" }, u.role === "admin" ? "管理员" : "成员"),
            u.disabled ? h("span", { class: "status-tag bad" }, "已停用") : null,
            u.role !== "admin" && u.remote ? h("span", { class: "status-tag" }, "远程控制") : null,
          ),
          h("div", { class: "s" }, `创建于 ${relTime(u.createdAt)} · ${u.devices} 台设备已登录${u.feishuLinks ? ` · 绑定了 ${u.feishuLinks} 个飞书账号` : ""}`),
        ),
        h("div", { class: "row" },
          u.role !== "admin" ? h("button", { class: "btn small", onclick: () => permissionsRow(u, extra) }, "使用权限") : null,
          actions(u, self, extra))),
        extra,
      );
    }),
  );

  const name = h("input", { autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "登录用的名字" });
  const pw = h("input", { type: "password", autocomplete: "new-password", placeholder: "至少 8 位" });
  const role = h("select", {}, h("option", { value: "member" }, "成员"), h("option", { value: "admin" }, "管理员"));
  const permissions = permissionFields(data.resources);
  const remote = h("input", { type: "checkbox" });
  const memberOptions = h("div", { class: "user-permissions" }, permissions.el,
    h("div", { class: "field" }, h("span", {}, "远程权限"), h("label", { class: "check-item" }, remote, h("span", {}, "允许使用终端和桌面"))));
  role.onchange = () => { memberOptions.hidden = role.value === "admin"; };
  fill(
    addBox,
    h("h4", {}, "添加用户"),
    field("用户名", name),
    field("密码", pw, "告诉对方，让他登录后在 设置 →「账号」里自己改掉"),
    field("角色", role, "成员只能用自己的对话；管理员能改所有设置、管理用户"),
    memberOptions,
    h(
      "div",
      { class: "row" },
      saveButton(async () => {
        if (role.value === "member" && remote.checked && !(await confirmDialog({
          title: `给「${name.value.trim()}」开通远程控制？`,
          message: "他能以运行 agent-loft 的系统用户直接使用终端和桌面，读写服务器上的文件、安装软件、停止服务，不经过授权卡。只开给完全信任的人。",
          confirmText: "开通并添加", danger: true,
        }))) return false;
        await api("/api/users", { method: "POST", body: { name: name.value.trim(), password: pw.value, role: role.value,
          ...(role.value === "member" ? { remote: remote.checked, permissions: permissions.value() } : {}) } });
        toast(`已添加「${name.value.trim()}」`);
        // 先标成已保存再刷新，免得离开提醒
        addBox.removeAttribute("data-dirty");
        reload();
      }, "添加"),
    ),
  );

  // 所有人登录着的设备：哪台不认识就让它下线
  const loadDevices = async () => {
    let sessions;
    try {
      sessions = await api("/api/web-sessions");
    } catch (err) {
      fill(devicesBox, h("h4", {}, "所有已登录的设备"), h("div", { class: "error-text" }, err.message));
      return;
    }
    fill(
      devicesBox,
      h("h4", {}, `所有已登录的设备（${sessions.length}）`),
      deviceList(sessions, { showOwner: true, onChange: loadDevices }),
    );
  };
  void loadDevices();
}

/** 设置 → 系统：服务端运行状态、版本和升级、重启，网络访问 */
export async function systemTab(cfg, page) {
  const sysBox = h("div", { class: "section" }, h("h4", {}, "服务端", h("span", { class: "grow" }), h("span", { class: "spinner" })));
  page.append(sysBox, networkSection(cfg));

  const restart = async () => {
    if (!(await confirmDialog({ title: "重启 agent-loft？", message: "进行中的对话会被中断。", confirmText: "重启", danger: true }))) return;
    try {
      await api("/api/system/restart", { method: "POST" });
      toast("正在重启…");
      setTimeout(() => location.reload(), 5000);
    } catch (err) {
      toast(err.message);
    }
  };

  // 运行状态马上就有；最新版本要去 npm 查，可能要几秒，查到了再补上
  let sys = null;
  let v = null;
  let checking = true;
  const render = () => {
    const recheck = h("button", { class: "btn small", disabled: checking }, checking ? "检查中…" : "检查更新");
    recheck.onclick = () => void checkVersion(true);
    const status = checking
      ? h("span", { class: "status-tag" }, "正在检查更新…")
      : !v
        ? null
        : v.updateAvailable
          ? h("span", { class: "status-tag ok" }, `有新版本 ${v.latest}`)
          : v.latest
            ? h("span", { class: "status-tag" }, "已是最新版本")
            : h("span", { class: "status-tag bad", title: v.latestError ?? "" }, "查不到最新版本");
    const upgradeBtn = v?.updateAvailable && v.canUpgrade && !checking ? h("button", { class: "btn small primary" }, `升级到 ${v.latest}`) : null;
    if (upgradeBtn) {
      upgradeBtn.onclick = async () => {
        upgradeBtn.disabled = true;
        upgradeBtn.textContent = "正在升级…";
        try {
          const r = await api("/api/server/upgrade", { method: "POST" });
          toast(r.restarting ? `已升级到 ${r.to}，服务正在重启，页面会自动重连` : `已升级到 ${r.to}，重启 agent-loft 后生效`, 6000);
          void checkVersion(false);
        } catch (err) {
          toast(`升级失败：${err.message}`, 6000);
          upgradeBtn.disabled = false;
          upgradeBtn.textContent = `升级到 ${v.latest}`;
        }
      };
    }
    fill(
      sysBox,
      h("h4", {}, "服务端"),
      h("div", { class: "row" }, h("b", {}, `agent-loft ${v?.version ?? sys.version}`), status),
      h("div", { class: "muted" }, `Node ${sys.node} · 已运行 ${uptime(sys.uptimeMs)} · ${sys.underSystemd ? "以系统服务运行" : "前台运行（重启需要在终端里操作）"}`),
      v && !checking && !v.latest && v.latestError ? h("div", { class: "muted" }, v.latestError) : null,
      v?.updateAvailable && !v.canUpgrade && v.reason ? h("div", { class: "muted" }, v.reason) : null,
      v?.updateAvailable && v.canUpgrade && !v.service ? h("div", { class: "muted" }, "agent-loft 是在前台手动运行的，升级后要自己重启一下。") : null,
      h(
        "div",
        { class: "row" },
        upgradeBtn,
        recheck,
        h("span", { class: "grow" }),
        h("button", { class: "btn small", disabled: !sys.underSystemd, title: sys.underSystemd ? "" : "前台运行时请在终端里重启", onclick: () => void restart() }, "重启服务"),
      ),
    );
  };
  /** refresh：「检查更新」时让服务端重新去 npm 查最新版本 */
  const checkVersion = async (refresh) => {
    checking = true;
    if (sys) render();
    try {
      v = await api(`/api/server/version${refresh ? "?refresh=1" : ""}`);
    } catch (err) {
      v = null;
      toast(`检查更新失败：${err.message}`);
    }
    checking = false;
    if (sys) render();
  };
  const versionDone = checkVersion(false);
  try {
    sys = await api("/api/system");
  } catch (err) {
    fill(sysBox, h("h4", {}, "服务端"), h("div", { class: "error-text" }, err.message));
    return;
  }
  render();
  await versionDone;
}

/** 运行了多久：分钟 / 小时 / 天 */
function uptime(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  if (min < 1440) return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
  return `${Math.floor(min / 1440)} 天 ${Math.floor((min % 1440) / 60)} 小时`;
}
