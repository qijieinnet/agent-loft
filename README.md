# agent-loft

用飞书（以后还有 Telegram 等）和 Web 页面，驱动本机的 **Claude Code** 和 **Codex**。

由 `feishu-claude-bridge` 和 `feishu-codex-bridge` 合并而来：一个进程、一份配置，飞书和网页共用同一套会话、审批和模型切换。

## 能做什么

- **多个 agent**：Claude Code（官方 Claude Agent SDK）、Codex（官方 `codex app-server`）。在同一条会话里 `/agent` 切换，各 agent 的上下文各自保留。
- **多个飞书机器人**：一个机器人对应一个 agent，或者一个机器人能切换多个 agent，都在设置页里勾选。机器人能在 Web 上扫码创建，改完配置立即生效，不用重启。
- **Web 聊天页**：电脑和手机都能用，界面参照 ChatGPT。
  - 回复逐字显示，markdown 和代码高亮，思考过程和工具调用可以折叠。
  - 授权卡、提问卡直接在页面上点。
  - 支持上传附件（粘贴、拖拽，手机上可以拍照）。
  - 可以「添加到主屏幕」当 App 用。手机切到后台再回来会自动重连，并补上错过的内容。
  - 系统通知：回复完成、出错、需要授权或提问时推送到手机 / 电脑（设置 → 通知 里按设备开启）。标准 Web Push，不用注册任何开发者账号；需要 HTTPS 访问，iPhone 需 iOS 16.4+ 且从主屏幕图标打开。
  - 收到推送时，主屏 / 桌面 PWA 图标上显示未读角标（iOS 16.4+、桌面 Chrome / Edge），打开页面自动清零。
  - 切换工作目录可以在目录树里一层层点选；新对话发第一条消息前也能先选好目录。
  - 语音输入：输入框旁的麦克风按钮，用浏览器自带的语音识别（Chrome / Edge / Safari，需要 HTTPS）。
  - 新对话页：大标题里点目录名切换工作目录；输入框上方的条里选目录和 agent，右下角直接选模型和思考程度（弹出菜单，不用开弹窗）。会话中 agent 不切换（命令 `/agent` 仍可切），模型和思考程度随时可换。
  - 输入框里显示上下文窗口占用（小圆环，悬停看已用 / 剩余 token）。
  - 输入框的模型按钮直接显示实际的模型和思考程度（如「Opus 5.5 high」），和选项里的名字一致；列表里显示哪些模型在 设置 → Agent 里勾选。
  - 每条回复下方显示用时、费用和完成时间，最后一条常驻，前面的悬停才出现；可以复制，也可以「从这里分叉」成一条新对话（只保留到这条回复，原对话不动）。
  - 侧栏分「最近」和「项目」两组：Web 会话按工作目录归类，飞书机器人各占一行并带飞书图标；分叉出来的对话挂在主对话下面，用虚线连起来；分组可折叠，宽度可拖动，双击会话重命名，名字太长时悬停滚动显示。
  - 侧栏底部显示 Claude / Codex 的订阅额度（5 小时 / 7 天窗口，悬停看重置时间）；空闲时按设置的间隔自动刷新（默认 10 分钟），跑完一轮后也会刷新。
- **跨渠道同步**：飞书里的会话在 Web 上也能打开，接着聊。同一个授权请求同时出现在飞书卡片和网页上，哪边先点算哪边，另一边自动变成「已处理」。
- **设置都在网页上**：工作目录、各 agent 的默认模型和思考程度、Codex 沙箱、飞书机器人、配对批准、Claude 的「总是允许」名单、登录设备管理。

## 安装

```bash
npm install -g agent-loft         # 或者在仓库里 npm install 后用 node bin/cli.js
agent-loft start                  # 前台运行，日志里会打印首次登录用的设置码
agent-loft service install        # 注册为开机自启服务（systemd / launchd）
```

打开 `http://<机器 IP>:8800`：第一次需要输入日志里的设置码，然后设一个登录密码。

### 从旧桥接器迁移

```bash
agent-loft import --dry-run       # 先看会导入什么
systemctl --user disable --now feishu-claude-bridge feishu-codex-bridge   # 同一个机器人不能被两个程序同时连
agent-loft import                 # 导入机器人凭据、白名单、配对、会话绑定、总是允许名单
agent-loft service install
```

