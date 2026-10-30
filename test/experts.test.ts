import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-experts-"));
process.env.AGENT_LOFT_HOME = home;
// 机器上的 Claude MCP：假的家目录里放一份 ~/.claude.json
const fakeHome = path.join(home, "home");
process.env.HOME = fakeHome;
delete process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(fakeHome, { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: { nas: { command: "nas-mcp", args: ["--x"] }, web: { type: "http", url: "https://mcp.example.com" } } }));
const workspace = path.join(home, "ws");
fs.mkdirSync(path.join(workspace, "proj"), { recursive: true });
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ workspaceRoot: workspace }));
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const skills = await import("../src/core/skills.js");
const experts = await import("../src/core/experts.js");
const mcp = await import("../src/core/mcp.js");
const prompt = await import("../src/core/expert-prompt.js");
const { expertOptions } = await import("../src/agents/claude/session.js");
const { expertConfig, codexMcp } = await import("../src/agents/codex/session.js");
const { purgeUserData } = await import("../src/core/personal.js");
const skillRuntime = await import("../src/core/skill-runtime.js");

const admin = users.createUser({ name: "boss", password: "password-1", role: "admin" });
const alice = users.createUser({ name: "alice", password: "password-1", role: "member" });
const bob = users.createUser({ name: "bob", password: "password-1", role: "member" });

const subPrompt = (sub: { name: string; prompt: string; webSearch: boolean; webFetch: boolean }, access: "web" | "read" | "edit" | "exec") =>
  prompt.expertSystemPrompt({ ...sub, access }, prompt.searchLabel("claude", sub), "/tmp");

test("专家：校验、改了加版本号、不能换引擎、按人隔离", () => {
  assert.throws(() => experts.createExpert(alice.id, { engine: "claude", access: "web" }), /起个名字/);
  assert.throws(() => experts.createExpert(alice.id, { name: "x", engine: "gpt", access: "web" }), /引擎/);
  assert.throws(() => experts.createExpert(alice.id, { name: "x", engine: "claude", access: "root" }), /权限/);
  const e = experts.createExpert(alice.id, { name: "写手", engine: "claude", access: "edit", cwd: "proj", model: "sonnet", color: "#112233" });
  assert.equal(e.cwd, path.join(workspace, "proj"));
  assert.equal(e.rev, 1);
  assert.equal(e.webSearch, true, "联网默认开");
  assert.equal(e.memory, true, "记忆默认带");
  assert.throws(() => experts.createExpert(alice.id, { name: "x", engine: "claude", access: "read", cwd: "/etc" }), /工作区之内/);
  const next = experts.updateExpert(alice.id, e.id, { model: "", cwd: "" });
  assert.equal(next.rev, 2);
  assert.equal(next.model, undefined, "清空的可选项不被旧值补回来");
  assert.equal(next.cwd, undefined);
  assert.equal(next.name, "写手", "没传的字段沿用");
  assert.throws(() => experts.updateExpert(alice.id, e.id, { engine: "codex" }), /不能换引擎/);
  assert.throws(() => experts.updateExpert(bob.id, e.id, { name: "偷" }), /不存在/);
  assert.equal(experts.canUseExpert(alice.id, e.id), true);
  assert.equal(experts.canUseExpert(bob.id, e.id), false);
  assert.equal(experts.canUseExpert(bob.id, "codex"), true, "内置的谁都能用");
  assert.equal(experts.canUseExpert(undefined, e.id), false);
  // 只能联网的不留工作目录
  assert.equal(experts.createExpert(alice.id, { name: "聊", engine: "claude", access: "web", cwd: "proj" }).cwd, undefined);
});

