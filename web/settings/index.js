import { fill, h } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { isAdmin } from "../state.js";
import { confirmDialog, modal } from "../lib/overlay.js";
import { notifyTab } from "./notify.js";
import { conversationTab, remoteTab } from "./general.js";
import { commandsTab } from "./commands.js";
import { agentsTab } from "./agents.js";
import { feishuTab } from "./feishu.js";
import { accountTab } from "./security.js";
import { memoryTab } from "./memory.js";
import { skillsTab } from "./skills.js";
import { usageTab } from "./usage.js";
import { serversTab } from "./servers.js";
import { systemTab, usersTab } from "./users.js";
import { hasDirty, markDirty } from "./common.js";

// ---------- 设置 ----------
// 按「谁的、管什么」分组：我的（每个人自己的）、Agent、连接（飞书、远程控制）、管理。
// 普通成员只有「我的」这一组；其余都是管理员的，要先拿配置。

const LAST_TAB = "aim.settingsTab";

/** 以前的标签名：外面（地址、别处的按钮）传进来的旧名字照样能打开对应的页 */
const RENAMED = { 通用: "对话", 授权: "对话", 飞书机器人: "飞书", 我的账号: "账号" };

function groupsFor(cfg) {
  const mine = {
    name: "我的",
    tabs: [
      ["账号", (p) => accountTab(p)],
      ["通知", (p) => notifyTab(p)],
      ["记忆", (p) => memoryTab(p)],
      ["技能", (p) => skillsTab(p)],
      ["用量", (p) => usageTab(p)],
    ],
  };
  if (!cfg) return [mine];
  return [
    mine,
    {
      name: "Agent",
      tabs: [
        ["Agent", (p) => agentsTab(cfg, p)],
        ["对话", (p) => conversationTab(cfg, p)],
        ["命令", (p) => commandsTab(cfg, p)],
      ],
    },
    {
      name: "连接",
      tabs: [
        ["飞书", (p) => feishuTab(cfg, p)],
        ["远程控制", (p) => remoteTab(cfg, p)],
        ["服务器", (p) => serversTab(cfg, p)],
      ],
    },
    {
      name: "管理",
      tabs: [
        ["用户", (p) => usersTab(p)],
        ["系统", (p) => systemTab(cfg, p)],
      ],
    },
  ];
}

/** tab：直接打开哪一页（标签名，如「技能」），不给就是上次看的那页 */
export async function openSettings(tab) {
  const nav = h("div", { class: "settings-nav" });
  const panel = h("div", { class: "settings-body" });
  let page = null;
  const leaveOk = async () =>
    !page ||
    !hasDirty(page) ||
    confirmDialog({ title: "有修改还没保存", message: "现在离开，这一页刚才改的内容不会保存。", confirmText: "不保存", danger: true });
  // 设置弹窗高度固定，切标签页时不跟着内容一伸一缩
  modal({ title: "设置", wide: true, tall: true, body: h("div", { class: "settings" }, nav, panel), beforeClose: leaveOk });

  // 带 data-form 的表单里改了东西：标成没保存（common.js 的 saveButton）
  const onEdit = (e) => {
    if (e.target.closest("[data-nodirty]")) return;
    const form = e.target.closest("[data-form]");
    if (form && !form.dataset.dirty) markDirty(form);
  };
  panel.addEventListener("input", onEdit);
  panel.addEventListener("change", onEdit);

  let cfg = null;
  if (isAdmin()) {
    try {
      cfg = await api("/api/config");
    } catch (err) {
      panel.append(h("div", { class: "error-text" }, err.message));
      return;
    }
  }
  const groups = groupsFor(cfg);
  const tabs = groups.flatMap((g) => g.tabs);
  const buttons = [];
  let current = -1;

  const select = async (i) => {
    if (i === current || !(await leaveOk())) return;
    current = i;
    buttons.forEach((b, j) => b.classList.toggle("on", i === j));
    buttons[i].scrollIntoView({ block: "nearest", inline: "nearest" });
    localStorage.setItem(LAST_TAB, tabs[i][0]);
    // 每页一个新容器：慢的页还在等接口时切走了，它回来后写进的是已经不在页面上的旧容器，不会串到新页里
    page = h("div", { class: "settings-page" });
    fill(panel, page);
    panel.scrollTop = 0;
    try {
      await tabs[i][1](page);
    } catch (err) {
      if (page.isConnected) fill(page, h("div", { class: "error-text" }, err.message));
    }
  };

  for (const g of groups) {
    // 只有一组时不用标题
    if (groups.length > 1) nav.append(h("div", { class: "settings-group" }, g.name));
    for (const [name] of g.tabs) {
      const i = buttons.length;
      const b = h("button", { onclick: () => void select(i) }, name);
      buttons.push(b);
      nav.append(b);
    }
  }
  const want = tab ? (RENAMED[tab] ?? tab) : localStorage.getItem(LAST_TAB);
  void select(Math.max(0, tabs.findIndex(([name]) => name === want)));
}
