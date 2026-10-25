// 远程桌面：把这台机器的图形桌面通过 VNC 给到网页（noVNC）。agent-loft 只做两件事：
//   - 找到 VNC 服务：Linux 上按需起一个 x11vnc 共享当前桌面（只听 127.0.0.1、随机端口、每次随机密码），
//     没人连着 keepAliveMin 分钟后停掉；或者用配置里的现成 VNC 服务（macOS 的屏幕共享）。
//   - 把页面的 WebSocket 原样转给它（见 channels/web/desktop.ts）。画面编码、鼠标键盘、剪贴板都是 VNC 协议自己的。
//
// 这台机器没有图形桌面（服务器、NAS）时远程桌面不可用，远程控制里就只有终端。
// 权限和终端一样（canUseRemote）：拿到桌面就能以登录桌面的那个人的身份做任何事。
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { home } from "../home.js";
import { config } from "./config.js";
import { canUseRemote, type User } from "./users.js";

export function canUseDesktop(user: Pick<User, "role" | "disabled" | "remote"> | undefined): boolean {
  return config().remote.desktop && canUseRemote(user);
}

// ---------- 找桌面 ----------

function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).concat(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"])) {
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // 下一个
    }
  }
  return undefined;
}

const X_SOCKETS = "/tmp/.X11-unix";

/** 现在有哪些 X 显示（:0、:1 …），按编号排 */
function xDisplays(): string[] {
  try {
    return fs
      .readdirSync(X_SOCKETS)
      .map((f) => /^X(\d+)$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort((a, b) => Number(a) - Number(b))
      .map((n) => `:${n}`);
  } catch {
    return [];
  }
}

/**
 * 用哪个显示：配置里写了就用它；否则环境变量里的 DISPLAY（前台运行时）；
 * 再不然取编号最大的那个 —— gdm 的登录界面通常是 :0，登录后的桌面排在后面。
 */
function pickDisplay(): string | undefined {
  const all = xDisplays();
  const wanted = config().remote.display.trim();
  if (wanted) return all.includes(wanted.replace(/\.\d$/, "")) ? wanted : undefined;
  const env = process.env.DISPLAY?.trim();
  if (env && all.includes(env.replace(/\.\d$/, ""))) return env;
  return all[all.length - 1];
}

/** X 的授权文件：系统服务下没有 XAUTHORITY 环境变量，按常见位置找；都没有交给 x11vnc 自己猜 */
function xAuthority(): string {
  const uid = os.userInfo().uid;
  const candidates = [process.env.XAUTHORITY, `/run/user/${uid}/gdm/Xauthority`, path.join(os.homedir(), ".Xauthority")];
  return candidates.find((f): f is string => !!f && fs.existsSync(f)) ?? "guess";
}

export type DesktopStatus = { available: boolean; reason?: string; source: "auto" | "vnc"; display?: string };

/** 远程桌面能不能用。不能用时 reason 写给管理员看（成员看到的只是「没有桌面」） */
export function desktopAvailability(): DesktopStatus {
  const cfg = config().remote;
  if (cfg.desktopSource === "vnc") return { available: true, source: "vnc" };
  if (process.platform !== "linux") {
    return {
      available: false,
      source: "auto",
      reason:
        process.platform === "darwin"
          ? "macOS 上请改用「已有的 VNC 服务」：打开 系统设置 → 通用 → 共享 → 屏幕共享，在「电脑设置」里允许 VNC 用密码控制，再把密码填到这里"
          : "这个系统上没法自动共享桌面，改用「已有的 VNC 服务」",
    };
  }
  const display = pickDisplay();
  if (!display) {
    return {
      available: false,
      source: "auto",
      reason: cfg.display ? `找不到显示 ${cfg.display}` : "这台机器没有图形桌面（没有运行中的 X 显示）。Wayland 桌面也共享不了，登录时选「Xorg」会话",
    };
  }
  if (!which("x11vnc")) return { available: false, source: "auto", display, reason: "没装 x11vnc：sudo apt install x11vnc（或 dnf install x11vnc）" };
  return { available: true, source: "auto", display };
}

// ---------- x11vnc ----------

type Vnc = { proc: ChildProcess; port: number; password: string; display: string; ready: Promise<void> };

let vnc: Vnc | null = null;
/** 正在起 x11vnc（找空闲端口是异步的）：同时来的几个请求等同一个，别起两份 */
let starting: Promise<Vnc> | null = null;
/** 每停一次加一：起到一半时设置改了（停过了），起好的这份就不要了 */
let generation = 0;
/** 连着桌面的页面数：到 0 开始计时，keepAliveMin 分钟后停掉 x11vnc */
let viewers = 0;
let idleTimer: NodeJS.Timeout | null = null;
export const desktopEvents = new EventEmitter<{ stopped: [] }>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 上一次 agent-loft 被强杀（没机会收尾）时留下的 x11vnc：按记下的 pid 停掉 */
function killStale(runDir: string): void {
  const pidFile = path.join(runDir, "x11vnc.pid");
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return;
  }
  fs.rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    // 只认我们自己起的那种：命令行里有 x11vnc 和我们的 run 目录（pid 可能已经被别的进程复用了）
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (cmdline.includes("x11vnc") && cmdline.includes(runDir)) process.kill(pid);
  } catch {
    // 已经没了
  }
}