test("头像：只收图片 data URL，没传沿用、传空去掉；地址带版本号", () => {
  const png = `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`;
  const e = experts.createExpert(alice.id, { name: "有头像的", engine: "claude", access: "web", avatar: png });
  assert.equal(e.avatar, png);
  assert.equal(experts.avatarUrl(e), `/api/experts/${e.id}/avatar?v=1`);
  assert.deepEqual(experts.avatarImage(e), { type: "image/png", data: Buffer.from("fake-png") });
  assert.throws(() => experts.createExpert(alice.id, { name: "x", engine: "claude", access: "web", avatar: "data:text/html;base64,PGI+" }), /头像只能是/);
  assert.throws(() => experts.createExpert(alice.id, { name: "x", engine: "claude", access: "web", avatar: "https://example.com/a.png" }), /头像只能是/);
  // 改别的不传头像：沿用
  const renamed = experts.updateExpert(alice.id, e.id, { name: "改了名" });
  assert.equal(renamed.avatar, png);
  assert.equal(experts.avatarUrl(renamed), `/api/experts/${e.id}/avatar?v=2`);
  // 传空：去掉
  const cleared = experts.updateExpert(alice.id, e.id, { avatar: "" });
  assert.equal(cleared.avatar, undefined);
  assert.equal(experts.avatarUrl(cleared), "");
  experts.deleteExpert(alice.id, e.id);
});

test("头像存成单独的图片文件，experts.json 里只记文件名；以前存在 JSON 里的读进来拆出去；删了专家图片也删", () => {
  const store = path.join(home, "data", "experts.json");
  const dir = path.join(home, "data", "expert-avatars");
  const png = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
  const e = experts.createExpert(alice.id, { name: "文件头像", engine: "claude", access: "web", avatar: png });
  assert.deepEqual(fs.readFileSync(path.join(dir, `${e.id}.png`)), Buffer.from("png-bytes"));
  const saved = JSON.parse(fs.readFileSync(store, "utf8")).find((x: { id: string }) => x.id === e.id);
  assert.equal(saved.avatar, undefined);
  assert.equal(saved.avatarFile, `${e.id}.png`);
  experts.resetExpertCache();
  assert.equal(experts.getExpert(e.id)?.avatar, png, "重新读进来还原成 data URL");

  // 老版本：data URL 直接在 JSON 里
  const jpg = `data:image/jpeg;base64,${Buffer.from("jpg-bytes").toString("base64")}`;
  const all = JSON.parse(fs.readFileSync(store, "utf8"));
  fs.writeFileSync(store, JSON.stringify(all.map((x: { id: string; avatarFile?: string }) => (x.id === e.id ? { ...x, avatarFile: undefined, avatar: jpg } : x))));
  experts.resetExpertCache();
  assert.equal(experts.getExpert(e.id)?.avatar, jpg);
  assert.ok(fs.existsSync(path.join(dir, `${e.id}.jpg`)), "拆出去了");
  assert.ok(!fs.existsSync(path.join(dir, `${e.id}.png`)), "旧格式的图片删了");
  assert.ok(!fs.readFileSync(store, "utf8").includes("base64"));

  experts.deleteExpert(alice.id, e.id);
  assert.ok(!fs.existsSync(path.join(dir, `${e.id}.jpg`)));
});

test("子智能体：只能是自己的 Claude 专家、权限不超过主专家；删掉后从别人的列表里去掉", () => {
  const reader = experts.createExpert(alice.id, { name: "Doc Reader", engine: "claude", access: "read", description: "读文档" });
  const runner = experts.createExpert(alice.id, { name: "跑命令", engine: "claude", access: "exec" });
  const cx = experts.createExpert(alice.id, { name: "cx", engine: "codex", access: "web" });
  const bobs = experts.createExpert(bob.id, { name: "bob 的", engine: "claude", access: "web" });
  assert.throws(() => experts.createExpert(alice.id, { name: "主", engine: "claude", access: "read", subagents: [runner.id] }), /不能超过主专家/);
  assert.throws(() => experts.createExpert(alice.id, { name: "主", engine: "claude", access: "read", subagents: [cx.id] }), /Codex 专家/);
  const main = experts.createExpert(alice.id, { name: "主", engine: "claude", access: "edit", subagents: [reader.id, bobs.id, "e_nope"] });
  assert.deepEqual(main.subagents, [reader.id], "别人的、不存在的直接去掉");
  assert.throws(() => experts.updateExpert(alice.id, main.id, { subagents: [main.id] }), /不能是它自己/);
  assert.deepEqual(experts.createExpert(alice.id, { name: "cx2", engine: "codex", access: "edit", subagents: [reader.id] }).subagents, [], "Codex 不支持子智能体");

  // 子智能体后来升了权限：运行时封顶在主专家的权限
  experts.updateExpert(alice.id, reader.id, { access: "exec" });
  const rt = experts.expertRuntime(experts.getExpert(main.id)!, subPrompt);
  assert.equal(rt.subagents.length, 1);
  assert.equal(rt.subagents[0]!.access, "edit");
  assert.equal(rt.subagents[0]!.key, "doc-reader");
  assert.match(rt.subagents[0]!.prompt, /你是「Doc Reader」/);

  experts.deleteExpert(alice.id, reader.id);
  assert.deepEqual(experts.getExpert(main.id)!.subagents, []);
  assert.equal(experts.getExpert(main.id)!.rev, 2, "被动改了也加版本号（会话要换新）");
});

