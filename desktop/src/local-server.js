// 本机服务端：桌面端不带服务端，只负责「检测 / 一键安装 / 重启 / 停止」这台电脑上的 agent-loft。
//
// 安装走和命令行完全一样的路：npm install -g agent-loft + agent-loft service install
// （macOS 是 launchd，Linux 是 systemd 用户服务，开机自启）。Windows 上服务端还没有开机自启，
// 只能检测、连接已经在跑的（比如 WSL 里的）。
// 退出桌面端不影响它，手机、飞书照常能用；升级由服务端自己做（设置里「升级」，或桌面端里点）。
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAC = process.platform === "darwin";
const LINUX = process.platform === "linux";
/** agent-loft service install 用的 launchd 标签 / systemd 单元名 */
const LABEL = "com.agent-loft";
const UNIT = "agent-loft";
/** 开机自启的服务定义文件：有它就算「装了服务」 */
const serviceFile = MAC
  ? path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`)
  : path.join(os.homedir(), ".config/systemd/user", `${UNIT}.service`);
const uid = process.getuid?.() ?? 0;

/** 这个平台上不能一键安装 / 重启 / 停止本机服务端的原因；能的话是 null */
export function localUnsupported() {
  if (MAC || LINUX) return null;
  return "Windows 上还不能一键安装本机服务端（服务端的开机自启目前只支持 macOS 和 Linux）。可以在 WSL 里执行 npm install -g agent-loft && agent-loft service install，这里会自动检测到它。";
}

/** 和服务端 src/home.ts 的判断一致：AGENT_LOFT_HOME 优先，默认 ~/.agent-loft，只有旧的 ~/.im-agent 时沿用旧的 */
export function serverHome() {
  const explicit = process.env.AGENT_LOFT_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const current = path.join(os.homedir(), ".agent-loft");
  const legacy = path.join(os.homedir(), ".im-agent");
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
}

export function localPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(serverHome(), "config.json"), "utf8"));
    const port = Number(cfg?.web?.port);
    return Number.isInteger(port) && port > 0 ? port : 8800;
  } catch {
    return 8800;
  }
}

export function localUrl() {
  return `http://127.0.0.1:${localPort()}`;
}

