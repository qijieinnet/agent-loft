// 本机服务端：桌面端不带服务端，只负责「检测 / 一键安装 / 重启 / 停止」这台电脑上的 agent-loft。
//
// 安装用 npm --prefix ~/.local install -g agent-loft + ~/.local/bin/agent-loft service install
// （macOS 是 launchd，Linux 是 systemd 用户服务，开机自启）。Windows 上服务端还没有开机自启，
// 只能检测、连接已经在跑的（比如 WSL 里的）。
// 默认退出桌面端不影响它，手机、飞书照常能用；设置里开了「只在桌面端运行时运行」的话取消开机自启，
// 打开桌面端时启动、退出时停止（见 setLocalAutostart）。升级由服务端自己做（设置里「升级」，或桌面端里点）。
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
/** 装了开机自启的服务定义（launchd / systemd） */
export function localServiceInstalled() {
  return !localUnsupported() && fs.existsSync(serviceFile);
}

export async function localStatus() {
  const me = await ping();
  return {
    service: localServiceInstalled(),
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

/**
 * 开不开机自启（服务定义文件不动）。关掉用于「只随桌面端运行」：
 *   - macOS：launchctl disable，下次登录 launchd 不再加载它；已经加载的不受影响，KeepAlive 照样会把
 *     退出的进程拉回来（服务端升级完靠这个重启）。disable 是持久的，bootstrap 前要先 enable（见 restartLocal）；
 *   - Linux：systemctl --user disable，只去掉开机启动，start / stop 照常能用。
 */
export function setLocalAutostart(on) {
  const problem = localUnsupported();
  if (problem) throw new Error(problem);
  const r = MAC ? launchctl(on ? "enable" : "disable", `gui/${uid}/${LABEL}`) : systemctl(on ? "enable" : "disable", UNIT);
  if (r.error) throw new Error(`${on ? "打开" : "取消"}开机自启失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${on ? "打开" : "取消"}开机自启失败：${(r.stderr || r.stdout).trim()}`);
}

/**
 * 重启（没在跑就是启动）。macOS 上停止时把服务卸下了（见 stopLocal），先装回去再拉起来；
 * 被 disable 了（只随桌面端运行）的话 bootstrap 会失败，先 enable，装好后按 autostart 再关回去
 */
export function restartLocal({ autostart = true } = {}) {
  const problem = localUnsupported();
  if (problem) throw new Error(problem);
  if (MAC && launchctl("print", `gui/${uid}/${LABEL}`).status !== 0) {
    launchctl("enable", `gui/${uid}/${LABEL}`);
    const b = launchctl("bootstrap", `gui/${uid}`, serviceFile);
    if (!autostart) launchctl("disable", `gui/${uid}/${LABEL}`);
    if (b.error) throw new Error(`启动失败：${b.error.message}`);
    if (b.status !== 0) throw new Error(`启动失败：${(b.stderr || b.stdout).trim() || "服务没有装"}`);
  }
  const r = MAC ? launchctl("kickstart", "-k", `gui/${uid}/${LABEL}`) : systemctl("restart", UNIT);
  if (r.error) throw new Error(`重启失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`重启失败：${(r.stderr || r.stdout).trim() || "服务没有装"}`);
}

/**
 * 只停掉，不取消开机自启：服务定义文件留着，下次开机照样自动运行，点「运行」也能马上拉起来。
 * macOS 的服务配了 KeepAlive，单杀进程会被 launchd 拉回来，所以把服务从 launchd 卸下（bootout）
 */
export function stopLocal() {
  const problem = localUnsupported();
  if (problem) throw new Error(problem);
  const r = MAC ? launchctl("bootout", `gui/${uid}/${LABEL}`) : systemctl("stop", UNIT);
  if (r.error) throw new Error(`停止失败：${r.error.message}`);
  // macOS 上本来就没在 launchd 里（已经停了）也算停好了
  if (r.status !== 0 && !(MAC && launchctl("print", `gui/${uid}/${LABEL}`).status !== 0)) {
    throw new Error(`停止失败：${(r.stderr || r.stdout).trim()}`);
  }
}

/** 停掉并取消开机自启（和 agent-loft service uninstall 一样；npm 装的程序和 ~/.agent-loft 里的东西都不动） */
export function uninstallLocal() {
  const problem = localUnsupported();
  if (problem) throw new Error(problem);
  if (MAC) {
    launchctl("bootout", `gui/${uid}/${LABEL}`);
    fs.rmSync(serviceFile, { force: true });
    // 只随桌面端运行时留下的 disable 记录也清掉，不然以后执行 agent-loft service install 会 bootstrap 失败
    launchctl("enable", `gui/${uid}/${LABEL}`);
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
    fs.writeFileSync(file, `#!/bin/zsh -il\n(\n${script}\n)\n${done}\n`, { mode: 0o755 });
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

/** 安装到用户目录，不依赖 npm 的全局 prefix，也不修改用户的 npm / shell 配置。 */
export function localInstallScript(platform = process.platform) {
  const prepareNode = platform === "darwin" ? `
if need_node; then
  if command -v brew >/dev/null 2>&1; then
    echo "需要 Node.js 22.13 以上，用 Homebrew 安装…"; echo
    brew install node || exit 1
    # 系统旧 Node 可能仍排在 PATH 前面，明确选中刚安装的 Homebrew Node。
    NODE_PREFIX=$(brew --prefix node) || exit 1
    export PATH="$NODE_PREFIX/bin:$PATH"
  else
    echo "需要 Node.js 22.13 以上。"
    echo "先安装 Homebrew（https://brew.sh）或者到 https://nodejs.org 下载安装 Node.js，再回到 Agent Loft 点「安装」。"
    exit 1
  fi
fi` : "";
  return `need_node() {
  command -v node >/dev/null 2>&1 || return 0
  ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}
${prepareNode}
if need_node; then
  echo "需要 Node.js 22.13 以上。请安装或升级 Node.js 后回到 Agent Loft 再点「安装」。"
  exit 1
fi
command -v npm >/dev/null 2>&1 || { echo "没有找到 npm，请重新安装 Node.js。"; exit 1; }
INSTALL_PREFIX="$HOME/.local"
export PATH="$INSTALL_PREFIX/bin:$PATH"
echo "安装 agent-loft 到 $INSTALL_PREFIX…"; echo
npm install -g --prefix "$INSTALL_PREFIX" agent-loft || {
  echo
  echo "安装失败，请查看上面的 npm 错误，处理后回到 Agent Loft 重试。"
  exit 1
}
echo; echo "注册开机自启…"; echo
# 用本次安装的绝对路径，避免误用 PATH 中已有的其他版本。
"$INSTALL_PREFIX/bin/agent-loft" service install || exit 1`;
}

/** 在子 shell 退出时写入结果；提示等待回车的外层 shell 不影响安装状态。 */
export function trackedInstallScript(resultFile, script = localInstallScript()) {
  const report = `printf '%s\\n' "$?" > ${shQuote(resultFile)}`;
  return `trap ${shQuote(report)} EXIT
trap 'exit 130' HUP INT TERM
${script}`;
}

/** Terminal 的 open / spawn 只表示窗口打开了，安装结果要由脚本传回来。 */
export async function waitForInstallResult(resultFile, { timeoutMs = 15 * 60_000, pollMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let code;
    try {
      code = fs.readFileSync(resultFile, "utf8").trim();
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (code && /^\d+$/.test(code)) {
      if (Number(code) !== 0) throw new Error("本机服务端安装失败或已中断，请查看终端里的错误，处理后重试。");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("等待安装超时，请查看终端里的输出，确认安装进程已结束后重试。");
}

/** 等到安装脚本结束，再由调用方检查服务启动。每次安装用独立的结果文件。 */
export async function installLocalInTerminal() {
  const problem = localUnsupported();
  if (problem) throw new Error(problem);
  // 以前开过「只随桌面端运行」又卸载了的，launchd 里可能还留着 disable，service install 的 bootstrap 会失败
  if (MAC) launchctl("enable", `gui/${uid}/${LABEL}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loft-install-"));
  const resultFile = path.join(dir, "result");
  try {
    await runInTerminal("install-server", trackedInstallScript(resultFile));
    await waitForInstallResult(resultFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
