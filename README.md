<p align="center"><img src="web/icon.svg" width="120" alt="agent-loft"></p>

# agent-loft

**多个 agent 的工作台。** 把本机的 **Claude Code**、**Codex**（以后还有更多）放到同一张台面上统一管理，在网页、飞书和桌面端（macOS / Windows / Linux）随时驱动它们，进展推送到飞书、iPhone 和 Mac。

![Web 工作台](docs/images/web-chat.png)

> 📖 完整的产品介绍和使用指南见 **[docs/产品介绍.md](docs/产品介绍.md)**：六大核心亮点、快速上手、使用指南、命令速查、常见问题和故障排查。

由 `feishu-claude-bridge` 和 `feishu-codex-bridge` 合并而来：一个进程、一份配置，飞书和网页共用同一套会话、审批和模型切换。

## 理念

这里的 Loft 不是阁楼，是**工作台**：agent 是干活的人，agent-loft 是它们共用的那张台面。

- **多 agent，一张台面**：Claude Code、Codex 各有所长，不该各开一个窗口、各记一套会话。它们在这里共用工作目录、会话列表、审批和模型切换，同一条会话里随时换人接手，各自的上下文都保留着。
- **统一管理，而不是再造一个 agent**：agent-loft 不自己做模型、不改 agent 的行为，只负责把官方的 agent 接进来、管起来。新的 agent 接一个驱动就能上台。
- **人在哪，台面就在哪**：电脑上用网页，手机上用 PWA 或飞书。同一个会话、同一个授权请求，在哪个渠道处理都行，其他地方自动同步。
- **跑在你自己的机器上**：代码、凭据和会话都留在本机，agent-loft 只是一层安全的遥控。

Logo 就是这个意思：一大两小几颗星（多个 agent）站在同一张台面上。

## 六大核心亮点

| | 亮点 | 说明 |
|---|---|---|
| 🤖 | **同时管理多个 agent** | Claude Code（官方 Claude Agent SDK）和 Codex（官方 `codex app-server`）共用会话列表、工作目录和授权。同一条会话里用 `/claude`、`/codex`、`/agent` 切换，每个 agent 保留自己的上下文 |
| 🔀 | **飞书机器人灵活绑定 agent** | 机器人数量不限，每个机器人可以只对应一个 agent，也可以对应多个（在会话里切换）。网页上扫码就能创建，改完立即生效；由服务端主动连向飞书，家里没有公网 IP 也能在外面用 |
| 🔗 | **飞书续接 Web 任务** | 飞书里发 `/web` 接上一条 Web 会话，或者在网页侧栏右键会话选「在飞书继续…」。之后回复、授权、提问都发到飞书，发 `/detach` 回来 |
| 🖥️ | **完整的 Web 工作台** | 流式回复、附件、语音输入、模型和思考程度切换、上下文占用、从任意回复分叉、按项目分组的侧栏、全部设置，电脑和手机（PWA）都能用 |
| 🔔 | **飞书 + 苹果系统推送** | 除了飞书消息，Web 会话还能推送到 iPhone、iPad 锁屏和 Mac 通知中心（标准 Web Push，不需要开发者账号），图标上显示未读数 |
| 🗂️ | **桌面端同时接入多台设备** | 桌面端（macOS / Windows / Linux）同时连多台服务器，菜单栏 / 托盘一眼看完各台的额度、待处理和运行中的会话 |

## 能做什么

- **多个 agent**：Claude Code、Codex。两个 agent 共用工作目录，能看到对方改过的文件，但聊天记录各自独立。
- **多个飞书机器人**：一个机器人对应一个 agent，或者一个机器人能切换多个 agent，都在设置页里勾选。机器人能在 Web 上扫码创建（Lark 国际版用「手动添加」），改完配置立即生效，不用重启。
  - 群聊里要 @ 机器人；不同话题是各自独立的会话；支持文字、富文本、图片、文件、语音和视频。
  - 思考和工具调用显示在实时刷新的过程卡片里，最终回复是普通消息。
  - 陌生人发消息会拿到配对码，在设置页批准后才能使用；每个机器人单独授权。
