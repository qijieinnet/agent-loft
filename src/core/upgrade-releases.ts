// 全局安装保留最初的 CLI 入口。npm 只写独立 prefix，重启验证通过后原子切换版本记录。
import fs from "node:fs";
import path from "node:path";

const storeName = ".agent-loft-releases";
const modules = process.platform === "win32" ? "node_modules" : path.join("lib", "node_modules");
const slotPattern = /^release-[a-zA-Z0-9]{6}$/;

export function releaseStore(packageRoot: string): string {
  const prefix = path.resolve(packageRoot, process.platform === "win32" ? "../.." : "../../..");
  if (slotPattern.test(path.basename(prefix)) && path.basename(path.dirname(prefix)) === storeName) {
    return path.dirname(prefix);
  }
  return path.join(packageRoot, storeName);
}

export type Release = { slot: string; version: string };
export type ReleaseRecord = "pending" | "active";

export function releaseRoot(store: string, release: Release): string {
  if (!slotPattern.test(release.slot)) throw new Error("更新目录无效");
  return path.join(store, release.slot, modules, "agent-loft");
}

export function readRelease(store: string, record: ReleaseRecord): Release | undefined {
  try {
    const release = JSON.parse(fs.readFileSync(path.join(store, record + ".json"), "utf8"));
    releaseRoot(store, release);
    return release;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function markInUse(dir: string): string {
  const file = path.join(dir, "pid-" + process.pid);
  fs.writeFileSync(file, String(process.pid));
  return file;
}

// 清理中断的下载和已替换的版本。其他实例还在使用的目录要留到以后。
async function pruneReleases(store: string): Promise<void> {
  for (const slot of fs.readdirSync(store).filter(name => slotPattern.test(name))) {
    const dir = path.join(store, slot);
    try {
      const pids = fs.readdirSync(dir).filter(name => name.startsWith("pid-"));
      if (!pids.length || pids.some(name => pidAlive(Number(name.slice(4))))) continue;
      if (readRelease(store, "active")?.slot === slot || readRelease(store, "pending")?.slot === slot) continue;
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[升级] 无法清理旧版本", err);
    }
  }
}

// link 在同一文件系统内一次性发布完整记录，另一个进程先提交时不会覆盖它。
function queueRelease(store: string, release: Release): void {
  const manifest = path.join(store, release.slot, "release.json");
  fs.writeFileSync(manifest, JSON.stringify(release));
  fs.linkSync(manifest, path.join(store, "pending.json"));
}

export async function stageRelease(
  root: string, version: string,
  install: (prefix: string) => Promise<string>,
  checkCli: (cli: string) => Promise<void>,
): Promise<string> {
  const store = releaseStore(root);
  fs.mkdirSync(store, { recursive: true });
  if (readRelease(store, "pending")) throw new Error("已有更新等待重启验证");
  const active = readRelease(store, "active");
  if ((active ? releaseRoot(store, active) : path.dirname(store)) !== root) throw new Error("运行版本已变更，请先重启服务");
  await pruneReleases(store);
  const prefix = fs.mkdtempSync(path.join(store, "release-"));
  const release = { slot: path.basename(prefix), version };
  try {
    markInUse(prefix);
    const output = await install(prefix);
    const candidate = releaseRoot(store, release);
    const pkg = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
    if (pkg.name !== "agent-loft" || pkg.version !== version) throw new Error("安装包名称或版本不匹配");
    for (const file of ["src/main.ts", "web/index.html", "web/app.js", "web/css/base.css"]) {
      if (!fs.statSync(path.join(candidate, file)).size) throw new Error(`更新包文件为空：${file}`);
    }
    await checkCli(path.join(candidate, "bin/cli.js"));
    if (readRelease(store, "active")?.slot !== active?.slot) throw new Error("运行版本已变更，请先重启服务");
    queueRelease(store, release);
    return output;
  } catch (err) {
    await fs.promises.rm(prefix, { recursive: true, force: true }).catch(cleanup => console.warn("[升级] 清理安装目录失败", cleanup));
    throw err;
  }
}