test("MCP：按人管理、密钥不回显、留空沿用；成员选不了机器上的", () => {
  assert.throws(() => mcp.createMcp(alice.id, { name: "Bad Name", type: "stdio", command: "x" }), /名字/);
  assert.throws(() => mcp.createMcp(alice.id, { name: "agent_loft_memory", type: "stdio", command: "x" }), /agent-loft 自己用/);
  assert.throws(() => mcp.createMcp(alice.id, { name: "h", type: "http", url: "ftp://x" }), /http/);
  const s = mcp.createMcp(alice.id, {
    name: "akshare",
    type: "stdio",
    command: "python",
    args: ["-m", "server"],
    env: [
      { name: "TOKEN", value: "sekrit", secret: true },
      { name: "MODE", value: "prod" },
    ],
  });
  assert.throws(() => mcp.createMcp(alice.id, { name: "akshare", type: "stdio", command: "y" }), /已经有/);
  mcp.createMcp(bob.id, { name: "akshare", type: "stdio", command: "y" });
  const view = mcp.mcpView(s);
  assert.equal(JSON.stringify(view).includes("sekrit"), false);
  assert.deepEqual((view as { env: unknown[] }).env[0], { name: "TOKEN", secret: true, set: true });
  // 改别的、密钥留空：沿用原值
  const updated = mcp.updateMcp(alice.id, s.id, { env: [{ name: "TOKEN", value: "", secret: true }, { name: "MODE", value: "dev" }] });
  assert.deepEqual(mcp.specOf(updated), { type: "stdio", command: "python", args: ["-m", "server"], env: { TOKEN: "sekrit", MODE: "dev" } });
  const http = mcp.createMcp(alice.id, { name: "remote", type: "http", url: "https://api.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer t", secret: true }], ask: true });

  const e = experts.createExpert(alice.id, { name: "股票", engine: "claude", access: "web", mcp: [s.id, http.id, "machine:nas", "m_nope"] });
  assert.deepEqual(e.mcp, [s.id, http.id], "成员选不了机器上的；不存在的去掉");
  const bobE = experts.createExpert(bob.id, { name: "b", engine: "claude", access: "web", mcp: [s.id] });
  assert.deepEqual(bobE.mcp, [], "选不了别人的");
  const rt = experts.expertRuntime(e, subPrompt);
  assert.deepEqual(Object.keys(rt.mcp).sort(), ["akshare", "remote"]);
  assert.deepEqual(rt.askMcp, ["remote"]);
  assert.deepEqual(rt.mcp.remote, { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer t" } });

  // 管理员能选机器上的：Claude 读 ~/.claude.json，Codex 只要名字
  const adminClaude = experts.createExpert(admin.id, { name: "a", engine: "claude", access: "web", mcp: ["machine:nas", "machine:gone"] });
  const art = experts.expertRuntime(adminClaude, subPrompt);
  assert.deepEqual(art.mcp, { nas: { type: "stdio", command: "nas-mcp", args: ["--x"], env: {} } });
  const adminCodex = experts.createExpert(admin.id, { name: "b", engine: "codex", access: "web", mcp: ["machine:nas"] });
  assert.deepEqual(experts.expertRuntime(adminCodex, subPrompt).machineMcp, ["nas"]);

  // Codex 的 mcp_servers 写法
  assert.deepEqual(codexMcp(rt.mcp), {
    "mcp_servers.akshare": { command: "python", args: ["-m", "server"], env: { TOKEN: "sekrit", MODE: "dev" }, enabled: true, default_tools_approval_mode: "approve" },
    "mcp_servers.remote": { url: "https://api.example.com/mcp", http_headers: { Authorization: "Bearer t" }, enabled: true, default_tools_approval_mode: "approve" },
  });
  const asked = codexMcp(rt.mcp, rt.askMcp);
  assert.equal((asked["mcp_servers.akshare"] as Record<string, unknown>).default_tools_approval_mode, "approve");
  assert.equal((asked["mcp_servers.remote"] as Record<string, unknown>).default_tools_approval_mode, "prompt");
});