- **Web 工作台**：电脑和手机都能用，界面参照 ChatGPT。
  - 回复逐字显示，markdown 和代码高亮，思考过程和工具调用可以折叠；每条回复下方显示用时、费用和完成时间，可以复制，也可以「从这里分叉」成一条新会话（原会话不动）。
  - 授权卡、提问卡直接在页面上点。
  - 附件：粘贴、拖拽，手机上可以拍照；可以预览和下载。附件存在服务端的专用上传目录里，开新会话或切换目录时清理。
  - 语音输入：用浏览器自带的语音识别（Chrome / Edge / Safari，需要 HTTPS）。
  - 新对话页：点大标题里的目录名，在目录树里逐层选工作目录；输入框上方选 agent，右下角选模型和思考程度。会话进行中用 `/agent` 切换 agent，模型和思考程度随时可换。
  - 输入框里的小圆环显示上下文窗口占用；模型按钮显示实际的模型和思考程度（如「Opus 5.5 high」）。
  - 侧栏分「最近」和「项目」两组：Web 会话按工作目录归类（目录可以拖动排序，右键可置顶），飞书机器人各占一行（右键看历史会话）；分叉出来的会话用虚线挂在原会话下面；会话标题由 agent 自动生成，双击重命名。
  - 侧栏底部显示 Claude / Codex 的订阅额度（5 小时 / 7 天窗口，以及多久后重置）。
  - 「添加到主屏幕」后当 App 用；切到后台再回来会自动重连，补上错过的内容。
- **系统通知**：Web 会话回复完成、出错、需要授权或提问时推送到手机 / 电脑（设置 → 通知 → 「在此设备开启通知」，可以发测试通知）。飞书会话由飞书提醒，正在前台看着的会话不推。需要 HTTPS 访问，iPhone 需 iOS 16.4+ 且从主屏幕图标打开。
- **跨渠道同步**：飞书里的会话在 Web 上也能打开接着聊。同一个授权请求同时出现在飞书卡片和网页上，哪边先点算哪边，另一边自动变成「已处理」。
- **授权**：允许一次 / 本会话全部允许 / 总是允许（按钮上写明放行范围）/ 拒绝。`/autoedit on` 让 Claude Code 在这条会话里改工作目录内的文件不再询问（Bash 仍询问）。超时一律按拒绝处理。
- **设置都在网页上**：工作目录、会话闲置过期时间、局域网访问和端口、各 agent 的默认模型和思考程度、可选模型、Codex 沙箱、飞书机器人、配对批准、Claude 的「总是允许」名单、通知设备、登录设备管理、用户管理、服务端升级。
- **多用户**（信任型）：管理员在 设置 → 用户 里给别人建账号。每个人只看得到自己的对话、授权和通知，设置只有管理员能改，见下面「安全」。
- **聊天模式 / 工作模式**：输入框右下角的「💬 聊天 / 🛠 工作」，或者发 `/chat`、`/work`，同一条对话随时切换、上下文接着。聊天模式换成精简的系统提示，只留联网搜索，不加载技能、MCP、插件，不执行命令、不读写本机文件（文本附件的内容直接放进消息），每轮的固定开销小得多：实测一句话 Claude 约 1.6 万 → 2 千 token，Codex 约 2 万 → 1.2 万（Codex 的基础指令改不了）。适合日常聊天、查资料；要动手干活时切回工作模式。切换后第一轮要重建提示缓存，会贵一些；在工作模式里读过的大段内容还留在历史里。
- **记忆**：像 ChatGPT 的记忆，设置 → 记忆。「关于我」加上一条条记住的事，每次对话都带上；agent 在聊天里遇到长期有用的信息会自己用 `remember` 记一条（回复里会说），记错了用 `forget` 删。**自动整理**：把上次整理之后新说的话交给模型（不留会话记录的一次性调用），补充、更新或删掉过时的记忆，用户自己加的条目它不动。什么时候整理每个人自己定：每天一次（默认凌晨 4 点，把当天的对话合起来一次整理，最省）／每段对话聊完后（停多久可选，改了什么会在对话里说一声）／只在点「现在整理」时／不整理；用哪个 agent 的哪个模型也能选，默认 Claude Haiku，没有 Claude 就用 Codex 的默认模型、思考程度 low。**参考以前的聊天**：agent 遇到「上次说的那个……」会用 `search_past_chats` 搜你以前的对话（关键词搜索，只有你自己的、没被删掉的对话；第一次用时会把已有对话收录进来）。两项都能在设置里单独关。每个用户一份，Claude 和 Codex、Web 和飞书共用。只用在有主人的对话里：你的 Web 对话，以及绑定了飞书账号后和机器人的私聊；飞书群聊不用。别人（包括管理员）看不到你的记忆，管理员只能清空它；删用户时记忆一起删，不转给管理员。
- **飞书账号绑定**：设置 → 账号 → 飞书账号 →「生成绑定码」，再在飞书私聊机器人发 `/bind 绑定码`（10 分钟内有效，群里发不算）。绑定后这个私聊就是你的个人会话：用你的记忆，`/sessions` 只列你的会话，`/web` 只能接上你自己的 Web 会话，管理员在 Web 上也看不到它。必须本人在两边各操作一次，管理员不能替人绑定（只能解除），否则就能借飞书读到别人的记忆。

