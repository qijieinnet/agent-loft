// 冒烟测试：npm run smoke（AGENT_LOFT_DESKTOP_SMOKE=1 electron .）
//
// 用临时配置目录启动，检查自己的几个界面真的画得出来、没有脚本报错：
// 首次启动向导 → 点「只连接其他服务器」→ 设置页的各个区块 → 菜单栏面板。
// 这些界面是普通脚本拼的，没有类型检查，改坏了只会表现成「一片空白、点什么都没反应」。
import { app, webContents } from "electron";
import fs from "node:fs";
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

    const pop = openPopover();
    await until(() => pop.executeJavaScript(`document.body.innerText.includes("冒烟测试")`), "菜单栏面板里的服务器");
    junk = junkIn(await pop.executeJavaScript("document.body.innerText"));
    if (junk) return fail(`菜单栏面板里有渲染残渣：「${junk}」`);

    await sleep(500);
    if (errors.length) return fail("界面里有脚本报错");
    console.log("冒烟测试通过：向导、设置页、菜单栏面板都正常");
    app.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
