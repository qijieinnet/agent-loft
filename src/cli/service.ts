// agent-im service install | uninstall | restart | status
//
// Linux 用 systemd 用户服务，macOS 用 launchd。只碰服务定义文件，不碰 ~/.agent-im 里的配置和会话。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { home, logsDir } from "../home.js";

const UNIT = "agent-im";
const LABEL = "com.agent-im";
const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/cli.js");

function unitPath(): string {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`)
    : path.join(os.homedir(), ".config/systemd/user", `${UNIT}.service`);
}

/** systemd 下 PATH 很短：把 node、claude、codex 所在目录都带上 */
function servicePath(): string {
  const dirs = new Set<string>([path.dirname(process.execPath)]);
  for (const bin of ["claude", "codex"]) {
    const found = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();
    if (found) dirs.add(path.dirname(found));
  }
  for (const d of (process.env.PATH ?? "").split(":")) if (d) dirs.add(d);
  return [...dirs].join(":");
}

function systemdUnit(): string {
  return `[Unit]
Description=agent-im（飞书 / Web ↔ Claude Code / Codex）
After=network-online.target
# 默认「10 秒内重启 5 次就永久放弃」，那正是崩溃循环最需要它别放弃的时候
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${process.execPath} ${entry} start
WorkingDirectory=${home}
StandardOutput=append:${path.join(logsDir, "out.log")}
StandardError=append:${path.join(logsDir, "err.log")}
Environment=PATH=${servicePath()}
Environment=AGENT_IM_HOME=${home}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function plist(): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(entry)}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${esc(home)}</string>
  <key>StandardOutPath</key><string>${esc(path.join(logsDir, "out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logsDir, "err.log"))}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${esc(servicePath())}</string>
    <key>AGENT_IM_HOME</key><string>${esc(home)}</string>
  </dict>
</dict></plist>
`;
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "inherit" });
}

const sub = process.argv[2] ?? "status";
fs.mkdirSync(logsDir, { recursive: true });

if (process.platform === "darwin") {
  const uid = process.getuid?.() ?? 0;
  if (sub === "install") {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), plist());
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    run("launchctl", ["bootstrap", `gui/${uid}`, unitPath()]);
    console.log(`已安装并启动。日志：${logsDir}`);
  } else if (sub === "uninstall") {
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    fs.rmSync(unitPath(), { force: true });
    console.log("已卸载");
  } else if (sub === "restart") {
    run("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]);
  } else {
    spawnSync("launchctl", ["print", `gui/${uid}/${LABEL}`], { stdio: "inherit" });
  }
} else {
  if (sub === "install") {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), systemdUnit());
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", UNIT]);
    console.log(`已安装并启动。日志：${logsDir}`);
    console.log("想在没登录时也运行：sudo loginctl enable-linger $USER");
  } else if (sub === "uninstall") {
    spawnSync("systemctl", ["--user", "disable", "--now", UNIT], { stdio: "inherit" });
    fs.rmSync(unitPath(), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    console.log("已卸载");
  } else if (sub === "restart") {
    run("systemctl", ["--user", "restart", UNIT]);
  } else {
    spawnSync("systemctl", ["--user", "status", UNIT, "--no-pager"], { stdio: "inherit" });
  }
}