/** 首次设置用的一次性设置码（服务端还没设密码时才有） */
export function readSetupToken() {
  try {
    return fs.readFileSync(path.join(serverHome(), "data/web-setup-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function ping() {
  try {
    const res = await fetch(`${localUrl()}/api/me`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ service: boolean, running: boolean, needsSetup: boolean, url: string, logs: string }>}
 *   service：装了开机自启（launchd / systemd）；running：端口上有 agent-loft 在响应
 */
export async function localStatus() {
  const me = await ping();
  return {
    service: !localUnsupported() && fs.existsSync(serviceFile),
    running: !!me,
    needsSetup: !!me?.needsSetup,
    url: localUrl(),
    logs: path.join(serverHome(), "logs"),
  };
}

export async function waitUntilUp(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const me = await ping();
    if (me) return me;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/**
 * 给子进程（终端、systemctl、xdg-open）用的环境变量（Linux）：
 *   - Electron 设了 CHROME_DESKTOP：带到终端里，登录时从终端拉起的 Chrome 会把自己当成本 App；
 *   - 从 AppImage 启动时，它的启动脚本把自己的目录塞到了 PATH、LD_LIBRARY_PATH 等的最前面：
 *     不去掉的话终端里的程序会加载 AppImage 里的库，命令也可能找到 AppImage 里的程序。
 */
export function hostEnv() {
  const env = { ...process.env };
  if (!LINUX) return env;
  delete env.CHROME_DESKTOP;
  const dir = env.APPDIR;
  if (!dir || !env.APPIMAGE) return env;
  for (const key of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"]) {
    if (env[key] === undefined) continue;
    const kept = env[key].split(":").filter((p) => p && !p.startsWith(dir));
    if (kept.length) env[key] = kept.join(":");
    else delete env[key];
  }
  for (const key of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[key];
  return env;
}

function launchctl(...args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

function systemctl(...args) {
  return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: hostEnv() });
}

/** 重启（没在跑就是启动） */
export function restartLocal() {
  const problem = localUnsupported();
  if (problem) throw new Error(problem);
  const r = MAC ? launchctl("kickstart", "-k", `gui/${uid}/${LABEL}`) : systemctl("restart", UNIT);
  if (r.error) throw new Error(`重启失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`重启失败：${(r.stderr || r.stdout).trim() || "服务没有装"}`);
}

/** 停掉并取消开机自启（和 agent-loft service uninstall 一样；~/.agent-loft 里的东西都不动） */
export function uninstallLocal() {
  const problem = localUnsupported();
  if (problem) throw new Error(problem);
  if (MAC) {
    launchctl("bootout", `gui/${uid}/${LABEL}`);
    fs.rmSync(serviceFile, { force: true });
  } else {
    systemctl("disable", "--now", UNIT);
    fs.rmSync(serviceFile, { force: true });
    systemctl("daemon-reload");
  }
}

/** 打开日志目录。Linux 上自己调 xdg-open，带干净的环境（见 hostEnv），文件管理器才不会加载 AppImage 里的库 */
export function openLogs(dir) {
  if (!LINUX) return null;
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn("xdg-open", [dir], { detached: true, stdio: "ignore", env: hostEnv() });
  child.once("error", () => {});
  child.unref();
  return true;
}

// ---------- 在终端里执行 ----------

/**
 * Linux 上能用的终端，按常见程度排。每项是「怎么让它执行一条命令」：命令和参数 → 终端的参数。
 * $TERMINAL 优先（用户自己指定的）。
 * @type {[string, (cmd: string[]) => string[]][]}
 */
const LINUX_TERMINALS = [
  ["ptyxis", (cmd) => ["--new-window", "--", ...cmd]],
  ["gnome-terminal", (cmd) => ["--", ...cmd]],
  ["kgx", (cmd) => ["--", ...cmd]],
  ["konsole", (cmd) => ["-e", ...cmd]],
  ["xfce4-terminal", (cmd) => ["-x", ...cmd]],
  ["mate-terminal", (cmd) => ["-x", ...cmd]],
  // tilix 的 -e 只收一个字符串
  ["tilix", (cmd) => ["-e", cmd.map(shQuote).join(" ")]],
  ["kitty", (cmd) => cmd],
  ["alacritty", (cmd) => ["-e", ...cmd]],
  ["wezterm", (cmd) => ["start", "--", ...cmd]],
  ["foot", (cmd) => cmd],
  ["x-terminal-emulator", (cmd) => ["-e", ...cmd]],
  ["xterm", (cmd) => ["-e", ...cmd]],
];

/** 单引号包起来给 shell 当一个参数 */
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function which(bin) {
  if (bin.includes("/")) return fs.existsSync(bin) ? bin : null;
  for (const dir of (hostEnv().PATH || "/usr/bin:/bin").split(":")) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // 下一个目录
    }
  }
  return null;
}

/** @returns {[string, (cmd: string[]) => string[]] | null} */
function linuxTerminal() {
  const own = process.env.TERMINAL?.trim();
  const ownBin = own && which(own);
  if (ownBin) {
    const known = LINUX_TERMINALS.find(([name]) => name === path.basename(ownBin));
    return [ownBin, known ? known[1] : (cmd) => ["-e", ...cmd]];
  }
  for (const [name, args] of LINUX_TERMINALS) {
    const bin = which(name);
    if (bin) return [bin, args];
  }
  return null;
}

/** 让终端执行一段脚本：写成文件交给终端打开，命令和输出用户都看得见 */
export function runInTerminal(name, script) {
  const done = `echo\necho "完成后回到 Agent Loft。按回车关闭这个窗口。"\nread`;
  if (MAC) {
    // .command 文件交给「终端」打开
    const file = path.join(os.tmpdir(), `agent-loft-${name}.command`);
    fs.writeFileSync(file, `#!/bin/zsh -il\n${script}\n${done}\n`, { mode: 0o755 });
    return new Promise((resolve, reject) => {
      execFile("open", ["-a", "Terminal", file], (err) => (err ? reject(err) : resolve()));
    });
  }
  if (!LINUX) return Promise.reject(new Error("Windows 上请在运行 agent-loft 的那个终端里（比如 WSL）自己执行登录命令"));
  const term = linuxTerminal();
  if (!term) return Promise.reject(new Error("没找到可用的终端程序（gnome-terminal、konsole、xterm…），可以设置环境变量 TERMINAL 指定一个"));
  // 用登录 + 交互的 shell 跑，nvm 之类写在 ~/.profile、~/.bashrc / ~/.zshrc 里的 PATH 才生效。
  // 脚本放在子 shell 里：中途 exit 也会停在「按回车关闭」，不然多数终端命令一结束就关窗口，报错来不及看
  const userShell = path.basename(process.env.SHELL ?? "");
  const sh = userShell === "zsh" || userShell === "bash" ? userShell : "bash";
  const file = path.join(os.tmpdir(), `agent-loft-${name}.sh`);
  fs.writeFileSync(file, `(\n${script}\n)\n${done}\n`, { mode: 0o755 });
  const [bin, args] = term;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args([sh, "-il", file]), { detached: true, stdio: "ignore", env: hostEnv() });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** 一键安装本机服务端：没有 Node 22+ 就先用 Homebrew 装（Linux 上提示怎么装），再装 agent-loft、注册开机自启 */
export function installLocalInTerminal() {
  const problem = localUnsupported();
  if (problem) return Promise.reject(new Error(problem));
  if (LINUX) {
    return runInTerminal(
      "install-server",
      `need_node() {
  command -v node >/dev/null 2>&1 || return 0
  [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]
}
if need_node; then
  echo "需要 Node.js 22 以上。"
  echo "推荐用 nvm 安装（https://github.com/nvm-sh/nvm）：装好 nvm 后执行 nvm install 22；"
  echo "也可以用发行版的包管理器，或者到 https://nodejs.org 下载。装好后回到 Agent Loft 再点「安装」。"
  exit 1
fi
echo "安装 agent-loft…"; echo
npm install -g agent-loft || {
  echo
  echo "安装失败。如果上面提示 EACCES（没有权限），说明 Node 装在系统目录里，"
  echo "建议改用 nvm 装的 Node 后重试，不要用 sudo npm install -g。"
  exit 1
}
echo; echo "注册开机自启（systemd 用户服务）…"; echo
agent-loft service install`,
    );
  }
  return runInTerminal(
    "install-server",
    `need_node() {
  command -v node >/dev/null 2>&1 || return 0
  [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]
}
if need_node; then
  if command -v brew >/dev/null 2>&1; then
    echo "需要 Node.js 22 以上，用 Homebrew 安装…"; echo
    brew install node || exit 1
  else
    echo "需要 Node.js 22 以上。"
    echo "先安装 Homebrew（https://brew.sh）或者到 https://nodejs.org 下载安装 Node.js，再回到 Agent Loft 点「安装」。"
    exit 1
  fi
fi
echo "安装 agent-loft…"; echo
npm install -g agent-loft || {
  echo
  echo "安装失败。如果上面提示 EACCES（没有权限），说明 Node 装在系统目录里，"
  echo "建议改用 Homebrew 的 Node（brew install node）后重试。"
  exit 1
}
echo; echo "注册开机自启…"; echo
agent-loft service install`,
  );
}
