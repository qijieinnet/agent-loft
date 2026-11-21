// 目录只含静态名称、关键词和按需加载入口，可在不读取任何配置的情况下搜索。
const personal = "账号与偏好";
const models = "对话与模型";
const access = "连接与访问";
const admin = "实例管理";
const hub = "助手中心";

const pages = [
  ["account", "账号与安全", personal, "shield", "账号 登录 退出 改名 改密码 登录设备 下线", () => import("./security.js"), "accountTab"],
  ["bindings", "账号绑定", personal, "plug", "绑定微信 扫码 绑定飞书 配对个人账号", () => import("./security.js"), "bindingsTab"],
  ["notifications", "设备通知", personal, "chat", "开启通知 推送 测试通知 已订阅设备 提醒", () => import("./notify.js"), "notifyTab"],
  ["memory-prefs", "记忆偏好", personal, "edit", "关于我 记忆开关 聊天历史 自动整理 自我介绍", () => import("./memory.js"), "memoryPrefsTab"],
  ["engines", "模型与运行环境", models, "bolt", "换模型 引擎 实例默认模型 默认思考程度 API Key 登录 沙箱 标题 配额", () => import("./agents.js"), "agentsTab", true],
  ["sessions", "会话与授权", models, "shield", "工作目录 工作区 闲置 超时 Claude 总是允许 白名单", () => import("./general.js"), "conversationTab", true],
  ["commands", "快捷命令", models, "terminal", "斜杠命令 指令 命令列表", () => import("./commands.js"), "commandsTab", true],
  ["feishu", "飞书机器人", access, "feishu", "Lark 机器人 配对请求 已配对 指令面板", () => import("./feishu.js"), "feishuTab", true],
  ["remote", "远程控制", access, "monitor", "网页终端 桌面 VNC Mac 屏幕共享", () => import("./general.js"), "remoteTab", true],
  ["servers", "多服务器", access, "monitor", "切换服务器 允许被嵌入 iframe", () => import("./servers.js"), "serversTab", true],
  ["network", "网络访问", access, "plug", "局域网 监听地址 改端口", () => import("./general.js"), "networkTab", true],
  ["users", "用户与权限", admin, "shield", "成员 添加用户 设备 管理员 权限", () => import("./users.js"), "usersTab"],
  ["service", "服务与更新", admin, "gear", "升级 检查更新 版本 重启 服务状态", () => import("./users.js"), "systemTab"],
  ["experts", "专家", hub, "spark", "换模型 专家模型 内置权限 默认加载 共享 新建专家", () => import("./experts.js"), "expertsTab"],
  ["skills", "技能", hub, "bolt", "安装技能 技能包 上传 共享技能 变量", () => import("./skills.js"), "skillsTab"],
  ["mcp", "MCP", hub, "plug", "工具服务 共享 MCP 凭据 密钥", () => import("./experts.js"), "mcpTab"],
  ["memory", "记忆", hub, "clipboard", "记住的事 归档 回收站 跨实例同步 备份 摘要 导出", () => import("./memory.js"), "memoryTab"],
  ["usage", "用量", hub, "clock", "Token 费用 统计 成本", () => import("./usage.js"), "usageTab"],
];

export const directory = pages.map(([id, label, group, icon, keywords, load, method, config]) => ({
  id, label, group, icon, keywords, load, method, config, area: group === hub ? "assistants" : "settings",
  admin: group !== personal && group !== hub,
}));

const legacy = { "账号": "account", "我的账号": "account", "通知": "notifications", "对话": "sessions", "通用": "sessions", "授权": "sessions/approval", "命令": "commands", "飞书": "feishu", "服务器": "servers", "用户": "users" };
export function resolvePage(name, isAdmin) {
  if (name === "Agent") return isAdmin ? "engines" : "experts";
  if (name === "系统") return isAdmin ? "service" : "notifications";
  return Object.hasOwn(legacy, name) ? legacy[name] : directory.find(p => p.label === name)?.id || name;
}

// 分区 ID 也用于书签。只收录稳定的操作或字段，不索引账号数据。
export const sections = {
  account: [["devices", "登录设备", "下线设备"]],
  bindings: [["weixin", "绑定微信", "微信扫码"], ["feishu", "绑定飞书", "飞书账号"]],
  "memory-prefs": [["about", "关于我", "自我介绍"], ["automatic", "自动整理与聊天历史", "以前的聊天 历史索引"]],
  engines: [["claude", "Claude Code", "换模型 默认模型 默认思考程度"], ["codex", "Codex", "换模型 默认模型"], ["codex-sandbox", "Codex 沙箱", "沙箱权限限制"], ["codex-path", "Codex 可执行文件", "路径 CLI"], ["pi", "pi", "默认模型"], ["pi-providers", "pi 模型服务商", "API Key 订阅登录"], ["workbuddy", "WorkBuddy", "默认模型"], ["workbuddy-site", "WorkBuddy 账号站点", "腾讯 CodeBuddy"], ["dsh", "dsh", "DeepSeek Harness"], ["dsh-patch", "dsh 补丁文件", "patch"], ["quota", "账号额度", "额度查询 刷新间隔"]],
  sessions: [["workspace", "工作目录", "workspace"], ["approval", "授权等待时间", "授权超时"], ["allowlist", "Claude 总是允许名单", "白名单"]],
  skills: [["shared", "安装共享技能", "安装技能"], ["upload", "上传技能包", "导入技能"]],
  network: [["port", "监听端口", "改端口 端口号"], ["lan", "局域网访问", "允许局域网"]],
  servers: [["embed", "允许被嵌入", "嵌入授权"]],
  feishu: [["pair", "配对请求", "批准配对"], ["slash", "指令面板", "同步指令"]],
  memory: [["sync", "跨实例同步", "配对码"], ["archive", "归档", "恢复归档"], ["trash", "回收站", "恢复删除"], ["data", "导出和备份", "备份记忆 导出记忆"]],
};

export function searchDirectory(pages, query) {
  const words = query.trim().toLowerCase().split(/\s+/);
  const matches = text => words.every(word => text.toLowerCase().includes(word));
  return pages.flatMap(page => {
    const hits = (sections[page.id] || []).filter(([, label, keywords]) => matches([page.label, label, keywords].join(" ")));
    if (hits.length) return hits.map(([section, label]) => ({ page, section, label }));
    return matches([page.group, page.label, page.keywords].join(" ")) ? [{ page, label: page.label }] : [];
  });
}