test("Claude：按权限给工具，技能只给选中的，子智能体转成 agents", () => {
  const s1 = skills.createSkill(alice.id, { name: "notes", description: "记笔记", body: "写到 notes.md" }, "manual");
  skills.createSkill(alice.id, { name: "other", description: "别的", body: "x" }, "manual");
  const base = { cwd: "/tmp/w", uploadsDir: "/tmp/u" };
  const make = (input: Record<string, unknown>) => experts.expertRuntime(experts.createExpert(alice.id, { name: "t", engine: "claude", ...input }), subPrompt);
  const runtime = skillRuntime;

  const web = expertOptions({ ...base, expert: make({ access: "web", webFetch: false }) });
  assert.deepEqual(web.tools, ["WebSearch"]);
  assert.match((web.systemPrompt as { prompt: string }).prompt, /不能读写这台机器上的文件/);

  const read = expertOptions({ ...base, expert: make({ access: "read", webSearch: false, webFetch: false }) });
  assert.ok((read.tools as string[]).includes("Read") && !(read.tools as string[]).includes("Edit") && !(read.tools as string[]).includes("Bash"));
  assert.match((read.systemPrompt as { prompt: string }).prompt, /你不能联网/);

  const edit = expertOptions({ ...base, expert: make({ access: "edit" }) });
  assert.ok((edit.tools as string[]).includes("Edit") && (edit.tools as string[]).includes("Write") && !(edit.tools as string[]).includes("Bash"));

  const exec = expertOptions({ ...base, expert: make({ access: "exec", webSearch: false }) });
  assert.equal(exec.tools, undefined, "能跑命令的不限工具");
  assert.deepEqual(exec.disallowedTools, ["WebSearch", "Agent"]);

  // 技能：白名单只有选中的，挂插件目录、给 Skill 工具
  const withSkill = make({ access: "web", skills: [s1.id] });
  const sk = expertOptions({ ...base, expert: withSkill, skills: runtime.sessionSkills(alice.id, withSkill.skills) });
  assert.deepEqual(sk.skills, ["loft:notes"]);
  assert.ok((sk.tools as string[]).includes("Skill"));
  assert.ok(sk.plugins?.length === 1);
  const noSkill = expertOptions({ ...base, expert: make({ access: "web" }), skills: runtime.sessionSkills(alice.id, []) });
  assert.deepEqual(noSkill.skills, []);
  assert.equal(noSkill.plugins, undefined, "没选技能就不挂插件、不给 Skill 工具（省 token）");
  assert.ok(!(noSkill.tools as string[]).includes("Skill"));

  // 原装提示词：追加在 Claude Code 的后面，读项目设置
  const cc = expertOptions({ ...base, expert: make({ access: "exec", basePrompt: "claude_code", prompt: "你是运维" }) });
  const sp = cc.systemPrompt as { type: string; preset: string; append: string };
  assert.equal(sp.type, "preset");
  assert.match(sp.append, /你是运维/);
  assert.deepEqual(cc.settingSources, ["project"]);

  // 子智能体
  const helper = experts.createExpert(alice.id, { name: "Researcher", engine: "claude", access: "web", description: "查资料", model: "haiku" });
  const lead = experts.expertRuntime(experts.createExpert(alice.id, { name: "lead", engine: "claude", access: "read", subagents: [helper.id] }), subPrompt);
  const lo = expertOptions({ ...base, expert: lead });
  assert.ok((lo.tools as string[]).includes("Agent"));
  assert.deepEqual(Object.keys(lo.agents ?? {}), ["researcher"]);
  assert.equal(lo.agents!.researcher!.description, "查资料");
  assert.equal(lo.agents!.researcher!.model, "haiku");
  assert.deepEqual(lo.agents!.researcher!.tools, ["WebSearch", "WebFetch"]);
  assert.match((lo.systemPrompt as { prompt: string }).prompt, /researcher/);
});