## 安装

需要 Linux 或 macOS，Node.js 22 及以上。

```bash
npm install -g agent-loft         # 或者在仓库里 npm install 后用 node bin/cli.js
agent-loft start                  # 前台运行，日志里会打印首次登录用的设置码
agent-loft service install        # 注册为开机自启服务（systemd / launchd），日志在 ~/.agent-loft/logs/
```

打开 `http://<机器 IP>:8800`（本机用 `http://localhost:8800`）：第一次需要输入日志里的设置码，然后建一个管理员账号（用户名默认 `admin`）。设置码找不到的话，直接运行 `agent-loft passwd` 设密码。

到 设置 → Agent 检查 Claude Code、Codex 装好、登录了没有：Claude Code 随 agent-loft 一起安装，只需在服务端终端里登录；Codex 可以点「直接在服务器上安装」。设置 → 系统 里能看到服务端版本，有新版本时点「升级」即可（`npm install -g agent-loft@latest`，以系统服务运行时会自动重启，打开的页面会自动刷新）。

在外面只用飞书的话不需要任何网络配置（机器人由服务端主动连向飞书）。在外面用网页、系统推送和语音输入需要 HTTPS，见下面的「安全」和[产品介绍里的「从外网访问」](docs/产品介绍.md#从外网访问)。

### 桌面端（macOS / Windows / Linux）

到 [Releases](https://github.com/qijieinnet/agent-loft/releases) 下载 `desktop-v*` 里对应的安装包：

- **macOS**：对应芯片的 DMG（Apple 芯片选 arm64，Intel 选 x64），拖进「应用程序」。还没有 Apple 开发者签名，第一次打开如果提示无法验证，到 系统设置 → 隐私与安全性 里点「仍要打开」。
- **Windows**：`Agent-Loft-Setup-*-x64.exe`，装在用户目录里，不用管理员权限。没有代码签名，SmartScreen 拦的话点「更多信息 → 仍要运行」。
- **Linux**：Debian / Ubuntu 用 deb（`sudo apt install ./agent-loft-desktop_*_amd64.deb`），其他发行版用 AppImage（需要 libfuse2）；ARM 选 arm64。App 内一键更新只支持 AppImage。GNOME 要装 AppIndicator 扩展才看得到托盘图标。

下面以 macOS 为例，Windows / Linux 上「菜单栏」是托盘、`⌘` 是 `Ctrl`：

- 同时连多台服务器，顶部标签栏切换、拖动排序；每台各自登录，切走了也在后台连着，回复完成、需要授权时弹系统通知，程序坞图标显示未读数。
- 菜单栏图标：悬停看各服务器的 Claude / Codex 额度、待处理和运行中的会话；双击打开主窗口。同一个账号的额度只查一次。（Windows 上点托盘图标弹出；Linux 上在托盘菜单里点「额度和待处理」。）
- 支持前面挡着 Cloudflare Access 的服务器：验证页直接在窗口里完成，过期会提醒；也可以配 Service Token 免验证。
- 首次打开可以选「这台 Mac 也作为服务端」：一键在终端里安装 agent-loft（没有 Node.js 会先用 Homebrew 装）并开机自启，装好自动连上。Linux 上一样（需要先装好 Node.js 22+，开机自启用 systemd 用户服务）；Windows 上服务端还没有开机自启，可以在 WSL 里装，桌面端会自动检测到 `127.0.0.1` 上的它。可选开启「本机有会话在跑时不休眠」。
- 设置（`⌘,`）的服务器列表里展开某台服务器，能看它的 Agent 环境和版本，有新版本时点「升级服务端」；桌面端自己的更新在同一页的「更新」里点「更新并重启」。

桌面端只是个壳（代码在 `desktop/`），服务端照常用 npm 安装和升级。

桌面端一键安装的服务端放在 `~/.local`，无需管理员权限，也不修改 npm 的全局配置。如果旧版桌面端安装时出现 `EACCES /usr/local/lib/node_modules/agent-loft`，可以先在终端执行：

```bash
npm install -g --prefix "$HOME/.local" agent-loft
PATH="$HOME/.local/bin:$PATH" "$HOME/.local/bin/agent-loft" service install
```

第一条成功后再执行第二条，然后重新打开桌面端，选择连接本机服务端即可。需要 Node.js 22 以上。

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
| `agent-loft passwd [新密码] [--user 用户名]` | 重置 Web 登录密码（默认是最早的管理员），他的设备全部下线 |
| `agent-loft user list \| add <用户名> [--admin] \| passwd <用户名> \| role <用户名> admin\|member \| disable \| enable \| remove` | 管理 Web 登录用户（设置 → 用户 里也能做） |
| `agent-loft service install \| uninstall \| restart \| status` | 开机自启 |
| `agent-loft doctor` | 体检 |

`aloft` 是 `agent-loft` 的简写。

聊天里的命令（飞书和 Web 通用；Web 输入框打 `/` 会弹出命令补全，飞书里打 `/` 会弹出机器人的指令面板（agent-loft 自动注册，约 5～8 分钟生效；只发一个 `/` 也会回一张可点击的命令卡片），顺序和显示项在 设置 → 命令 里调整）：`/new` `/fork` `/sessions [all]` `/resume <id>` `/model [名称]` `/effort <程度>` `/agent [名称]`（或者直接发 `/claude`、`/codex`）`/stop` `/cd <目录>` `/pwd` `/status` `/autoedit [on|off]` `/approve <id> allow-once|allow-always|allow-session|deny` `/chat` `/work` `/help`；只在飞书里有的：`/web` `/detach` `/bind <绑定码>`

自定义命令：设置 → 命令 → 「添加命令」，填命令名、说明和一段提示词，之后发 `/命令名 参数` 就会把这段提示词发给 agent（提示词里的 `$ARGUMENTS` 换成参数，没写就把参数接在后面）。按 agent 分开存，可以编辑、删除，也会同步到飞书指令面板。

## 安全

这个服务能让 agent 在你的机器上执行命令，等于一个远程 shell。

- Web 登录密码用 scrypt 哈希保存。首次建管理员必须用启动日志里的一次性设置码，防止「谁先打开页面谁就成了主人」。
- 多用户只隔开**界面上**的东西：会话列表、授权 / 提问卡、通知、记忆、`/sessions` 能列出和恢复的 agent 会话；设置、飞书机器人和飞书会话只给管理员（绑定了账号的飞书私聊除外，它归绑定的人）；会落盘、对所有人生效的「总是允许」（Claude 的总是允许名单、Codex 的 execpolicy）只有管理员能点。**它不是安全边界**：所有 agent 都以同一个系统用户运行，任何用户都能让 agent 读到这台机器上的文件（别人的对话记录、配置里的密钥），用的也是同一个 Claude / Codex 订阅。只给信任的人开账号；要真正隔离，就每人用自己的系统用户各跑一份 agent-loft。
- 从老版本升级：原来的登录密码自动变成管理员 `admin`，已登录的设备不用重新登录。
- 登录态通过 HttpOnly cookie 保存，服务端只存它的哈希。同一 IP 连续输错 5 次锁 15 分钟。所有写请求和 WebSocket 都校验 Origin。页面开启了严格的 CSP。
- 暴露到公网时，只通过 HTTPS 反向代理（比如 Lucky）或 Cloudflare Tunnel 访问，并把不在本机的反代 IP 加进 `web.trustedProxies`（只有从这些地址来的连接才采信 `X-Forwarded-*`）。不要直接把 8800 端口映射出去。局域网访问可以在 设置 → 系统 → 网络访问 里关掉。
- 审批超时一律按拒绝处理。Codex 默认沙箱为 `workspace-write`，不会因为 `~/.codex/config.toml` 里配了 `never` 或 `danger-full-access` 就绕过审批。
- agent 子进程拿不到本服务自己的凭据（`FEISHU_*`、`AGENT_LOFT_*` 等环境变量会被剔除）。
- 记忆存在 `data/memory/<用户 id>.json`，聊天记录索引在 `data/history/<用户 id>.jsonl`。记给谁由 agent-loft 在拉起记忆工具时定死（工具参数里没有用户），模型想写别人的记忆也写不了；但和多用户一样不是安全边界：工作模式下 agent 能读到这些文件。聊天模式没有读写本机文件的工具，网页里的提示注入也骗不走本机文件。

## 结构

```
src/
  core/            与渠道、agent 都无关的中枢
    hub.ts         会话调度：事件广播、命令、切 agent / 模型 / 目录
    interactions.ts 审批与提问：一个请求，多个渠道都能处理
    store.ts       会话持久化（每个 agent 的会话 id 各自保存）
    config.ts      配置（Web 可改，改完热加载）
    users.ts       Web 登录用户和归属规则（谁能看到哪条会话）
    memory.ts      记忆的存储和注入系统提示的那段文字；personal.ts 定记忆用谁的
    chat-history.ts 聊天记录索引（每人一个 JSONL）和关键词搜索
    memory-curator.ts 录入聊天、回填已有对话、聊完后自动整理记忆
    feishu-links.ts 飞书账号 ↔ 用户的绑定和绑定码
    chat-mode.ts   聊天模式告诉 agent 的话（Claude 换系统提示，Codex 附在消息后面）
    pairing.ts uploads.ts commands.ts …
  mcp/
    memory-server.ts 记忆工具（remember / forget / search_past_chats）的 stdio MCP 服务，两个 agent 共用
  agents/
    claude/        Claude Agent SDK 驱动
    codex/         codex app-server 驱动
  channels/
    feishu/        飞书：一个 FeishuBot 对应一个机器人，支持多个
    web/           HTTP + WebSocket + 鉴权
web/               前端（原生 JS，不需要构建）
desktop/           桌面端（Electron 外壳，macOS / Windows / Linux）
docs/              产品介绍和截图
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
