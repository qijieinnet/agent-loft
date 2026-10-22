// 桌面端自己的更新：查 GitHub Releases 里最新的 desktop-v*，一键下载、替换、重启。
//
// 没有正式签名，electron-updater 用不了（Squirrel.Mac 要求签名），三个平台各自做：
//   - macOS：下载对应芯片的 zip → 核对 GitHub 给的 sha256 → 解压 → 交给一个脱离本进程的 sh 脚本：
//     等旧进程退出 → 旧 App 改名备份 → 放进新的 → 成功删备份、失败挪回来 → 重新打开。
//     任何一步失败都不会留下一个空的 App。App 所在目录写不了时，退回到打开下载页。
//   - Windows：下载 NSIS 安装包 → 核对 sha256 → 静默运行（/S --updated --force-run），
//     安装包会等本进程退出、覆盖安装、再把新版打开。装在用户目录里，不用管理员权限。
//   - Linux：只有 AppImage 能原地换：新文件下载到旧文件旁边 → 核对 → 改名盖过去 → 退出后重新打开。
//     deb 装的在系统目录里，要 root，退回到打开下载页。
import { app, net } from "electron";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "qijieinnet/agent-loft";
const TAG_PREFIX = "desktop-v";
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";
const LINUX = process.platform === "linux";

/** "0.2.10" > "0.2.9" */
export function newer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/**
 * 按后缀和芯片挑附件：文件名带 arm64 / aarch64（AppImage 的叫法）的给 ARM，其余给 x64。
 * Windows 只发 x64，ARM 的 Windows 也能跑（系统自带转译），找不到同芯片的就退回到它。
 */
function pick(assets, ext) {
  // Windows 只认安装程序本身（Agent-Loft-Setup-*.exe），别的 exe 不要
  const list = assets.filter((a) => a.name.endsWith(ext) && (!WIN || (a.name.startsWith("Agent-Loft-Setup-") && !a.name.includes("uninstaller"))));
  const arm = process.arch === "arm64";
  return list.find((a) => /arm64|aarch64/.test(a.name) === arm) ?? (WIN ? (list[0] ?? null) : null);
}

/** 这个平台：自动安装用的包、手动下载给的安装包（后缀） */
const KINDS = MAC ? { pkg: ".zip", download: ".dmg" } : WIN ? { pkg: ".exe", download: ".exe" } : { pkg: ".AppImage", download: process.env.APPIMAGE ? ".AppImage" : ".deb" };

/**
 * @returns {Promise<{ version: string, url: string, download: string | null, pkg: { url: string, size: number, sha256: string | null } | null, notes: string } | null>}
 *   有比当前新的版本就返回它，没有返回 null；网络出错抛异常。
 *   pkg：自动安装用的包（macOS 的 zip、Windows 的安装程序、Linux 的 AppImage）；download：手动下载的安装包
 */
export async function checkForUpdate() {
  // AGENT_LOFT_DESKTOP_UPDATE_FEED：测试时换成本地的假发布列表
  const feed = process.env.AGENT_LOFT_DESKTOP_UPDATE_FEED || `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const res = await net.fetch(feed, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `agent-loft-desktop/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const releases = await res.json();
  const latest = releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name?.startsWith(TAG_PREFIX) && !r.tag_name.includes("-", TAG_PREFIX.length))
    .map((r) => ({ ...r, version: r.tag_name.slice(TAG_PREFIX.length) }))
    .sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0))[0];
  if (!latest || !newer(latest.version, app.getVersion())) return null;
  const assets = latest.assets ?? [];
  const pkg = pick(assets, KINDS.pkg);
  const download = pick(assets, KINDS.download);
  return {
    version: latest.version,
    url: latest.html_url,
    download: download?.browser_download_url ?? null,
    // GitHub 给每个附件算好了 sha256（digest: "sha256:…"），下载完核对
    pkg: pkg ? { url: pkg.browser_download_url, size: pkg.size, sha256: /^sha256:([0-9a-f]{64})$/.exec(pkg.digest ?? "")?.[1] ?? null } : null,
    notes: String(latest.body ?? "").slice(0, 2000),
  };
}

/** 当前 App 的 .app 目录（/Applications/Agent Loft.app） */
function bundlePath() {
  return path.resolve(process.execPath, "../../..");
}

/** Windows：NSIS 装好的才有卸载程序；解压版、随手拷的没有，覆盖安装会装到别处去 */
function nsisInstalled() {
  const dir = path.dirname(process.execPath);
  try {
    return fs.readdirSync(dir).some((n) => /^Uninstall .*\.exe$/i.test(n));
  } catch {
    return false;
  }
}

