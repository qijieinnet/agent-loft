// 远程桌面的多块屏：每块屏在 VNC 画面里的哪里、叫什么，页面可以只看其中一块（vnc-transcode.ts 按它裁剪）。
//   - macOS 屏幕共享：画面是几块屏按像素拼起来的，可每块屏的位置和系统里的屏幕坐标对不上
//     （实测：竖直方向的偏移按点算、没乘 2 倍），只能从它发来的画面里学 —— 不增量地要整个画面时，它一次发一整块屏。
//     名字在本机时从系统里读（NSScreen），按像素大小、从左到右的顺序对上。
//   - Linux 上自己起的 x11vnc：xrandr 直接给出每块屏的位置和接口名（DP-1 之类）。
//   - 别的 VNC 服务：不知道，只能看整个画面。
// 学到的记在内存里，下次连上（画面大小没变）直接用。
import { execFile } from "node:child_process";
import type { Rect, ScreenSource } from "./vnc-transcode.js";

export type Screen = Rect & { name: string };

/** sig：学的时候系统里的屏幕（本机 macOS），变了就作废 */
type Layout = { key: string; sig: string; w: number; h: number; screens: Screen[] };

/** 知道的各块屏（按从左到右排） */
let known: Layout | null = null;

/** 页面要的：有哪几块屏（只给名字）。刚连上时 macOS 的可能还在学，页面过一会儿再问 */
export function desktopScreens(): { screens: { name: string }[] } {
  return { screens: known?.screens.map((s) => ({ name: s.name })) ?? [] };
}

const byPosition = (a: Rect, b: Rect) => a.x - b.x || a.y - b.y;
const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 系统里的一块屏：名字、像素大小、位置（点，左下角为原点） */
export type SystemScreen = { name: string; w: number; h: number; x: number; y: number };

/** 本机 macOS 的各块屏 */
function macScreens(): Promise<SystemScreen[] | null> {
  const script = `ObjC.import("AppKit");
const s = $.NSScreen.screens, out = [];
for (let i = 0; i < s.count; i++) {
  const x = s.objectAtIndex(i), f = x.frame, k = x.backingScaleFactor;
  out.push({ name: x.localizedName.js, w: Math.round(f.size.width * k), h: Math.round(f.size.height * k), x: f.origin.x, y: f.origin.y });
}
JSON.stringify(out);`;
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as SystemScreen[]);
      } catch {
        resolve(null);
      }
    });
  });
}

/** 学到的各块屏起上名字：和系统里的按像素大小对上，一样大的按从左到右的顺序；对不上的叫「屏幕 N」 */
export function nameScreens(rects: Rect[], system: SystemScreen[] | null): Screen[] {
  const left = [...(system ?? [])].sort((a, b) => a.x - b.x || b.y - a.y);
  return [...rects].sort(byPosition).map((r, i) => {
    const k = left.findIndex((s) => s.w === r.w && s.h === r.h);
    const name = k >= 0 ? left.splice(k, 1)[0]!.name : `屏幕 ${i + 1}`;
    return { ...r, name };
  });
}

/** xrandr --current 的输出 → 各块屏和整个画面的大小 */
export function parseXrandr(text: string): { w: number; h: number; screens: Screen[] } | null {
  const size = /current (\d+) x (\d+)/.exec(text);
  if (!size) return null;
  const screens: Screen[] = [];
  for (const m of text.matchAll(/^(\S+) connected (?:primary )?(\d+)x(\d+)\+(\d+)\+(\d+)/gm)) {
    screens.push({ name: m[1]!, w: Number(m[2]), h: Number(m[3]), x: Number(m[4]), y: Number(m[5]) });
  }
  return { w: Number(size[1]), h: Number(size[2]), screens: screens.sort(byPosition) };
}

function xrandr(display: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("xrandr", ["--current"], { timeout: 5000, env: { ...process.env, DISPLAY: display } }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * 一次转码会话用的：key 区分不同的 VNC 服务。
 * local：VNC 服务在本机（macOS 上能读到屏幕名字）；display：x11vnc 共享的 X 显示
 */
export async function screenSource(key: string, opts: { local: boolean; display?: string }): Promise<ScreenSource> {
  if (known?.key !== key) known = null;
  if (opts.display) {
    const parsed = parseXrandr((await xrandr(opts.display)) ?? "");
    known = parsed?.screens.length ? { key, sig: "", ...parsed } : null;
  }
  const system = opts.local && process.platform === "darwin" ? await macScreens() : null;
  const sig = JSON.stringify(system);
  // 系统里的屏幕换了（插拔、挪了位置、改了分辨率）：之前学的作废
  if (system && known?.sig !== sig) known = null;

  /** 这次会话学到的 */
  let seen: Rect[] = [];
  let repeated = false;
  return {
    get: (w, h) => (known && known.w === w && known.h === h ? known.screens : null),
    learn(w, h, rects) {
      for (const r of rects) {
        if (seen.some((s) => same(s, r))) {
          repeated = true;
          continue;
        }
        // 和学过的重叠：之前那块不对（摆法变了），换掉
        seen = seen.filter((s) => !overlap(s, r));
        seen.push(r);
      }
      // 学全了：拼起来正好是整个画面；知道有几块屏时数目对上，不知道时转了一圈又发回第一块
      const covers =
        seen.length > 0 &&
        Math.min(...seen.map((s) => s.x)) === 0 &&
        Math.min(...seen.map((s) => s.y)) === 0 &&
        Math.max(...seen.map((s) => s.x + s.w)) === w &&
        Math.max(...seen.map((s) => s.y + s.h)) === h;
      const done = covers && (system ? seen.length === system.length : repeated);
      if (done) known = { key, sig, w, h, screens: nameScreens(seen, system) };
      return done;
    },
  };
}
