// 桌面端自己的「系统」状态：本机服务端、桌面端更新、Agent 登录。
// 状态变了 emit("change")，主进程合进快照广播给侧栏和菜单栏面板。
import { app, Notification, shell } from "electron";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { installLocalInTerminal, localStatus, localUnsupported, openLogs, restartLocal, runInTerminal, stopLocal, uninstallLocal, waitUntilUp } from "./local-server.js";
import { store } from "./store.js";
import { canSelfUpdate, checkForUpdate, installUpdate } from "./updater.js";

export const system = new EventEmitter();

const state = {
  /** @type {Awaited<ReturnType<typeof localStatus>> | null} */
  local: null,
  /** 正在做的本机服务端操作：install / restart / stop / uninstall */
  /** @type {string | null} */
  localBusy: null,
  /** @type {string | null} */
  localError: null,
  update: {
    checking: false,
    /** @type {Awaited<ReturnType<typeof checkForUpdate>>} */
    available: null,
    /** @type {string | null} */
    error: null,
    /** @type {number | null} */
    checkedAt: null,
    /** 正在下载安装：0~1 */
    /** @type {number | null} */
    installing: null,
  },
};

function changed() {
  system.emit("change");
}

export function systemState() {
  return {
    local: state.local,
    localBusy: state.localBusy,
    localError: state.localError,
    /** 这个平台不能一键安装 / 重启 / 停止本机服务端的原因（Windows），能的话是 null */
    localUnsupported: localUnsupported(),
    update: state.update,
    selfUpdateProblem: canSelfUpdate(),
    packaged: app.isPackaged,
  };
}

// ---------- 本机服务端 ----------

export async function refreshLocal() {
  state.local = await localStatus();
  changed();
  return state.local;
}

async function busy(action, fn) {
  if (state.localBusy) throw new Error("上一个操作还没完成");
  state.localBusy = action;
  state.localError = null;
  changed();
  try {
    return await fn();
  } catch (err) {
    state.localError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    state.localBusy = null;
    await refreshLocal();
  }
}

export const local = {
  /** 在终端里一键安装（最多 15 分钟），脚本成功后再等服务启动 */
  install: () =>
    busy("install", async () => {
      await installLocalInTerminal();
      if (!(await waitUntilUp(60_000))) throw new Error("安装已完成，但服务端没有启动，请查看终端输出和服务端日志");
    }),
  restart: () =>
    busy("restart", async () => {
      restartLocal();
      if (!(await waitUntilUp(60_000))) throw new Error("服务端重启后没有响应，看一下日志");
    }),
  stop: () =>
    busy("stop", async () => {
      stopLocal();
      // bootout 返回时进程可能还没退干净：等端口不再响应，状态才准
      const until = Date.now() + 10_000;
      while (Date.now() < until && (await localStatus()).running) await new Promise((r) => setTimeout(r, 500));
    }),
  uninstall: () => busy("uninstall", async () => uninstallLocal()),
  logs: () => {
    const dir = state.local?.logs;
    if (!dir) return;
    if (!openLogs(dir)) return shell.openPath(dir);
  },
};

// ---------- Agent 登录（只在本机，打开终端；Windows 上不支持） ----------

/**
 * 在「终端」里登录。命令写死在这里，不执行服务器传来的命令；唯一用到的服务器数据是 SDK 自带的
 * claude 的路径（本机服务端报的），也要核对确实是磁盘上一个叫 claude 的文件。
 * @param {string | null} sdkClaude
 */
export function loginAgent(agent, sdkClaude) {
  if (agent === "codex") {
    return runInTerminal(
      "login-codex",
      `CODEX=$(command -v codex || ls /opt/homebrew/bin/codex /usr/local/bin/codex 2>/dev/null | head -1)
echo "接下来会打开浏览器，用 ChatGPT 账号登录 Codex。"; echo
"\${CODEX:-codex}" login`,
    );
  }
  if (agent === "claude") {
    const bundled = sdkClaude && path.basename(sdkClaude) === "claude" && fs.existsSync(sdkClaude) ? sdkClaude : null;
    const fallback = bundled ? `"${bundled.replace(/(["\\$`])/g, "\\$1")}"` : "claude";
    return runInTerminal(
      "login-claude",
      `BIN=claude
command -v claude >/dev/null 2>&1 || BIN=${fallback}
echo "接下来会打开 Claude Code。"
echo "进去后输入 /login，按提示在浏览器里登录，完成后输入 /exit。"; echo
"$BIN"`,
    );
  }
  throw new Error("不支持的操作");
}

// ---------- 桌面端更新 ----------

let updateTimer = null;

/** @param {{ manual?: boolean }} options 手动检查时结果直接显示在界面上，不弹通知 */
export async function checkUpdates({ manual = false } = {}) {
  if (state.update.checking) return state.update;
  state.update.checking = true;
  state.update.error = null;
  changed();
  try {
    state.update.available = await checkForUpdate();
    state.update.checkedAt = Date.now();
    const v = state.update.available?.version;
    // 同一个版本只主动提醒一次
    if (v && !manual && store.notifiedUpdate() !== v && Notification.isSupported()) {
      store.setNotifiedUpdate(v);
      const note = new Notification({ title: `Agent Loft ${v} 可以更新了`, body: "打开设置，点「更新并重启」。" });
      note.on("click", () => system.emit("show-update"));
      note.show();
    }
  } catch (err) {
    state.update.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.update.checking = false;
    changed();
  }
  return state.update;
}

/** 一键更新：下载、替换、重启。不能原地替换的，打开下载页 */
export async function applyUpdate(quit) {
  const u = state.update.available;
  if (!u || state.update.installing !== null) return;
  if (canSelfUpdate() || !u.pkg) {
    void shell.openExternal(u.download ?? u.url);
    return;
  }
  state.update.installing = 0;
  state.update.error = null;
  changed();
  let last = 0;
  try {
    await installUpdate(u, (p) => {
      state.update.installing = p;
      // 进度别刷得太勤
      if (p - last >= 0.02 || p === 1) {
        last = p;
        changed();
      }
    });
    quit();
  } catch (err) {
    state.update.installing = null;
    state.update.error = err instanceof Error ? err.message : String(err);
    changed();
  }
}

export function scheduleUpdates() {
  clearInterval(updateTimer);
  updateTimer = null;
  const { autoUpdate, updateCheckHours } = store.prefs();
  if (!autoUpdate || !app.isPackaged) return;
  updateTimer = setInterval(() => void checkUpdates(), updateCheckHours * 3600_000);
}
