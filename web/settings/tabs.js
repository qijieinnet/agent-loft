import { conversationTab, remoteTab } from "./general.js";
import { commandsTab } from "./commands.js";
import { agentsTab } from "./agents.js";
import { feishuTab } from "./feishu.js";
import { accountTab } from "./security.js";
import { memoryTab } from "./memory.js";
import { skillsTab } from "./skills.js";
import { expertsTab, mcpTab } from "./experts.js";
import { usageTab } from "./usage.js";
import { serversTab } from "./servers.js";
import { systemTab, usersTab } from "./users.js";

export function groupsFor(cfg) {
  const mine = {
    name: "我的",
    tabs: [
      ["账号", (p) => accountTab(p)],
      ["记忆", (p) => memoryTab(p)],
      ["专家", (p) => expertsTab(p)],
      ["技能", (p) => skillsTab(p)],
      ["MCP", (p) => mcpTab(p)],
      ["用量", (p) => usageTab(p)],
    ],
  };
  // 成员的内置 Agent 默认设置在「专家」里（内置卡片上的「设置」），这里没有 Agent 页
  if (!cfg) return [mine, { name: "系统", tabs: [["系统", (p) => systemTab(null, p)]] }];
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
