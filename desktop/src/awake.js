// 防休眠（做法参照 mac-awake）。几件事互相独立：
//   - 本机有会话在跑时不休眠（prefs.keepAwake）：只看本机服务端，远程服务器不管。
//   - 模式（prefs.awakeMode）：
//       system    跟随系统，只有上面那条会拦。
//       always    永不休眠。
//       scheduled 定时休眠：休眠时段外一直不休眠；进了时段就放开，并且在条件满足时主动让 Mac 睡下去
//                 （本机没有会话在跑；勾了「锁屏后才休眠」的还要屏幕已锁）。同一个时段只睡一次，
//                 睡过之后被叫醒不会再睡；发了指令没睡成隔几分钟再试，出了时段还没睡成就作罢，
//                 等下一个时段。时段结束不会把 Mac 叫醒。只在 macOS 上有。
//   - 合盖不休眠：系统级开关 pmset disablesleep，要管理员授权，桌面端退出、重启后都还在，
//     所以状态一律以系统实际值为准，不存在配置里。只在 macOS 上有。
//     它开着时整机都不睡：闲置不睡，pmset sleepnow 也被挡掉。所以第一次开关时顺带写一条 sudoers 规则，
//     只放行 pmset -a disablesleep 0 / 1 这两条命令，之后开关不用再输密码；定时休眠到点时先临时关掉它
//     再睡，醒来再打开。
//
// 拦休眠用 powerSaveBlocker 的 prevent-app-suspension（macOS 上就是 PreventUserIdleSystemSleep），
// 只拦闲置休眠，屏幕照常可以关；进程退出时系统自动回收，不会残留。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { powerMonitor, powerSaveBlocker } from "electron";

const isMac = process.platform === "darwin";

/** @typedef {{ id: string, enabled: boolean, start: number, length: number, days: number[] }} SleepWindow
 *   start：一天里的第几分钟开始；length：持续多少分钟（最长 24 小时，可以跨过午夜）；
 *   days：哪几天开始（0 = 周日 … 6 = 周六，和 Date#getDay 一样），7 天都选就是每天。 */

export const WINDOW_LENGTHS = [30, 60, 120, 180, 240, 360, 480, 600, 720];

/** @returns {SleepWindow} */
export function defaultWindow() {
  return { id: Math.random().toString(36).slice(2, 10), enabled: true, start: 23 * 60, length: 480, days: [0, 1, 2, 3, 4, 5, 6] };
}

