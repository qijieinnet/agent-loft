import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readRelease, releaseRoot, releaseStore, stageRelease } from "../src/core/upgrade-releases.js";
import { verifyUpgradeWeb } from "../src/core/upgrade-health.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
function fixture(t: TestContext) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loft-upgrade-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, process.platform === "win32" ? "" : "lib", "node_modules/agent-loft");
  const cli = path.join(root, "bin/cli.js");
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(repo, "bin"), path.join(root, "bin"), { recursive: true });
  fs.cpSync(path.join(repo, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(repo, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web/index.html"), "online");
  fs.mkdirSync(path.join(tmp, "bin"));
  if (process.platform === "win32") fs.writeFileSync(path.join(tmp, "agent-loft.cmd"), "");
  else fs.symlinkSync(cli, path.join(tmp, "bin/agent-loft"));
  return { root, tmp, cli, store: releaseStore(root) };
}

test("升级接口并发调用且 npm 安装包返回 404，保留原网页、命令和 npm 错误", async t => {
  const { root, tmp, cli, store } = fixture(t);
  const version = "99.0.0";
  let tarballRequests = 0;
  const registry = http.createServer((req, res) => {
    if (req.url === "/agent-loft") {
      const pkg = { name: "agent-loft", version, dist: { tarball: `http://${req.headers.host}/missing.tgz` } };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: pkg.name, "dist-tags": { latest: version }, versions: { [version]: pkg } }));
    } else {
      tarballRequests++;
      assert.equal(fs.readFileSync(path.join(root, "web/index.html"), "utf8"), "online");
      assert.match(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }), /agent-loft start/);
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => registry.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => registry.close());
  const script = `import {beginUpgrade, upgrade, upgradeStatus} from ${JSON.stringify(pathToFileURL(path.join(root, "src/core/upgrade.ts")).href)};
    beginUpgrade();
    if (!upgradeStatus().upgrading) throw Error("missing install state");
    try { await upgrade(); } catch (err) { console.log(err.message); }
    while (upgradeStatus().upgrading) await new Promise(resolve => setTimeout(resolve, 25));
    console.log(upgradeStatus().error);`;
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: root, env: { ...process.env, AGENT_LOFT_HOME: path.join(tmp, "home"),
      npm_config_registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
      npm_config_cache: path.join(tmp, "cache"), npm_config_fetch_retries: "0" },
  });
  assert.ok(tarballRequests > 0);
  assert.match(stdout, /404/);
  assert.match(stdout, /正在升级/);
  assert.deepEqual(fs.readdirSync(store), []);
});

test("新版通过验证才生效，下一次升级启动失败会继续使用已验证版本", async t => {
  const { root, cli, store } = fixture(t);
  async function prepare(from: string, version: string, source: string) {
    await stageRelease(from, version, async prefix => {
      const dir = releaseRoot(store, { slot: path.basename(prefix), version });
      for (const file of ["src/main.ts", "web/index.html", "web/app.js", "web/css/base.css", "bin/cli.js"]) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), file === "bin/cli.js" ? source : "fixture");
      }
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "agent-loft", version }));
      return "ok";
    }, async file => { await exec(process.execPath, [file, "--help"]); });
  }
  const run = async (...args: string[]) => (await exec(process.execPath, [cli, ...args])).stdout;
  await prepare(root, "1.0.0", `if (process.env.AGENT_LOFT_UPGRADE_TRIAL && process.send) {
    process.send({type:"upgrade-health",version:"1.0.0"});
  } console.log("first release");`);
  assert.match(await run("--help"), /agent-loft start/);
  assert.match(await run("start"), /已验证并启用 1.0.0/);
  const first = readRelease(store, "active")!;
  assert.equal(first.version, "1.0.0");
  assert.equal(readRelease(store, "pending"), undefined);
  assert.match(await run("--help"), /first release/);
  await prepare(releaseRoot(store, first), "2.0.0", 'if (process.argv[2] === "start") process.exit(3);');
  assert.match(await run("start"), /first release/);
  assert.deepEqual(readRelease(store, "active"), first);
  assert.equal(readRelease(store, "pending"), undefined);
  assert.match(fs.readFileSync(path.join(store, "last-error"), "utf8"), /2.0.0.*已回退/);
});

test("重启检查读取首页引用的实际 JS、CSS 和 API，资源 404 会拒绝新版", async t => {
  let broken = false;
  const server = http.createServer((req, res) => {
    const files: Record<string, [string, string]> = {
      "/": ["text/html", '<link href="/v/abc/css/base.css"><script src="/v/abc/app.js"></script>'],
      "/v/abc/app.js": ["text/javascript", "ready()"], "/v/abc/css/base.css": ["text/css", ".ready{}"],
      "/api/me": ["application/json", '{"authed":false}'],
    };
    const file = files[req.url!];
    if (!file || (broken && req.url === "/v/abc/app.js")) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file[0] }).end(file[1]);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  await verifyUpgradeWeb("0.0.0.0", port);
  broken = true;
  await assert.rejects(verifyUpgradeWeb("0.0.0.0", port), /app\.js.*404/);
});
