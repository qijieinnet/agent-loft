import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { localInstallScript, trackedInstallScript, waitForInstallResult } from "../src/local-server.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loft-install-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Exercise shell quoting, including the nested EXIT trap.
  const home = path.join(dir, "home with 'quotes' and $dollars");
  const bin = path.join(dir, "bin");
  const result = path.join(home, "result 'quoted'");
  fs.mkdirSync(bin, { recursive: true });
  const executable = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  executable(path.join(bin, "node"), 'exit "${NODE_STATUS:-0}"');
  executable(path.join(bin, "npm"), 'printf "%s\\n" "$@" > "$HOME/npm-args"\nexit "${NPM_STATUS:-0}"');
  executable(path.join(home, ".local/bin/agent-loft"), 'printf "%s\\n" "$@" > "$HOME/service-args"\nexit "${SERVICE_STATUS:-0}"');
  executable(path.join(bin, "agent-loft"), 'echo "Wrong agent-loft from PATH" >&2\nexit 99');
  return { dir, home, bin, result, executable };
}

const shells = process.platform === "win32" ? [] : process.platform === "darwin" ? ["/bin/bash", "/bin/zsh"] : ["/bin/bash"];
for (const shell of shells) {
  for (const platform of ["darwin", "linux"]) {
    for (const [label, extraEnv, expected] of [
      ["success", {}, 0],
      ["npm EACCES", { NPM_STATUS: "243" }, 1],
      ["service registration failure", { SERVICE_STATUS: "7" }, 1],
      ["old or broken Node", { NODE_STATUS: "1" }, 1],
    ]) {
      test(`${path.basename(shell)} / ${platform}: ${label}`, async (t) => {
        const f = fixture(t);
        const script = `(\n${trackedInstallScript(f.result, localInstallScript(platform))}\n)\n# Terminal remains open after the installer exits.\ntrue`;
        const run = spawnSync(shell, ["-c", script], {
          env: { HOME: f.home, PATH: f.bin, ...extraEnv }, encoding: "utf8", timeout: 5000,
        });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stderr);
        assert.equal(fs.readFileSync(f.result, "utf8").trim(), String(expected), run.stderr);
        if (expected === 0) {
          await waitForInstallResult(f.result, { timeoutMs: 200, pollMs: 5 });
          assert.equal(fs.readFileSync(path.join(f.home, "npm-args"), "utf8"), `install\n-g\n--prefix\n${f.home}/.local\nagent-loft\n`);
          assert.equal(fs.readFileSync(path.join(f.home, "service-args"), "utf8"), "service\ninstall\n");
        } else {
          await assert.rejects(waitForInstallResult(f.result, { timeoutMs: 200, pollMs: 5 }), /安装失败或已中断/);
          if (extraEnv.NPM_STATUS || extraEnv.NODE_STATUS) assert.equal(fs.existsSync(path.join(f.home, "service-args")), false);
        }
      });
    }
  }
  test(`${path.basename(shell)}: Homebrew Node takes precedence over existing old Node`, (t) => {
    const f = fixture(t);
    const brewPrefix = path.join(f.dir, "Homebrew Node");
    f.executable(path.join(brewPrefix, "bin/node"), "exit 0");
    f.executable(path.join(f.bin, "brew"), 'case "$1" in\ninstall) exit 0 ;;\n--prefix) printf "%s\\n" "$BREW_NODE_PREFIX" ;;\n*) exit 1 ;;\nesac');
    const run = spawnSync(shell, ["-c", trackedInstallScript(f.result, localInstallScript("darwin"))], {
      env: { HOME: f.home, PATH: f.bin, NODE_STATUS: "1", BREW_NODE_PREFIX: brewPrefix }, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(f.result, "utf8").trim(), "0");
    assert.equal(fs.readFileSync(path.join(f.home, "service-args"), "utf8"), "service\ninstall\n");
  });
  test(`${path.basename(shell)}: interrupted installer reports failure`, async (t) => {
    const f = fixture(t);
    const run = spawnSync(shell, ["-c", trackedInstallScript(f.result, "kill -s INT $$\nexit 0")], {
      encoding: "utf8", timeout: 5000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 130, run.stderr);
    await assert.rejects(waitForInstallResult(f.result, { timeoutMs: 200, pollMs: 5 }), /安装失败或已中断/);
  });
}

test("waits for completion and ignores an empty result file", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.result, "");
  const timer = setTimeout(() => fs.writeFileSync(f.result, "0\n"), 20);
  t.after(() => clearTimeout(timer));
  await waitForInstallResult(f.result, { timeoutMs: 1000, pollMs: 5 });
});

test("missing completion times out instead of waiting indefinitely", async (t) => {
  const f = fixture(t);
  await assert.rejects(waitForInstallResult(f.result, { timeoutMs: 20, pollMs: 5 }), /等待安装超时/);
});