/** 能不能原地替换；不能的话返回原因 */
export function canSelfUpdate() {
  if (!app.isPackaged) return "开发版本不能自动更新";
  if (WIN) return nsisInstalled() ? null : "不是用安装程序装的，不能自动更新";
  if (LINUX) {
    const image = process.env.APPIMAGE;
    if (!image) return "用 deb 包装的不能自动更新";
    try {
      fs.accessSync(path.dirname(image), fs.constants.W_OK);
    } catch {
      return `没有写入 ${path.dirname(image)} 的权限`;
    }
    return null;
  }
  const bundle = bundlePath();
  if (!bundle.endsWith(".app") || bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) {
    return "先把 Agent Loft 拖进「应用程序」文件夹，才能自动更新";
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return `没有写入 ${path.dirname(bundle)} 的权限`;
  }
  return null;
}

/** 下载到 file，边下边算 sha256，核对不上就删掉、抛错 */
async function download(pkg, file, onProgress) {
  const res = await net.fetch(pkg.url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || pkg.size || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(file, { mode: 0o755 });
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      if (total) onProgress?.(Math.min(1, got / total));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (pkg.sha256 && hash.digest("hex") !== pkg.sha256) throw new Error("下载的文件校验不通过，可能损坏了，请重试");
  } catch (err) {
    // 等文件真正关掉再删（Windows 上开着的文件删不掉），删不掉也别盖住原来的错误
    if (!out.closed) await new Promise((r) => out.destroy().once("close", r));
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 留在临时目录里，不要紧
    }
    throw err;
  }
}

/**
 * 下载并安装。onProgress(0~1)。成功返回后调用方要马上退出，由脚本 / 安装程序替换后重新打开。
 * @param {NonNullable<Awaited<ReturnType<typeof checkForUpdate>>>} update
 */
export async function installUpdate(update, onProgress) {
  const problem = canSelfUpdate();
  if (problem) throw new Error(problem);
  if (!update.pkg) throw new Error("这个版本没有可自动安装的包，请手动下载");

  if (LINUX) {
    // 下到旧文件旁边（同一个文件系统才能原子改名），校验通过再盖过去；正在跑的旧文件被替换不影响本进程
    const image = /** @type {string} */ (process.env.APPIMAGE);
    const next = `${image}.new-${process.pid}`;
    await download(update.pkg, next, onProgress);
    fs.chmodSync(next, 0o755);
    fs.renameSync(next, image);
    // 重新打开时沿用这次的启动方式：没有 libfuse2 的机器靠解压运行（这次的 execPath 在解压出来的临时目录里），
    // Ubuntu 24.04 上不少人带着 --no-sandbox 跑 AppImage
    if (path.basename(path.dirname(process.execPath)).startsWith("appimage_extracted_")) process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
    app.relaunch({ execPath: image, args: process.argv.slice(1).filter((a) => a === "--no-sandbox") });
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loft-update-"));

  if (WIN) {
    const setup = path.join(work, "Agent-Loft-Setup.exe");
    await download(update.pkg, setup, onProgress);
    // 和 electron-updater 给 NSIS 的参数一样：静默、按更新处理、装完把 App 打开
    const child = spawn(setup, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    return;
  }

  // 1. 下载、核对 sha256（net 下载的文件不带隔离属性，Gatekeeper 不会拦）
  const zipFile = path.join(work, "update.zip");
  await download(update.pkg, zipFile, onProgress);

  // 2. 解压，找到里面的 .app
  const unpacked = path.join(work, "unpacked");
  await new Promise((resolve, reject) => execFile("ditto", ["-x", "-k", zipFile, unpacked], (err) => (err ? reject(err) : resolve())));
  const newApp = fs.readdirSync(unpacked).find((n) => n.endsWith(".app"));
  if (!newApp) throw new Error("更新包里没有 App");

  // 3. 交给脱离本进程的脚本：等我们退出再换，换完重新打开
  const script = path.join(work, "install.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh
PID="$1"; OLD="$2"; NEW="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
BAK="$OLD.old-$$"
mv "$OLD" "$BAK" || { open "$OLD"; exit 1; }
if ditto "$NEW" "$OLD"; then
  rm -rf "$BAK"
else
  rm -rf "$OLD"; mv "$BAK" "$OLD"
fi
xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
open "$OLD"
rm -rf "$(dirname "$0")"
`,
    { mode: 0o755 },
  );
  const child = spawn("/bin/sh", [script, String(process.pid), bundlePath(), path.join(unpacked, newApp)], { detached: true, stdio: "ignore" });
  child.unref();
}
