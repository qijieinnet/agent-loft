import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { confirmDialog } from "../lib/overlay.js";
import { field } from "./common.js";
import { networkSection, serverVersionSection } from "./general.js";

// ---------- 用户（管理员） ----------

export async function usersTab(panel) {
  const box = h("div", { class: "section" }, h("h4", {}, "用户"), h("span", { class: "spinner" }));
  const addBox = h("div", { class: "section" });
  fill(panel, box, addBox);
  const reload = () => {
    fill(panel);
    void usersTab(panel);
  };
  let data;
  try {
    data = await api("/api/users");
  } catch (err) {
    fill(box, h("h4", {}, "用户"), h("div", { class: "error-text" }, err.message));
    return;
  }
  const act = (btn, fn) => async () => {
    btn.disabled = true;
    try {
      if ((await fn()) !== false) reload();
    } catch (err) {
      toast(err.message);
    }
    btn.disabled = false;
  };
  const patch = (u, body) => api(`/api/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body });

  /** 重置密码：就地展开一个输入框 */
  const resetRow = (u, holder) => {
    const pw = h("input", { type: "password", autocomplete: "new-password", placeholder: "新密码（至少 8 位）" });
    const ok = h("button", { class: "btn small primary" }, "确定");
    ok.onclick = act(ok, async () => {
      await patch(u, { password: pw.value });
      toast(`已重置「${u.name}」的密码，他的设备已下线`);
    });
    fill(holder, h("div", { class: "row" }, pw, ok));
    pw.focus();
  };

  fill(
    box,
    h("h4", {}, "用户"),
    h(
      "div",
      { class: "muted" },
      "每个人只看得到自己的对话、授权和通知。管理员能改所有设置，还能看到飞书机器人的对话。",
    ),
    h(
      "div",
      { class: "error-text" },
      "注意：账号不是安全隔离。所有 agent 都以服务器上的同一个系统用户运行，任何用户都能让 agent 读到这台机器上的文件（包括别人的对话记录和配置里的密钥），用的也是同一个 Claude / Codex 订阅。只把账号给你信任的人。",
    ),
    data.users.map((u) => {
      const self = u.id === data.me;
      const extra = h("div");
      const pwBtn = h("button", { class: "btn small" }, "重置密码");
      pwBtn.onclick = () => resetRow(u, extra);
      const roleBtn = h("button", { class: "btn small", disabled: self }, u.role === "admin" ? "设为成员" : "设为管理员");
      roleBtn.onclick = act(roleBtn, () => patch(u, { role: u.role === "admin" ? "member" : "admin" }));
      const disBtn = h("button", { class: "btn small", disabled: self }, u.disabled ? "启用" : "停用");
      // 远程控制：管理员一直能用，成员要单独开
      const remoteBtn =
        u.role === "admin"
          ? null
          : h("button", { class: "btn small", title: "远程控制：直接用服务器的终端和桌面，不经过授权" }, u.remote ? "关闭远程控制" : "开通远程控制");
      if (remoteBtn) {
        remoteBtn.onclick = act(remoteBtn, async () => {
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
        });
      }
      const memBtn = h("button", { class: "btn small", title: "删除他的「关于我」和所有记住的事。管理员看不到记忆的内容" }, "清空记忆");
      memBtn.onclick = act(memBtn, async () => {
        const sure = await confirmDialog({
          title: `清空「${u.name}」的记忆？`,
          message: "他的「关于我」和所有记住的事都会删除，不能恢复。",
          confirmText: "清空",
          danger: true,
        });
        if (!sure) return false;
        await api(`/api/users/${encodeURIComponent(u.id)}/memory`, { method: "DELETE" });
        toast("已清空");
      });
      const linkBtn = u.feishuLinks ? h("button", { class: "btn small" }, "解除飞书绑定") : null;
      if (linkBtn) {
        linkBtn.onclick = act(linkBtn, async () => {
          await api(`/api/users/${encodeURIComponent(u.id)}/feishu`, { method: "DELETE" });
          toast("已解除，他和机器人的私聊交还给管理员");
        });
      }
      const rmBtn = h("button", { class: "btn small danger", disabled: self }, "删除");
      rmBtn.onclick = act(rmBtn, async () => {
        const sure = await confirmDialog({
          title: `删除用户「${u.name}」？`,
          message: "他的设备会立刻下线，记忆和飞书绑定一起删除。他的对话不会删除，之后归管理员。",
          confirmText: "删除",
          danger: true,
        });
        if (!sure) return false;
        await api(`/api/users/${encodeURIComponent(u.id)}`, { method: "DELETE" });
        toast("已删除");
      });
      return h(
        "div",
        { class: "list-item", style: { flexWrap: "wrap" } },
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
          extra,
        ),
        pwBtn,
        roleBtn,
        disBtn,
        remoteBtn,
        memBtn,
        linkBtn,
        rmBtn,
      );
    }),
  );

  const name = h("input", { autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "登录用的名字" });
  const pw = h("input", { type: "password", autocomplete: "new-password", placeholder: "至少 8 位" });
  const role = h("select", {}, h("option", { value: "member" }, "成员"), h("option", { value: "admin" }, "管理员"));
  const add = h("button", { class: "btn primary" }, "添加");
  add.onclick = act(add, async () => {
    await api("/api/users", { method: "POST", body: { name: name.value.trim(), password: pw.value, role: role.value } });
    toast(`已添加「${name.value.trim()}」`);
  });
  fill(
    addBox,
    h("h4", {}, "添加用户"),
    field("用户名", name),
    field("密码", pw, "告诉对方，让他登录后在 设置 → 账号 里自己改掉"),
    field("角色", role, "成员只能用自己的对话；管理员能改所有设置、管理用户"),
    h("div", { class: "row" }, add),
  );
}

export async function systemTab(cfg, panel) {
  // 系统信息要等接口返回，先占好位置，版本和网络访问两节不用等它
  const sysBox = h("div", { class: "section" }, h("h4", {}, "系统", h("span", { class: "grow" }), h("span", { class: "spinner" })));
  panel.append(sysBox, serverVersionSection(), networkSection(cfg));
  let sys;
  try {
    sys = await api("/api/system");
  } catch (err) {
    fill(sysBox, h("h4", {}, "系统"), h("div", { class: "error-text" }, err.message));
    return;
  }
  fill(
    sysBox,
    h("h4", {}, "系统"),
    h("div", {}, `版本 ${sys.version} · Node ${sys.node} · 已运行 ${Math.round(sys.uptimeMs / 60000)} 分钟`),
    h("div", { class: "muted" }, sys.underSystemd ? "以系统服务运行" : "前台运行（重启需要在终端里操作）"),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn",
          disabled: !sys.underSystemd,
          onclick: async () => {
            if (!(await confirmDialog({ title: "重启 agent-loft？", message: "进行中的对话会被中断。", confirmText: "重启", danger: true }))) return;
            try {
              await api("/api/system/restart", { method: "POST" });
              toast("正在重启…");
              setTimeout(() => location.reload(), 5000);
            } catch (err) {
              toast(err.message);
            }
          },
        },
        "重启服务",
      ),
      "Notification" in window && Notification.permission !== "granted"
        ? h("button", { class: "btn", onclick: () => Notification.requestPermission() }, "开启浏览器通知")
        : null,
    ),
  );
}