导入后，飞书群里原来的会话会接着聊。

## 命令

| 命令 | 作用 |
|---|---|
| `agent-loft start` | 启动 |
| `agent-loft import [--only claude\|codex] [--disabled] [--dry-run]` | 从旧桥接器导入 |
| `agent-loft pair list \| approve <码> \| revoke <机器人id> <open_id>` | 配对管理（Web 设置页里也能做） |
| `agent-loft passwd [新密码]` | 重置 Web 登录密码，所有设备下线 |
| `agent-loft service install \| uninstall \| restart \| status` | 开机自启 |
| `agent-loft doctor` | 体检 |

聊天里的命令（飞书和 Web 通用；Web 输入框打 `/` 会弹出命令补全，飞书里打 `/` 会弹出机器人的指令面板（agent-loft 自动注册，约 5～8 分钟生效；只发一个 `/` 也会回一张可点击的命令卡片），顺序和显示项在 设置 → 命令 里调整）：`/new` `/fork` `/sessions [all]` `/resume <id>` `/model [名称]` `/effort <程度>` `/agent [名称]`（或者直接发 `/claude`、`/codex`）`/stop` `/cd <目录>` `/pwd` `/status` `/approve <id> allow-once|allow-always|allow-session|deny` `/help`

## 安全

这个服务能让 agent 在你的机器上执行命令，等于一个远程 shell。

- Web 登录密码用 scrypt 哈希保存。首次设置必须用启动日志里的一次性设置码，防止「谁先打开页面谁就成了主人」。
- 登录态通过 HttpOnly cookie 保存，服务端只存它的哈希。同一 IP 连续输错 5 次锁 15 分钟。所有写请求和 WebSocket 都校验 Origin。页面开启了严格的 CSP。
- 暴露到公网时，只通过 HTTPS 反向代理（比如 Lucky）访问，并把反代的 IP 加进 `web.trustedProxies`（只有从这些地址来的连接才采信 `X-Forwarded-*`）。不要直接把 8800 端口映射出去。
- 审批超时一律按拒绝处理。Codex 默认沙箱为 `workspace-write`，不会因为 `~/.codex/config.toml` 里配了 `never` 或 `danger-full-access` 就绕过审批。
- agent 子进程拿不到本服务自己的凭据（`FEISHU_*`、`AGENT_LOFT_*` 等环境变量会被剔除）。

## 结构

```
src/
  core/            与渠道、agent 都无关的中枢
    hub.ts         会话调度：事件广播、命令、切 agent / 模型 / 目录
    interactions.ts 审批与提问：一个请求，多个渠道都能处理
    store.ts       会话持久化（每个 agent 的会话 id 各自保存）
    config.ts      配置（Web 可改，改完热加载）
    pairing.ts uploads.ts commands.ts …
  agents/
    claude/        Claude Agent SDK 驱动
    codex/         codex app-server 驱动
  channels/
    feishu/        飞书：一个 FeishuBot 对应一个机器人，支持多个
    web/           HTTP + WebSocket + 鉴权
web/               前端（原生 JS，不需要构建）
```

### 接入新的消息渠道（比如 Telegram）

参照 `channels/feishu/bot.ts`，做三件事：

1. 收到消息 → `hub.ensure()` 建会话 → `parseCommand()`。是命令就调 `hub.command()`，再把 `CommandReply` 画出来；是聊天就调 `hub.send()`。
2. 订阅 `hub.on("event")`，挑出自己的会话（键前缀如 `telegram:<botId>:`），把 step / text / result / error 画出来。
3. 订阅 `interactions` 的 `created / updated / settled`，把授权卡和提问卡画成按钮。用户点击后调 `interactions.decide / select / submit / skip`。

### 接入新的 agent

实现 `core/types.ts` 里的 `AgentDriver`，然后在 `main.ts` 里 `hub.registerDriver()`。`AgentDriver` 包括开会话、发消息、中断、切模型、列历史、读历史，审批通过传入的 `InteractionHost` 发起。以后要接 ACP 协议的 agent（Gemini CLI、OpenCode 等），写一个通用的 ACP 驱动就行。

## 开发

```bash
npm install
npm run dev          # AGENT_LOFT_HOME=./.dev，改代码自动重启
npm test
npm run typecheck
```
