// 回复里提到的文件：路径有没有在回复里写过、敏感文件挡不挡得住、路径怎么解析。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-reply-files-"));
const { expandPath, isSensitivePath, mentions, resolveReplyFile } = await import("../src/core/reply-files.js");
const { saveBuffer } = await import("../src/core/uploads.js");

test("mentions 认完整写出来的路径，不认别的路径里的一截", () => {
  const reply = "改好了，见 [对应代码](/home/u/proj/src/a.ts:12)，备份在 `./backup/b.tar.gz`。报告：/tmp/报告.pdf。";
  assert.ok(mentions(reply, "/home/u/proj/src/a.ts"));
  assert.ok(mentions(reply, "./backup/b.tar.gz"));
  assert.ok(mentions(reply, "/tmp/报告.pdf"));
  // 只是别的路径的一部分
  assert.ok(!mentions(reply, "src/a.ts"));
  assert.ok(!mentions(reply, "/home/u/proj/src/a"));
  assert.ok(!mentions(reply, "/home/u"));
  assert.ok(!mentions(reply, "/etc/passwd"));
  assert.ok(!mentions(reply, ""));
});

test("mentions 认百分号编码过的链接地址", () => {
  assert.ok(mentions("[文件](/tmp/my%20file.md)", "/tmp/my file.md"));
  assert.ok(mentions("[文件](/tmp/%E6%8A%A5%E5%91%8A.md)", "/tmp/报告.md"));
});

test("isSensitivePath 挡住私钥、凭据和 agent-loft 自己的数据", () => {
  const home = os.homedir();
  for (const p of [
    path.join(home, ".ssh/id_ed25519"),
    path.join(home, ".ssh/config"),
    path.join(home, ".aws/credentials"),
    path.join(home, ".codex/auth.json"),
    path.join(home, ".claude/.credentials.json"),
    path.join(home, ".config/gh/hosts.yml"),
    "/srv/app/.env",
    "/srv/app/.env.production",
    "/srv/certs/server.key",
    "/etc/shadow",
    "/proc/self/environ",
    path.join(process.env.AGENT_LOFT_HOME!, "config.json"),
    path.join(process.env.AGENT_LOFT_HOME!, "data/users.json"),
  ]) {
    assert.ok(isSensitivePath(p), p);
  }
  for (const p of ["/srv/app/.env.example", "/tmp/report.pdf", path.join(home, "project/a/README.md"), "/etc/hosts"]) {
    assert.ok(!isSensitivePath(p), p);
  }
});

test("resolveReplyFile 相对路径按工作目录算，目录、不存在、敏感的都不给", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-cwd-"));
  fs.mkdirSync(path.join(dir, "out"));
  fs.writeFileSync(path.join(dir, "out/r.md"), "# hi");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
  fs.symlinkSync(path.join(dir, ".env"), path.join(dir, "innocent.txt"));
  const real = fs.realpathSync(path.join(dir, "out/r.md"));
  assert.equal(resolveReplyFile("out/r.md", dir), real);
  assert.equal(resolveReplyFile("./out/r.md", dir), real);
  assert.equal(resolveReplyFile(`file://${path.join(dir, "out/r.md")}`, "/"), real);
  assert.equal(resolveReplyFile("out", dir), undefined);
  assert.equal(resolveReplyFile("out/none.md", dir), undefined);
  assert.equal(resolveReplyFile(".env", dir), undefined);
  // 符号链接指向敏感文件
  assert.equal(resolveReplyFile("innocent.txt", dir), undefined);
  assert.equal(expandPath("~/a.md", "/"), path.join(os.homedir(), "a.md"));
});

test("上传目录里的附件不算 agent-loft 的敏感数据", () => {
  const a = saveBuffer({ key: "web:t", data: Buffer.from("x"), name: "a.txt" });
  assert.equal(resolveReplyFile(a.path, "/"), fs.realpathSync(a.path));
});

test("htmlDocument 片段套上外壳并带上报高度的脚本，完整页面原样只加脚本", async () => {
  process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-codex-"));
  const { htmlDocument, HTML_CSP } = await import("../src/core/visualize.js");
  // 没装插件：用兜底样式
  const bare = htmlDocument('<div id="x">hi</div>', "a<b>.html");
  assert.match(bare, /^<!doctype html>/);
  assert.match(bare, /<div id="x">hi<\/div>/);
  assert.match(bare, /--viz-series-1/);
  assert.match(bare, /<title>a&lt;b&gt;.html<\/title>/);
  assert.match(bare, /aloft-html-size/);
  // 装了插件：片段放进插件的模板里（$& 之类不能被当成替换模式）
  const assets = path.join(process.env.CODEX_HOME, "plugins/cache/openai-bundled/visualize/1.0.9/skills/visualize/assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "visualize.css"), ":root{--from-plugin:1}");
  fs.writeFileSync(path.join(assets, "visualize.html"), "<!--__INLINE_VISUALIZATION_FRAGMENT__--><script>kit()</script>");
  const wrapped = htmlDocument("<p>price $& $1</p>", "c.html");
  assert.match(wrapped, /--from-plugin/);
  assert.ok(wrapped.includes("<p>price $& $1</p><script>kit()</script>"));
  // 完整页面
  const full = htmlDocument("<!doctype html><html><body><p>x</p></body></html>", "d.html");
  assert.match(full, /<p>x<\/p><script>.*aloft-html-size.*<\/script><\/body>/s);
  // 沙箱、不能联网请求
  assert.match(HTML_CSP, /^sandbox allow-scripts;/);
  assert.doesNotMatch(HTML_CSP, /allow-same-origin/);
  assert.match(HTML_CSP, /connect-src blob: data:;/);
});