test("Claude：只有子智能体选技能时也加载插件，主专家的技能白名单不扩大", () => {
  const skill = skills.createSkill(alice.id, { name: "helper-only", description: "子智能体专用", body: "查资料" }, "manual");
  const helper = experts.createExpert(alice.id, { name: "Skilled Helper", engine: "claude", access: "web", skills: [skill.id] });
  const lead = experts.createExpert(alice.id, { name: "No Skills Lead", engine: "claude", access: "web", skills: [], subagents: [helper.id] });
  const rt = experts.expertRuntime(lead, subPrompt);
  const session = skillRuntime.sessionSkills(alice.id, rt.skills)!;
  const options = expertOptions({ cwd: workspace, uploadsDir: workspace, expert: rt, skills: session });
  assert.deepEqual(session.list, [], "主专家不拿子智能体的技能清单");
  assert.deepEqual(options.skills, [], "主专家的白名单仍为空");
  assert.equal(options.plugins?.length, 1, "子智能体的技能插件必须挂载");
  assert.ok(fs.existsSync(path.join(session.pluginDir!, "skills", "helper-only", "SKILL.md")));
  assert.ok((options.tools as string[]).includes("Skill"), "子智能体继承的工具不能缺少 Skill");
  assert.deepEqual(options.agents!["skilled-helper"]!.skills, ["loft:helper-only"]);

  skills.setSkillEnabled(alice.id, skill.id, false);
  const disabled = experts.expertRuntime(lead, subPrompt);
  const without = expertOptions({ cwd: workspace, uploadsDir: workspace, expert: disabled, skills: skillRuntime.sessionSkills(alice.id, []) });
  assert.equal(without.plugins, undefined, "停用后不再挂子智能体的技能插件");
});

test("Codex：按权限打开 shell / apply_patch，背景里写专家", () => {
  const e = experts.expertRuntime(experts.createExpert(alice.id, { name: "cx", engine: "codex", access: "web", webSearch: false, prompt: "简短回答" }), subPrompt);
  const web = expertConfig(e);
  assert.equal(web["features.shell_tool"], false);
  assert.equal(web.web_search, "disabled");
  const edit = expertConfig({ ...e, access: "edit", webSearch: true });
  assert.equal(edit["features.shell_tool"], true);
  assert.equal(edit.include_apply_patch_tool, true);
  assert.equal(edit.web_search, "live");
  const read = expertConfig({ ...e, access: "read" });
  assert.equal(read["features.shell_tool"], true);
  assert.equal(read.include_apply_patch_tool, false);

  const block = prompt.contextBlock({ prompt: e, cwd: "/w" }, "记忆", ["## 技能"]);
  assert.match(block, /你是「cx」/);
  assert.match(block, /简短回答/);
  assert.match(block, /你不能联网/);
  assert.match(block, /记忆/);
  assert.match(block, /```chart/, "回复里能画图");
  const builtin = prompt.contextBlock(undefined, undefined, []);
  assert.match(builtin, /```chart/, "内置专家没记忆没技能：也告诉它能画图");
  assert.doesNotMatch(builtin, /你是「/);
});

test("删用户：专家和 MCP 一起删", () => {
  const carol = users.createUser({ name: "carol", password: "password-1" });
  experts.createExpert(carol.id, { name: "c", engine: "claude", access: "web" });
  mcp.createMcp(carol.id, { name: "c", type: "stdio", command: "x" });
  purgeUserData(carol.id);
  assert.equal(experts.listExperts(carol.id).length, 0);
  assert.equal(mcp.listMcp(carol.id).length, 0);
});
