// 由原 npm 命令入口加载。试运行期间由旧版监督启动，候选进程即使无法加载 tsx 也能回退。
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { markInUse, pidAlive, readRelease, releaseRoot, type Release } from "./upgrade-releases.js";

async function tryRelease(store: string, pending: Release): Promise<boolean> {
  const dir = path.join(store, pending.slot);
  const marker = path.join(dir, "trial");
  try {
    fs.linkSync(markInUse(dir), marker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(fs.readFileSync(marker, "utf8"));
    if (pid !== process.pid && pidAlive(pid)) return false;
    recordFailure("上次验证被中断");
    return false;
  }
  function recordFailure(reason: string) {
    const message = `${pending.version} 启动验证失败，已回退：${reason}`;
    console.error("[升级]", message);
    if (readRelease(store, "pending")?.slot !== pending.slot) return;
    fs.renameSync(path.join(store, "pending.json"), path.join(dir, "failed.json"));
    try { fs.writeFileSync(path.join(store, "last-error"), message); }
    catch (err) { console.error("[升级] 保存错误信息失败", err); }
  }

  const child = fork(path.join(releaseRoot(store, pending), "bin/cli.js"), process.argv.slice(2), {
    execArgv: [], stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...process.env, AGENT_LOFT_UPGRADE_TRIAL: pending.slot },
  });
  let ready = false;
  let stopping = false;
  let failure = "新版进程在验证前退出";
  const stop = (signal: NodeJS.Signals) => { stopping = true; child.kill(signal); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = setTimeout(() => { failure = "启动验证超时"; child.kill("SIGKILL"); }, 120_000);
  try {
    child.on("message", (msg) => {
      const result = msg as { type?: string; version?: string; error?: string };
      if (ready || stopping || result?.type !== "upgrade-health") return;
      if (result.version !== pending.version || result.error) {
        failure = result.error || "运行版本不匹配";
        child.kill("SIGTERM");
        return;
      }
      try {
        fs.rmSync(path.join(store, "last-error"), { force: true });
        fs.renameSync(path.join(store, "pending.json"), path.join(store, "active.json"));
        ready = true;
        clearTimeout(timer);
        console.log(`[升级] 已验证并启用 ${pending.version}`);
      } catch (err) {
        failure = String(err);
        child.kill("SIGTERM");
      }
    });
    const code = await new Promise<number>((resolve) => {
      child.once("error", (err) => { failure = err.message; });
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (ready || stopping) {
      process.exitCode = code;
      return true;
    }
    recordFailure(failure);
    return false;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function launchRelease(store: string): Promise<boolean> {
  if ((process.argv[2] ?? "start") === "start") {
    const pending = readRelease(store, "pending");
    if (pending) {
      try {
        if (await tryRelease(store, pending)) return true;
      } catch (err) {
        console.error("[升级] 无法开始或完成验证，启动已验证版本", err);
      }
    }
  }
  const active = readRelease(store, "active");
  if (!active) return false;
  try { markInUse(path.join(store, active.slot)); }
  catch (err) { console.warn("[升级] 无法记录版本占用", err); }
  await import(pathToFileURL(path.join(releaseRoot(store, active), "bin/cli.js")).href);
  return true;
}