async function startX11vnc(display: string): Promise<Vnc> {
  const runDir = path.join(home, "run");
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  killStale(runDir);
  const port = await freePort();
  // VNC 密码最多 8 个字符。只在本机能连，又是每次新起的，够了
  const password = crypto.randomBytes(6).toString("base64url").slice(0, 8);
  const pwFile = path.join(runDir, `x11vnc-${crypto.randomBytes(4).toString("hex")}.pw`);
  // 密码放文件里（命令行参数别的用户用 ps 就能看到），x11vnc 读完就删（rm: 前缀）
  fs.writeFileSync(pwFile, `${password}\n`, { mode: 0o600 });
  const args = [
    "-display", display,
    "-auth", xAuthority(),
    "-localhost",
    "-rfbport", String(port),
    "-passwdfile", `rm:${pwFile}`,
    "-forever",
    "-shared",
    "-xkb",
    "-noxdamage",
    "-quiet",
  ];
  const proc = spawn(which("x11vnc")!, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (proc.pid) fs.writeFileSync(path.join(runDir, "x11vnc.pid"), String(proc.pid));
  let stderr = "";
  proc.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("x11vnc 10 秒内没有启动起来"));
    }, 10_000);
    // 起不来（没权限执行之类）：spawn 自己报错，不会有 exit
    proc.on("error", (err) => {
      clearTimeout(timer);
      fs.rmSync(pwFile, { force: true });
      reject(new Error(`x11vnc 起不来：${err.message}`));
    });
    // 准备好了会在标准输出打一行 PORT=xxxx
    proc.stdout!.on("data", (d: Buffer) => {
      if (/PORT=\d+/.test(d.toString())) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      fs.rmSync(pwFile, { force: true });
      const why = stderr.split("\n").find((l) => /fail|error|unable|cannot|refused/i.test(l))?.replace(/^\S+ \S+ /, "");
      reject(new Error(`x11vnc 退出了（${code}）${why ? `：${why}` : ""}`));
    });
  });
  const v: Vnc = { proc, port, password, display, ready };
  proc.on("exit", () => {
    // 只删自己的：可能已经换上新的那份、pid 文件里记的是它
    const pidFile = path.join(runDir, "x11vnc.pid");
    try {
      if (fs.readFileSync(pidFile, "utf8").trim() === String(proc.pid)) fs.rmSync(pidFile, { force: true });
    } catch {
      // 没有就算了
    }
    if (vnc !== v) return;
    vnc = null;
    console.log("[桌面] x11vnc 已停止");
    desktopEvents.emit("stopped");
  });
  ready.then(() => console.log(`[桌面] 已在 ${display} 上起 x11vnc（127.0.0.1:${port}）`), () => {});
  return v;
}

export type DesktopTarget = { host: string; port: number; password: string };

/** 要连桌面了：拿到 VNC 服务的地址和密码，必要时先把 x11vnc 起来 */
export async function desktopTarget(): Promise<DesktopTarget> {
  const status = desktopAvailability();
  if (!status.available) throw new Error(status.reason ?? "这台机器上没有可用的桌面");
  const cfg = config().remote;
  if (status.source === "vnc") return { host: cfg.vncHost, port: cfg.vncPort, password: cfg.vncPassword };
  // 换了显示（配置改了）：旧的停掉
  if (vnc && vnc.display !== status.display) stopDesktop();
  const gen = generation;
  if (!vnc) {
    starting ??= startX11vnc(status.display!).finally(() => (starting = null));
    const started = await starting;
    // 等的这会儿里被停过（设置改了、服务在停）：这一份也不要了
    if (gen !== generation) {
      started.proc.kill();
      throw new Error("远程桌面的设置刚改过，再连一次");
    }
    vnc ??= started;
    if (vnc !== started) started.proc.kill();
  }
  const current = vnc;
  try {
    await current.ready;
  } catch (err) {
    if (vnc === current) vnc = null;
    // 没起好就被停了（设置改了）：说清楚，别让人以为 x11vnc 坏了
    if (gen !== generation) throw new Error("远程桌面的设置刚改过，再连一次");
    throw err;
  }
  armIdle();
  return { host: "127.0.0.1", port: current.port, password: current.password };
}

/** 页面连上 / 断开桌面：没人连着了就开始计时 */
export function desktopViewer(delta: 1 | -1): void {
  viewers = Math.max(0, viewers + delta);
  armIdle();
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (viewers > 0 || !vnc) return;
  idleTimer = setTimeout(() => stopDesktop(), Math.max(1, config().remote.keepAliveMin) * 60_000);
  idleTimer.unref();
}

export function stopDesktop(): void {
  generation++;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const v = vnc;
  if (!v) return;
  vnc = null;
  v.proc.kill();
  console.log("[桌面] 已停掉 x11vnc");
  desktopEvents.emit("stopped");
}

/** 是不是我们自己起的 x11vnc 在跑（给测试和状态页用） */
export function desktopRunning(): boolean {
  return !!vnc;
}
