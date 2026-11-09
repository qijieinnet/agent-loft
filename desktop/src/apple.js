// 连接苹果应用（只有 macOS，默认关）。
//
// 真正读写数据的是 Agent Loft Bridge（bridge/ 里的 Swift 小程序）。它一启动就用 disclaim 方式重新拉起自己，
// macOS 把隐私权限记在 Bridge 名下，不会记到启动它的程序头上（不然本机所有 node 程序都跟着拿到权限）。
// Bridge 只认桌面端：每次调用桌面端把调用密钥写进它的 stdin，Bridge 和 config.json 里的哈希比对，
// 对不上就拒绝。智能体一律通过桌面端的 MCP 服务（apple-mcp.js，要 token）来用。
// 桌面端负责装、签名、申请权限、卸载：
//   - 装：把包里的 Bridge.app 复制到 ~/Library/Application Support/Agent Loft/apple-bridge/，在那里签名
//     （不能在桌面端的 .app 里面签，会破坏桌面端自己的签名）。
//   - 签名二选一：
//       local  在本机生成一张自签名代码签名证书（放在单独的钥匙串里，不设信任，不用输密码），用它签。
//              系统按证书认程序，以后更新 Bridge 只要还用这张证书签，权限都还在。
//       adhoc  不建证书。功能一样，只是 Bridge 每次更新后系统当成新程序，要重新授权。
//   - 桌面端更新后，包里的 Bridge 变了就按原来的签名方式自动重装。
//   - 关掉：撤销系统里给 Bridge 的授权（tccutil reset），删掉 Bridge、证书、软链接。
//
// 开没开以磁盘上实际装没装为准，不存在桌面端配置里。
import { app, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppleMcp } from "./apple-mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";

const BUNDLE_ID = "com.qijieinnet.agentloft.bridge";
const APP_NAME = "Agent Loft Bridge.app";
const CERT_NAME = "Agent Loft Bridge Local Signing";

const dir = () => path.join(app.getPath("userData"), "apple-bridge");
const installedApp = () => path.join(dir(), APP_NAME);
const exeOf = (appPath) => path.join(appPath, "Contents/MacOS/agent-loft-apple");
const sourceApp = () => (app.isPackaged ? path.join(process.resourcesPath, APP_NAME) : path.join(here, "../bridge/build", APP_NAME));
const installFile = () => path.join(dir(), "install.json");
const configFile = () => path.join(dir(), "config.json");
const keychainFile = () => path.join(dir(), "signing.keychain-db");
const keychainPassFile = () => path.join(dir(), "signing.pass");
/** 调用密钥，用 safeStorage 加密（密钥在 macOS 钥匙串里）存着 */
const callerKeyFile = () => path.join(dir(), "caller.key");

/** 系统设置里对应的隐私页 */
const PRIVACY_PANES = {
  calendars: "Privacy_Calendars",
  reminders: "Privacy_Reminders",
  notes: "Privacy_Automation",
  contacts: "Privacy_Contacts",
  photos: "Privacy_Photos",
  mail: "Privacy_Automation",
};
/** 每个应用的开关默认值：老三样开着，通讯录、照片、邮件要用户自己打开（和 Bridge 里的默认一致） */
export const DEFAULT_SERVICES = { calendars: true, reminders: true, notes: true, contacts: false, photos: false, mail: false };
/** tccutil 的服务名（AppleEvents 管备忘录和邮件） */
const TCC_SERVICES = ["Calendar", "Reminders", "AppleEvents", "AddressBook", "Photos"];

function run(file, args, { timeout = 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr).trim() || err.message;
        // Bridge 的错误是 {"error": ...}
        let detail = msg;
        try {
          detail = JSON.parse(msg).error ?? msg;
        } catch {}
        return reject(Object.assign(new Error(detail), { stdout: String(stdout) }));
      }
      resolve(String(stdout));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

// ---------- 调用密钥 ----------

let callerKeyCache = null;

function callerKey() {
  if (callerKeyCache) return callerKeyCache;
  try {
    callerKeyCache = safeStorage.decryptString(fs.readFileSync(callerKeyFile()));
  } catch {
    callerKeyCache = null;
  }
  return callerKeyCache;
}

/** 装的时候换一把新的：明文只在桌面端内存里，盘上是加密的，Bridge 那边只存哈希 */
function newCallerKey() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，没法安全保存调用密钥");
  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(callerKeyFile(), safeStorage.encryptString(key), { mode: 0o600 });
  callerKeyCache = key;
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** 调 Bridge（已经装好的那个）。拒绝、出错时抛错，错误信息是 Bridge 给的 */
export function bridge(args, { timeout = 60_000 } = {}) {
  const key = callerKey();
  if (!key) return Promise.reject(new Error("Agent Loft Bridge 的调用密钥丢了，到设置里断开再重新连接"));
  return run(exeOf(installedApp()), args, { timeout, input: `${key}\n` });
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
};

