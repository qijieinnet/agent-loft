// 冒烟测试：npm run smoke（AGENT_LOFT_DESKTOP_SMOKE=1 electron .）
//
// 用临时配置目录启动，检查自己的几个界面真的画得出来、没有脚本报错：
// 首次启动向导 → 点「只连接其他服务器」→ 设置页的各个区块 → 用量汇总 → 菜单栏面板。
// 这些界面是普通脚本拼的，没有类型检查，改坏了只会表现成「一片空白、点什么都没反应」。
import { app, BaseWindow, Menu, webContents } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const smoke = process.env.AGENT_LOFT_DESKTOP_SMOKE === "1";

const errors = [];

/** 在任何窗口创建之前调用：配置目录换成临时的，开始收集所有页面的报错 */
export function prepareSmoke() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loft-smoke-"));
  app.setPath("userData", path.join(tmp, "desktop"));
  // 本机服务端检测指向一个空目录，别连到这台机器上真在跑的 agent-loft
  process.env.AGENT_LOFT_HOME = path.join(tmp, "server");
  app.on("web-contents-created", (_e, wc) => {
    const name = () => path.basename(wc.getURL()) || "页面";
    wc.on("console-message", (event) => {
      if (event.level === "error") errors.push(`[${name()}] ${event.message}`);
    });
    wc.on("preload-error", (_e2, file, err) => errors.push(`[${name()}] preload ${file}: ${err.message}`));
    wc.on("render-process-gone", (_e2, d) => errors.push(`[${name()}] 渲染进程退出：${d.reason}`));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await Promise.resolve()
      .then(check)
      .catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`等不到：${what}`);
}

/** 界面上不该出现的东西：null、undefined、[object …]、NaN */
function junkIn(text) {
  return /.{0,20}(\bnull\b|\bundefined\b|\[object [^\]]*\]|\bNaN\b).{0,20}/.exec(text)?.[0] ?? null;
}

