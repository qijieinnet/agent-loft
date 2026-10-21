// 本机服务端：桌面端不带服务端，只负责「检测 / 一键安装 / 重启 / 停止」这台 Mac 上的 agent-loft。
//
// 安装走和命令行完全一样的路：npm install -g agent-loft + agent-loft service install（launchd 开机自启）。
// 退出桌面端不影响它，手机、飞书照常能用；升级由服务端自己做（设置里「升级」，或桌面端里点）。
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** agent-loft service install 用的 launchd 标签 */
const LABEL = "com.agent-loft";
const plistPath = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const uid = process.getuid?.() ?? 0;

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
 *   service：装了开机自启（launchd）；running：端口上有 agent-loft 在响应
 */
export async function localStatus() {
  const me = await ping();
  return {
    service: fs.existsSync(plistPath),
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

function launchctl(...args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

export function restartLocal() {
  const r = launchctl("kickstart", "-k", `gui/${uid}/${LABEL}`);
  if (r.status !== 0) throw new Error(`重启失败：${(r.stderr || r.stdout).trim() || "服务没有装"}`);
}

/** 停掉并取消开机自启（和 agent-loft service uninstall 一样；~/.agent-loft 里的东西都不动） */
export function uninstallLocal() {
  launchctl("bootout", `gui/${uid}/${LABEL}`);
  fs.rmSync(plistPath, { force: true });
}

/** 让「终端」执行一段脚本：写成 .command 文件交给终端打开，命令和输出用户都看得见 */
export function runInTerminal(name, script) {
  const file = path.join(os.tmpdir(), `agent-loft-${name}.command`);
  fs.writeFileSync(file, `#!/bin/zsh -il\n${script}\necho\necho "完成后回到 Agent Loft。按回车关闭这个窗口。"\nread\n`, { mode: 0o755 });
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "Terminal", file], (err) => (err ? reject(err) : resolve()));
  });
}

/** 一键安装本机服务端：没有 Node 22+ 就先用 Homebrew 装，再装 agent-loft、注册开机自启 */
export function installLocalInTerminal() {
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