/** Bridge 的内容指纹：可执行文件 + notes.js。变了就说明桌面端带了新版 Bridge */
function fingerprint(appPath) {
  const hash = crypto.createHash("sha256");
  for (const rel of ["Contents/MacOS/agent-loft-apple", "Contents/Resources/notes.js", "Contents/Resources/mail.js", "Contents/Info.plist"]) {
    hash.update(fs.readFileSync(path.join(appPath, rel)));
  }
  return hash.digest("hex");
}

// ---------- 本机签名证书 ----------

const keychainPass = () => {
  try {
    return fs.readFileSync(keychainPassFile(), "utf8").trim() || null;
  } catch {
    return null;
  }
};

/** 钥匙串里那张证书的 SHA-1（codesign 用它找证书）；没有就是 null */
async function findIdentity() {
  if (!fs.existsSync(keychainFile())) return null;
  const out = await run("/usr/bin/security", ["find-identity", "-p", "codesigning", keychainFile()]).catch(() => "");
  // 不设信任，所以只会出现在「Matching identities」里，带 CSSMERR_TP_NOT_TRUSTED
  const m = out.match(new RegExp(`\\b([0-9A-F]{40}) "${CERT_NAME}"`));
  return m ? m[1] : null;
}

/**
 * 没有就生成：单独的钥匙串（密码随机，存在 0600 的文件里）+ 一张只能用来签代码的自签名证书。
 * 证书不设信任，也不进登录钥匙串，所以不会弹密码框，也不会被拿去冒充 HTTPS 证书。
 */