/** @param {{ openPopover: () => Electron.WebContents }} hooks */
export async function runSmoke({ openPopover }) {
  const fail = (msg) => {
    console.error(`冒烟测试失败：${msg}`);
    for (const e of errors) console.error(`  ${e}`);
    app.exit(1);
  };
  setTimeout(() => fail("超时"), 90_000).unref();
  try {
    const shell = await until(() => webContents.getAllWebContents().find((w) => w.getURL().endsWith("shell/index.html")), "侧栏页面");
    const js = (code) => shell.executeJavaScript(code);
    const isMac = process.platform === "darwin";
    const clickMenu = (id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (!item || !item.enabled || !item.visible) throw new Error(`系统菜单入口不可用：${id}`);
      item.click();
    };

    await until(() => js(`document.querySelectorAll(".choice").length === 2`), "首次启动向导的两个选项");
    await js(`[...document.querySelectorAll(".choice")].find((b) => b.textContent.includes("只连接其他服务器")).click()`);
    // 「只连接其他服务器」之后弹出添加服务器的弹窗：真的填一遍（地址连不上也没关系，要看的是画出来的东西）
    await until(() => js(`!!(document.getElementById("d-url") && document.querySelectorAll(".emoji-btn").length > 10)`), "添加服务器弹窗");
    let junk = junkIn(await js(`document.querySelector(".dialog").innerText`));
    if (junk) return fail(`添加服务器弹窗里有渲染残渣：「${junk}」`);
    await js(`(() => {
      document.querySelector('.emoji-btn[data-emoji="🚀"]').click();
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input")); };
      set("d-url", "127.0.0.1:9");
      set("d-name", "冒烟测试");
      document.querySelector(".dialog").requestSubmit();
    })()`);
    await until(() => js(`!document.querySelector(".dialog")`), "弹窗提交后关闭").catch(async (err) => {
      throw new Error(`${err.message}（弹窗里的错误：${await js(`document.querySelector(".dialog .error-text")?.textContent`)}）`);
    });
    await until(() => js(`document.getElementById("panel").innerText.includes("冒烟测试")`), "服务器列表里的新服务器");
    if (!(await js(`[...document.querySelectorAll("#servers .tab")].some((t) => t.textContent.includes("🚀") && t.textContent.includes("冒烟测试"))`))) return fail("顶栏没有显示选的图标 🚀 和名称");
    junk = junkIn(await js(`document.getElementById("panel").innerText`));
    if (junk) return fail(`设置页（有服务器时）里有渲染残渣：「${junk}」`);

    // 防休眠开关：画得出来，点了能存上（新服务器连不上时面板显示的是出错页，先切回设置页）
    await js(`window.loft.call("manage")`);
    await until(() => js(`!!document.getElementById("p-keepAwake")`), "「不休眠」开关");
    await js(`document.getElementById("p-keepAwake").click()`);
    await until(() => js(`window.loft.state().then((s) => s.prefs.keepAwake === true)`), "「不休眠」设置保存");
    // 防休眠模式：切到定时休眠（只有 macOS 有），时段列表画得出来，加一个时段能存上；最后切回跟随系统
    if (process.platform === "darwin") {
      await js(`[...document.querySelectorAll("#panel .pick button")].find((b) => b.textContent === "定时休眠").click()`);
      await until(() => js(`document.querySelectorAll(".sleep-window").length === 1 && !!document.getElementById("p-sleepRequireLocked")`), "定时休眠的时段列表");
      await js(`document.querySelector(".add-window").click()`);
      await until(() => js(`window.loft.state().then((s) => s.prefs.sleepWindows.length === 2)`), "添加休眠时段");
      if (!(await js(`window.loft.state().then((s) => !!s.awake && typeof s.awake.keeping === "boolean")`))) return fail("状态里没有防休眠信息");
      await js(`window.loft.call("setPref", "awakeMode", "system")`);
    }

    // 拖动排序：再加两台，用真的鼠标事件在设置页列表里竖着拖、在顶栏里横着拖
    await js(`window.loft.call("addServer", "排序二", "127.0.0.1:10", null, "🐢").then(() => window.loft.call("addServer", "排序三", "127.0.0.1:11", null, "🦊"))`);
    await js(`window.loft.call("manage")`);
    await until(() => js(`document.querySelectorAll(".server-list > .server-item").length === 3 && document.querySelectorAll("#servers .tab").length === 3`), "三台服务器");
    const names = () => js(`window.loft.state().then((s) => s.servers.map((x) => x.name).join(","))`);
    const center = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const drag = async ([x0, y0], [x1, y1]) => {
      shell.sendInputEvent({ type: "mouseDown", x: Math.round(x0), y: Math.round(y0), button: "left", clickCount: 1 });
      for (let i = 1; i <= 12; i++) {
        const x = Math.round(x0 + ((x1 - x0) * i) / 12);
        const y = Math.round(y0 + ((y1 - y0) * i) / 12);
        shell.sendInputEvent({ type: "mouseMove", x, y, modifiers: ["leftButtonDown"] });
        await sleep(16);
      }
      shell.sendInputEvent({ type: "mouseUp", x: Math.round(x1), y: Math.round(y1), button: "left", clickCount: 1 });
      await sleep(300);
    };
    // 第一行（名字上按住）拖到最后一行下半截
    await drag(await center(".server-list > .server-item:nth-child(1) .name"), await center(".server-list > .server-item:nth-child(3) .sub"));
    await until(async () => (await names()) === "排序二,排序三,冒烟测试", `列表拖动后的顺序（现在是 ${await names()}）`, 3000);
    // 顶栏：最后一个标签拖到最前面
    const [tx, ty] = await center("#servers .tab:nth-child(3)");
    const [fx] = await center("#servers .tab:nth-child(1)");
    await drag([tx, ty], [fx - 30, ty]);
    await until(async () => (await names()) === "冒烟测试,排序二,排序三", `顶栏拖动后的顺序（现在是 ${await names()}）`, 3000);
    // 拖完不能顺带算一次点击：还停在设置页，没有切到被拖的那台
    if (!(await js(`window.loft.state().then((s) => s.managing)`))) return fail("顶栏拖完被当成了点击，切走了设置页");
    // 页面上的顺序和存下来的一致
    const shown = await js(`[...document.querySelectorAll("#servers .tab .name")].map((n) => n.textContent).join(",")`);
    if (shown !== (await names())) return fail(`顶栏显示的顺序 ${shown} 和保存的 ${await names()} 不一致`);
    // 不拖、只点一下标签：照常切换服务器
    const [cx, cy] = await center("#servers .tab:nth-child(2)");
    shell.sendInputEvent({ type: "mouseDown", x: Math.round(cx), y: Math.round(cy), button: "left", clickCount: 1 });
    shell.sendInputEvent({ type: "mouseUp", x: Math.round(cx), y: Math.round(cy), button: "left", clickCount: 1 });
    await until(() => js(`window.loft.state().then((s) => !s.managing && s.servers.find((x) => x.id === s.activeId)?.name === "排序二")`), "点标签切换到「排序二」", 3000);
    await js(`window.loft.call("manage")`);

    // macOS 的顶栏只留服务器标签，用量汇总、设置从系统菜单打开；其他平台仍用按钮。
    if (isMac && !(await js(`["usage", "settings"].every((id) => document.getElementById(id).getClientRects().length === 0)`))) {
      return fail("macOS 顶栏仍然显示用量汇总或设置按钮");
    }
    // 三台都连不上，注明哪几台没算进去；翻到上个月也正常。
    if (isMac) clickMenu("usage-summary");
    else await js(`document.getElementById("usage").click()`);
    await until(() => js(`document.querySelector(".usage-stats")?.innerText.includes("没算进去")`), "用量汇总页");
    if (!(await js(`window.loft.state().then((s) => s.managing && s.panel === "usage")`))) return fail("用量汇总菜单没有切换面板");
    if (!isMac && !(await js(`document.getElementById("usage").classList.contains("on") && !document.getElementById("settings").classList.contains("on")`))) {
      return fail("用量汇总打开了，顶栏的用量按钮没有亮");
    }
    await js(`document.querySelector('.us-nav [aria-label="上一个"]').click()`);
    await until(() => js(`document.querySelector(".usage-stats")?.innerText.includes("没算进去")`), "用量汇总翻到上个月");
    junk = junkIn(await js(`document.getElementById("panel").innerText`));
    if (junk) return fail(`用量汇总里有渲染残渣：「${junk}」`);
    // 系统菜单里的服务器选项能从汇总页切回服务器；其他平台再点用量按钮返回。
    if (isMac) {
      const name = await js(`window.loft.state().then((s) => s.servers.find((x) => x.id === s.activeId).name)`);
      const item = Menu.getApplicationMenu()?.items.find((m) => m.label === "服务器")?.submenu?.items.find((m) => m.label === name);
      if (!item) return fail("系统菜单中没有当前服务器");
      item.click();
    } else await js(`document.getElementById("usage").click()`);
    await until(() => js(`window.loft.state().then((s) => !s.managing && !!s.activeId)`), "再点用量按钮回到服务器", 3000);
    // 设置菜单（macOS）或设置按钮（其他平台）打开桌面端设置。
    if (isMac) clickMenu("desktop-settings");
    else await js(`document.getElementById("settings").click()`);
    await until(
      () => js(`window.loft.state().then((s) => s.managing && s.panel === "manage" && !!document.getElementById("p-keepAwake"))`),
      "打开桌面端设置",
      3000,
    );

    // 苹果日历 / 提醒事项 / 备忘录（只有 macOS）：默认没连接，「连接」按钮和签名方式画得出来
    if (isMac) {
      await until(() => js(`document.getElementById("panel").innerText.includes("苹果日历 / 提醒事项 / 备忘录")`), "苹果日历设置区块");
      if (!(await js(`window.loft.state().then((s) => s.apple && s.apple.installed === false)`))) return fail("苹果日历默认应该是没连接");
      if (!(await js(`[...document.querySelectorAll("#panel .pick button")].some((b) => b.textContent.includes("本机证书"))`))) return fail("苹果日历区块没有签名方式选项");
    }

    const pop = openPopover();
    await until(() => pop.executeJavaScript(`document.body.innerText.includes("冒烟测试")`), "菜单栏面板里的服务器");
    junk = junkIn(await pop.executeJavaScript("document.body.innerText"));
    if (junk) return fail(`菜单栏面板里有渲染残渣：「${junk}」`);

    // 冷启动：页面先连一个还没监听的端口，服务稍后启动，应该自动恢复并挂回窗口。
    const delayed = http.createServer((req, res) => {
      if (req.url === "/api/me") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ authed: false }));
      } else {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><meta charset="utf-8"><title>启动重试测试</title><p>服务端已启动</p>');
      }
    });
    await new Promise((resolve, reject) => delayed.once("error", reject).listen(0, "127.0.0.1", resolve));
    const delayedPort = delayed.address().port;
    await new Promise((resolve) => delayed.close(resolve));
    const delayedUrl = `http://127.0.0.1:${delayedPort}`;
    const delayedId = await js(`window.loft.call("addServer", "启动重试测试", ${JSON.stringify(delayedUrl)})`);
    const connection = () => js(`window.loft.state().then((s) => s.servers.find((x) => x.id === ${JSON.stringify(delayedId)}))`);
    await until(() => js(`document.getElementById("panel").innerText.includes("正在连接「启动重试测试」")`), "服务未启动时的连接中提示");
    await sleep(2500); // 至少经历一次真正的 ERR_CONNECTION_REFUSED 和自动重试。
    const waiting = await connection();
    if (!waiting.connecting || waiting.loadFailed || waiting.status === "offline") return fail("服务启动前提前显示了连接失败");
    await new Promise((resolve, reject) => delayed.once("error", reject).listen(delayedPort, "127.0.0.1", resolve));
    await until(async () => {
      const s = await connection();
      return !s.connecting && !s.loadFailed && s.status === "login";
    }, "服务启动后自动连接成功");
    const loaded = webContents.getAllWebContents().find((wc) => wc.getURL() === `${delayedUrl}/`);
    if (!loaded || !(await loaded.executeJavaScript('document.body.innerText.includes("服务端已启动")'))) return fail("自动重试后没有加载服务端页面");
    if (!BaseWindow.getAllWindows().some((w) => w.contentView.children.some((v) => v.webContents === loaded))) return fail("自动重试成功后页面没有显示在窗口里");
    delayed.close();

    await sleep(500);
    if (errors.length) return fail("界面里有脚本报错");
    console.log("冒烟测试通过：向导、设置页、菜单栏面板、服务端冷启动重试都正常");
    app.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
