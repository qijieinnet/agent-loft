import { fill, h } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { isAdmin } from "../state.js";
import { modal } from "../lib/overlay.js";
import { notifyTab } from "./notify.js";
import { generalTab } from "./general.js";
import { commandsTab } from "./commands.js";
import { agentsTab } from "./agents.js";
import { feishuTab } from "./feishu.js";
import { authTab, securityTab } from "./security.js";
import { memoryTab } from "./memory.js";
import { skillsTab } from "./skills.js";
import { usageTab } from "./usage.js";
import { systemTab, usersTab } from "./users.js";

// ---------- 设置 ----------

/** tab：直接打开哪一页（标签名，如「技能」），不给就是第一页 */
export async function openSettings(tab) {
  const nav = h("div", { class: "settings-nav" });
  const panel = h("div", { class: "settings-body" });
  // 设置弹窗高度固定，切标签页时不跟着内容一伸一缩
  modal({ title: "设置", wide: true, tall: true, body: h("div", { class: "settings" }, nav, panel) });
  // 普通成员只能管自己的记忆、技能、用量、通知、密码和登录设备；其余设置都是管理员的
  if (!isAdmin()) {
    const tabs = [
      ["记忆", () => memoryTab(panel)],
      ["技能", () => skillsTab(panel)],
      ["用量", () => usageTab(panel)],
      ["通知", () => notifyTab(panel)],
      ["账号", () => securityTab(panel)],
    ];
    const select = (i) => {
      nav.querySelectorAll("button").forEach((b, j) => b.classList.toggle("on", i === j));
      fill(panel);
      tabs[i][1]();
    };
    nav.append(...tabs.map(([name], i) => h("button", { onclick: () => select(i) }, name)));
    select(Math.max(0, tabs.findIndex(([name]) => name === tab)));
    return;
  }
  let cfg;
  try {
    cfg = await api("/api/config");
  } catch (err) {
    panel.append(h("div", { class: "error-text" }, err.message));
    return;
  }
  const tabs = [
    ["通用", () => generalTab(cfg, panel)],
    ["Agent", () => agentsTab(cfg, panel)],
    ["命令", () => commandsTab(cfg, panel)],
    ["技能", () => skillsTab(panel)],
    ["飞书机器人", () => feishuTab(cfg, panel)],
    ["授权", () => authTab(panel)],
    ["记忆", () => memoryTab(panel)],
    ["用量", () => usageTab(panel)],
    ["通知", () => notifyTab(panel)],
    ["账号", () => securityTab(panel)],
    ["用户", () => usersTab(panel)],
    ["系统", () => systemTab(cfg, panel)],
  ];
  const select = (i) => {
    nav.querySelectorAll("button").forEach((b, j) => b.classList.toggle("on", i === j));
    fill(panel, );
    tabs[i][1]();
  };
  nav.append(...tabs.map(([name], i) => h("button", { onclick: () => select(i) }, name)));
  select(Math.max(0, tabs.findIndex(([name]) => name === tab)));
}