async function ensureIdentity() {
  const existing = keychainPass() && (await findIdentity());
  if (existing) return existing;
  fs.mkdirSync(dir(), { recursive: true });
  fs.rmSync(keychainFile(), { force: true });
  const pass = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(keychainPassFile(), pass, { mode: 0o600 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loft-sign-"));
  try {
    const cnf = path.join(tmp, "cert.cnf");
    fs.writeFileSync(
      cnf,
      [
        "[req]",
        "distinguished_name=dn",
        "x509_extensions=ext",
        "prompt=no",
        "[dn]",
        `CN=${CERT_NAME}`,
        "[ext]",
        "basicConstraints=critical,CA:false",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=critical,codeSigning",
        "",
      ].join("\n"),
    );
    const key = path.join(tmp, "key.pem");
    const cert = path.join(tmp, "cert.pem");
    const p12 = path.join(tmp, "id.p12");
    const p12Pass = crypto.randomBytes(12).toString("hex");
    // 系统自带的 openssl（LibreSSL）；有效期 20 年
    await run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "7300", "-config", cnf]);
    await run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${p12Pass}`]);
    await run("/usr/bin/security", ["create-keychain", "-p", pass, keychainFile()]);
    // 不自动上锁
    await run("/usr/bin/security", ["set-keychain-settings", keychainFile()]);
    await run("/usr/bin/security", ["unlock-keychain", "-p", pass, keychainFile()]);
    await run("/usr/bin/security", ["import", p12, "-k", keychainFile(), "-P", p12Pass, "-T", "/usr/bin/codesign"]);
    // 让 codesign 用私钥时不弹「允许访问钥匙串」
    await run("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", pass, keychainFile()]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const id = await findIdentity();
  if (!id) throw new Error("生成本机签名证书失败");
  return id;
}

/** 当前用户的钥匙串搜索列表 */
async function searchList() {
  const out = await run("/usr/bin/security", ["list-keychains", "-d", "user"]);
  return out
    .split("\n")
    .map((l) => l.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** 签名。codesign 只在搜索列表里的钥匙串找证书，所以签的时候临时把我们的钥匙串加进去，签完马上恢复 */
async function sign(appPath, signing) {
  if (signing !== "local") {
    await run("/usr/bin/codesign", ["--force", "--sign", "-", appPath]);
    return;
  }
  const id = await ensureIdentity();
  await run("/usr/bin/security", ["unlock-keychain", "-p", keychainPass(), keychainFile()]);
  const before = await searchList();
  const kc = fs.realpathSync(keychainFile());
  const added = !before.includes(kc);
  if (added) await run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...before, kc]);
  try {
    await run("/usr/bin/codesign", ["--force", "--keychain", kc, "--sign", id, appPath]);
  } finally {
    if (added) {
      // 只拿掉我们加的那一个，签名期间别的程序改了列表也不受影响
      const now = await searchList().catch(() => [...before, kc]);
      await run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...now.filter((k) => k !== kc)]).catch(() => {});
    }
  }
}

// ---------- 装 / 卸 ----------

async function install(signing) {
  const src = sourceApp();
  if (!fs.existsSync(exeOf(src))) {
    throw new Error(app.isPackaged ? "这个版本的桌面端没有带 Agent Loft Bridge" : "还没编译 Bridge：先执行 npm run bridge");
  }
  fs.mkdirSync(dir(), { recursive: true });
  const staging = path.join(dir(), `.staging-${process.pid}.app`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(src, staging, { recursive: true, verbatimSymlinks: true });
    // 从下载的 DMG 里带出来的隔离标记去掉，免得系统拦着不让跑
    await run("/usr/bin/xattr", ["-cr", staging]).catch(() => {});
    await sign(staging, signing);
    fs.rmSync(installedApp(), { recursive: true, force: true });
    fs.renameSync(staging, installedApp());
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  // 每次装都换一把调用密钥；确认开关沿用原来的
  const config = readJson(configFile()) ?? {};
  writeJson(configFile(), { confirmWrites: config.confirmWrites !== false, services: { ...DEFAULT_SERVICES, ...config.services }, keyHash: newCallerKey() });
  writeJson(installFile(), { signing, fingerprint: fingerprint(src), installedAt: new Date().toISOString() });
}

async function uninstall() {
  // 撤销系统里给 Bridge 的授权：以后再打开要重新点允许
  for (const service of TCC_SERVICES) await run("/usr/bin/tccutil", ["reset", service, BUNDLE_ID]).catch(() => {});
  callerKeyCache = null;
  if (fs.existsSync(keychainFile())) await run("/usr/bin/security", ["delete-keychain", keychainFile()]).catch(() => {});
  fs.rmSync(dir(), { recursive: true, force: true });
}

// ---------- 主逻辑 ----------

/**
 * @param {{ onChange: () => void }} deps
 */
export function createApple(deps) {
  /** 正在做什么（给界面看）：enable / disable / request:calendars … */
  let busy = null;
  let error = null;
  /** Bridge 报上来的权限状态 */
  let perms = null;

  const installed = () => isMac && fs.existsSync(exeOf(installedApp()));
  const info = () => readJson(installFile());
  const services = () => ({ ...DEFAULT_SERVICES, ...readJson(configFile())?.services });
  const mcp = createAppleMcp({
    file: () => path.join(dir(), "mcp.json"),
    installed,
    services,
    bridge,
    version: app.getVersion(),
    onChange: () => deps.onChange(),
  });

  async function refresh() {
    mcp.sync();
    if (!installed()) {
      perms = null;
    } else {
      try {
        perms = JSON.parse(await bridge(["status"], { timeout: 20_000 }));
      } catch (err) {
        perms = null;
        error = `读不到 Bridge 的状态：${err.message}`;
      }
    }
    deps.onChange();
  }

  async function task(name, fn) {
    if (busy) throw new Error("上一个操作还没做完");
    busy = name;
    error = null;
    deps.onChange();
    try {
      return await fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      busy = null;
      await refresh();
    }
  }

  /** 桌面端更新后包里的 Bridge 变了：按原来的签名方式重装（本机证书签的，权限都还在） */
  async function upgradeIfNeeded() {
    if (!installed()) return;
    const src = sourceApp();
    if (!fs.existsSync(exeOf(src))) return;
    const current = info();
    if (current?.fingerprint === fingerprint(src) && callerKey()) return;
    await task("upgrade", () => install(current?.signing === "adhoc" ? "adhoc" : "local")).catch((err) => console.error("[苹果数据] 更新 Bridge 失败:", err));
  }

  if (isMac) void upgradeIfNeeded().then(refresh);

  return {
    refresh,
    mcp,
    state: () => {
      if (!isMac) return null;
      const i = installed() ? info() : null;
      return {
        available: fs.existsSync(exeOf(sourceApp())),
        installed: installed(),
        signing: i?.signing ?? null,
        perms,
        confirmWrites: readJson(configFile())?.confirmWrites !== false,
        services: services(),
        mcp: mcp.state(),
        busy,
        error,
      };
    },
    /** 打开：signing 是 local（建本机证书）或 adhoc */
    enable: (signing) => task("enable", () => install(signing === "adhoc" ? "adhoc" : "local")),
    disable: () =>
      task("disable", async () => {
        mcp.stop();
        await uninstall();
      }),
    /** 换签名方式：重新装一遍。换了以后系统当成新程序，权限要重新授权 */
    resign: (signing) =>
      task("resign", async () => {
        await install(signing === "adhoc" ? "adhoc" : "local");
        if (signing === "adhoc") {
          // 不用证书了，证书也删掉
          if (fs.existsSync(keychainFile())) await run("/usr/bin/security", ["delete-keychain", keychainFile()]).catch(() => {});
          fs.rmSync(keychainPassFile(), { force: true });
        }
      }),
    /** 弹系统授权框（备忘录要先在后台打开「备忘录」）；用户在框里点完才返回 */
    request: (kind) => {
      if (!PRIVACY_PANES[kind]) throw new Error("未知的权限");
      return task(`request:${kind}`, () => bridge(["request", kind], { timeout: 10 * 60_000 }));
    },
    openPrivacy: (kind) => {
      const pane = PRIVACY_PANES[kind];
      if (pane) void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    },
    /** 打开 / 关掉某个应用：关掉后智能体看不到它的工具，Bridge 也不碰它（系统授权不撤） */
    setService: (name, on) => {
      if (!installed() || !(name in DEFAULT_SERVICES)) return;
      const cfg = readJson(configFile()) ?? {};
      writeJson(configFile(), { ...cfg, services: { ...DEFAULT_SERVICES, ...cfg.services, [name]: !!on } });
      void refresh();
    },
    setConfirmWrites: (on) => {
      if (!installed()) return;
      writeJson(configFile(), { ...readJson(configFile()), confirmWrites: !!on });
      void refresh();
    },
  };
}