/** 设置页传上来的时段列表规整一遍，坏的丢掉 */
export function normalizeWindows(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list.slice(0, 10)) {
    if (!w || typeof w !== "object") continue;
    const start = Math.round(Number(w.start));
    const length = Math.round(Number(w.length));
    if (!(start >= 0 && start < 24 * 60) || !(length >= 1 && length <= 24 * 60)) continue;
    const id = typeof w.id === "string" && /^[\w-]{1,32}$/.test(w.id) ? w.id : defaultWindow().id;
    const days = [...new Set((Array.isArray(w.days) ? w.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    out.push({ id, enabled: w.enabled !== false, start, length, days });
  }
  return out;
}

const runnable = (w) => w.enabled && w.days.length > 0;

/**
 * now 落在这个时段里的话，返回这一次时段的开始时间（毫秒），不在就是 null。
 * 跨午夜的时段要看前一天开始的那次，所以今天、昨天两个起点都试一下。
 */
export function currentDue(w, now = Date.now()) {
  if (!runnable(w)) return null;
  for (const back of [0, 1]) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    d.setHours(0, 0, 0, 0);
    if (!w.days.includes(d.getDay())) continue;
    const start = d.getTime() + w.start * 60_000;
    if (now >= start && now < start + w.length * 60_000) return start;
  }
  return null;
}

/** 屏幕锁了没有（锁屏、带密码的屏保、切到登录窗口都算）。Linux 上拿不到，当作没锁 */
function screenLocked() {
  try {
    return powerMonitor.getSystemIdleState(1) === "locked";
  } catch {
    return false;
  }
}

/** 立刻让 Mac 睡：pmset sleepnow 不用管理员权限 */
function sleepNow() {
  execFile("/usr/bin/pmset", ["sleepnow"], (err) => {
    if (err) execFile("/usr/bin/osascript", ["-e", 'tell application "System Events" to sleep'], () => {});
  });
}

// ---------- 合盖不休眠 ----------

const SUDOERS_FILE = "/etc/sudoers.d/agent-loft-pmset";
const lidCommand = (on) => ["/usr/bin/pmset", "-a", "disablesleep", on ? "1" : "0"];

/** 不弹密码框改 disablesleep：要先装过 sudoers 规则，没装就是 false */
function sudoLid(on) {
  return new Promise((resolve) => {
    execFile("/usr/bin/sudo", ["-n", ...lidCommand(on)], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

/** sudoers 规则装好了没有：sudo -n -l 只查不执行，没装会直接失败，不会弹密码 */
export function readLidSudo() {
  if (!isMac) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("/usr/bin/sudo", ["-n", "-l", ...lidCommand(false)], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

/**
 * 弹管理员密码框：装 sudoers 规则（先用 visudo 检查，坏了就不装），再把 disablesleep 设成 on。
 * 规则装不上也照样改 disablesleep，只是以后还得输密码。用户点了取消返回 false。
 */
async function adminLid(on) {
  const user = os.userInfo().username;
  // 用户名会写进 sudoers 和 shell 命令里，不认识的字符一律不装规则
  const safeUser = /^[a-z_][\w.-]{0,63}$/i.test(user) ? user : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loft-"));
  const rule = path.join(dir, "sudoers");
  const steps = [];
  if (safeUser) {
    fs.writeFileSync(rule, `${safeUser} ALL=(root) NOPASSWD: ${lidCommand(false).join(" ")}, ${lidCommand(true).join(" ")}\n`);
    steps.push(`(/usr/sbin/visudo -cqf '${rule}' && /usr/bin/install -m 0440 -o root -g wheel '${rule}' ${SUDOERS_FILE})`);
  }
  steps.push(lidCommand(on).join(" "));
  const script = `do shell script "${steps.join("; ")}" with administrator privileges`;
  try {
    await new Promise((resolve, reject) => {
      execFile("/usr/bin/osascript", ["-e", script], { timeout: 5 * 60_000 }, (err, _out, stderr) => {
        if (!err) return resolve(undefined);
        // -128：用户点了「取消」
        if (/-128/.test(String(stderr))) return reject(Object.assign(new Error("cancelled"), { cancelled: true }));
        reject(new Error(String(stderr).trim() || err.message));
      });
    });
    return true;
  } catch (err) {
    if (err.cancelled) return false;
    throw new Error(`设置合盖不休眠失败：${err.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 系统里 disablesleep 开着没有：pmset -g 的 System-wide 段会多一行 SleepDisabled（Tab 分隔） */
export function readLidGuard() {
  if (!isMac) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/pmset", ["-g"], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(/^\s*SleepDisabled\s+(\d)/m);
      resolve(m ? m[1] === "1" : false);
    });
  });
}

/**
 * 打开 / 关掉合盖不休眠。装过 sudoers 规则就直接改，没装（或 force）就弹管理员密码框顺带装上。
 * 用户点了取消返回 false，失败抛错
 */
export async function writeLidGuard(on, { force = false } = {}) {
  if (!isMac) throw new Error("只有 macOS 支持合盖不休眠");
  if (!force) {
    if ((await readLidGuard()) === on) return true;
    if ((await sudoLid(on)) && (await readLidGuard()) === on) return true;
  }
  if (!(await adminLid(on))) return false;
  // 授权框走完不代表写进去了，回读确认
  return (await readLidGuard()) === on;
}

// ---------- 主逻辑 ----------

/**
 * @param {{
 *   prefs: () => { keepAwake: boolean, awakeMode: string, sleepWindows: SleepWindow[], sleepRequireLocked: boolean },
 *   sessionActive: () => boolean,
 *   handled: () => Record<string, number>,
 *   setHandled: (id: string, due: number) => void,
 *   lidLifted: () => boolean,
 *   setLidLifted: (on: boolean) => void,
 *   onChange: () => void,
 * }} deps
 */
export function createAwake(deps) {
  let blockerId = null;
  /** 现在拦着休眠的理由（给界面看），没拦就是 null */
  let reason = null;
  /** 定时休眠到点了但还没睡，卡在哪（给界面看） */
  let waiting = null;
  /** 合盖不休眠的系统实际状态；null 是不知道 / 不支持 */
  let lidGuard = null;
  /** 装没装 sudoers 规则（合盖不休眠开着时能不能自己临时关掉去睡） */
  let lidSudo = false;
  /** 上一次发休眠指令的时间：没睡成的话隔一会儿再试，不是一次就作罢 */
  let attemptAt = 0;
  /** 上一次没睡成的原因（给界面看） */
  let attemptNote = null;
  let attempting = false;
  /** 临时关掉合盖不休眠后，迟迟没睡着就恢复 */
  let liftTimer = null;

  const RETRY_MS = 5 * 60_000;

  const pendingWindow = (now) => {
    const handled = deps.handled();
    for (const w of deps.prefs().sleepWindows) {
      const due = currentDue(w, now);
      if (due !== null && due > (handled[w.id] ?? 0)) return { w, due };
    }
    return null;
  };

  /** 当前所在的时段都算睡过了：睡下去、或者在时段里醒过来，都不该再睡第二次 */
  const markSlept = () => {
    const now = Date.now();
    for (const w of deps.prefs().sleepWindows) {
      const due = currentDue(w, now);
      if (due !== null && due > (deps.handled()[w.id] ?? 0)) deps.setHandled(w.id, due);
    }
  };

  /** 定时休眠临时关掉的合盖不休眠，开回去（醒来、没睡成、上次没来得及恢复就退出了） */
  async function restoreLid() {
    clearTimeout(liftTimer);
    liftTimer = null;
    if (deps.lidLifted() && (await sudoLid(true))) deps.setLidLifted(false);
    await refreshLid();
  }

  /** 发休眠指令。合盖不休眠开着的话先临时关掉，不然 sleepnow 会被挡掉 */
  async function goToSleep() {
    attempting = true;
    attemptAt = Date.now();
    attemptNote = null;
    try {
      if ((await readLidGuard()) === true) {
        if (!(await sudoLid(false))) {
          // 没装规则关不掉，sleepnow 照发：睡下去了这条提示会在 suspend 里清掉
          attemptNote = "合盖不休眠开着，系统可能睡不了，到下面点「授权自动休眠」";
          sleepNow();
          return;
        }
        deps.setLidLifted(true);
        lidGuard = false;
        // 一分钟还没睡下去（没收到 suspend），就当没睡成，把合盖不休眠开回去，过一会儿再试
        liftTimer = setTimeout(() => {
          attemptNote = "发了休眠指令但系统没睡，稍后再试";
          void restoreLid();
        }, 60_000);
      }
      sleepNow();
    } finally {
      attempting = false;
      deps.onChange();
    }
  }

  function evaluate() {
    const p = deps.prefs();
    const now = Date.now();
    const busy = deps.sessionActive();
    const scheduled = isMac && p.awakeMode === "scheduled";
    const inWindow = scheduled && p.sleepWindows.some((w) => currentDue(w, now) !== null);

    let next = null;
    if (p.keepAwake && busy) next = "本机有会话在跑";
    else if (p.awakeMode === "always") next = "永不休眠";
    else if (scheduled && p.sleepWindows.some(runnable) && !inWindow) next = "休眠时段外";

    let nextWaiting = null;
    if (scheduled) {
      // 时段算不算睡过，只看真的睡没睡下去（suspend / resume 里记），发了指令不算
      if (pendingWindow(now)) {
        if (busy) nextWaiting = "等本机会话跑完";
        else if (p.sleepRequireLocked && !screenLocked()) nextWaiting = "等待锁屏";
        else if (attempting || liftTimer || now - attemptAt < 60_000) nextWaiting = "正在休眠";
        else if (now - attemptAt < RETRY_MS) nextWaiting = attemptNote ?? "发了休眠指令但系统没睡，稍后再试";
        else void goToSleep();
      }
    }

    if (next && blockerId === null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
    else if (!next && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    const changed = next !== reason || nextWaiting !== waiting;
    reason = next;
    waiting = nextWaiting;
    return changed;
  }

  /** 系统要睡了：当前所在的时段算睡过了，醒来后不再睡第二次 */
  powerMonitor.on("suspend", () => {
    markSlept();
    // 真睡下去了，合盖不休眠等醒来再开
    clearTimeout(liftTimer);
    liftTimer = null;
    attemptNote = null;
  });

  async function refreshLid() {
    const [v, sudo] = await Promise.all([readLidGuard(), readLidSudo()]);
    if (v !== lidGuard || sudo !== lidSudo) {
      lidGuard = v;
      lidSudo = sudo;
      deps.onChange();
    }
  }

  // 时段边界、锁屏都没有可靠的事件可等，定时看一眼
  setInterval(() => {
    if (evaluate()) deps.onChange();
  }, 15_000);
  for (const ev of ["lock-screen", "unlock-screen", "resume"]) {
    powerMonitor.on(ev, () => {
      // 万一没收到 suspend：在时段里醒过来也算这个时段睡过了，免得醒来锁着屏又当场睡回去
      if (ev === "resume") markSlept();
      if (evaluate()) deps.onChange();
      if (ev === "resume") void restoreLid();
    });
  }
  // 上次临时关掉合盖不休眠后没来得及开回去就退出了
  void restoreLid();

  return {
    evaluate,
    refreshLid,
    /** force：已经是这个状态也弹一次授权框，用来补装 sudoers 规则 */
    async setLidGuard(on, { force = false } = {}) {
      try {
        // 用户自己动了开关，定时休眠就别再替它开回去了
        if (await writeLidGuard(!!on, { force })) deps.setLidLifted(false);
      } finally {
        await refreshLid();
        deps.onChange();
      }
    },
    state: () => ({ keeping: blockerId !== null, reason, waiting, lidGuard, lidSudo }),
  };
}
