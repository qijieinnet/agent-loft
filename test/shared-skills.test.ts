import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-shared-skills-"));
process.env.AGENT_LOFT_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), "{}");
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const skills = await import("../src/core/skills.js");
const { handleSkillsApi } = await import("../src/channels/web/skills-api.js");
const { HttpError, sendJson } = await import("../src/channels/web/http.js");
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("共享技能 HTTP：默认私有、指定用户、公开安装、更新与撤回、变量隔离和作者权限", async (t) => {
  const author = users.createUser({ name: "author", password: "password-1" });
  const reader = users.createUser({ name: "reader", password: "password-1" });
  const stranger = users.createUser({ name: "stranger", password: "password-1" });
  const admin = users.createUser({ name: "admin", password: "password-1", role: "admin" });
  // 测试专用 HTTP 外壳；生产入口的登录态和 Origin 校验沿用现有逻辑。
  const server = http.createServer(async (req, res) => {
    try {
      const user = users.getUser(String(req.headers["x-test-user"]));
      if (!user) throw new HttpError(401, "未登录");
      if (!await handleSkillsApi(req, res, new URL(req.url!, "http://localhost"), user)) throw new HttpError(404, "不存在");
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 500, { error: String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (user: typeof author, endpoint = "", method = "GET", body?: unknown) => fetch(`${base}/api/skills${endpoint}`, {
    method,
    headers: { "x-test-user": user.id, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const list = async (user: typeof author) => await (await request(user)).json() as { skills: { id: string; installed: boolean; sharedWith?: string[] }[]; vars: Record<string, { set: boolean; value?: string }> };
  const created = await request(author, "", "POST", {
    name: "shared-demo", description: "共享示例", body: "原始正文", vars: [{ name: "DEMO_TOKEN", secret: true, required: true }],
  });
  assert.equal(created.status, 200);
  const skill = await created.json() as { id: string; visibility: string };
  const endpoint = `/${skill.id}`;
  assert.equal(skill.visibility, "private");
  assert.deepEqual((await list(reader)).skills, []);
  assert.equal((await request(admin, endpoint)).status, 404, "管理员也不能查看其他人的私有技能");
  assert.equal((await request(reader, `${endpoint}/install`, "POST", { on: true })).status, 404);
  const md = skills.readSkillMd(skill.id);
  assert.equal((await request(author, endpoint, "PATCH", { visibility: "users", sharedWith: [] })).status, 400);
  assert.equal(skills.getSkill(skill.id)?.visibility, "private");
  assert.equal((await request(author, endpoint, "PATCH", { visibility: "users", sharedWith: [reader.id] })).status, 200);
  assert.equal(skills.readSkillMd(skill.id), md, "调整共享范围不重写技能文件");
  skills.updateSkill(author.id, skill.id, {}, { files: { write: new Map([["scripts/demo.sh", Buffer.from("echo demo")]]) } });
  skills.setSkillVars(author.id, { DEMO_TOKEN: "author-secret" });
  let catalog = await list(reader);
  assert.equal(catalog.skills[0]?.id, skill.id);
  assert.equal(catalog.skills[0]?.installed, false);
  assert.equal(catalog.skills[0]?.sharedWith, undefined, "接收者看不到共享名单");
  assert.deepEqual(catalog.vars, {}, "共享不携带作者的变量值");
  assert.equal((await request(stranger, endpoint)).status, 404);
  assert.equal((await request(stranger, `${endpoint}/file?path=scripts/demo.sh`)).status, 404);
  assert.equal((await request(reader, endpoint, "PATCH", { body: "越权修改", visibility: "all" })).status, 403);
  assert.equal((await request(reader, endpoint, "DELETE")).status, 400);
  assert.equal((await request(reader, `${endpoint}/install`, "POST", { on: true })).status, 200);
  assert.equal((await request(reader, "/vars", "PUT", { values: { DEMO_TOKEN: "reader-secret" } })).status, 200);
  catalog = await list(reader);
  assert.deepEqual(catalog.vars.DEMO_TOKEN, { set: true });
  assert.deepEqual(skills.skillEnv(reader.id), { DEMO_TOKEN: "reader-secret" });
  assert.deepEqual(skills.skillEnv(author.id), { DEMO_TOKEN: "author-secret" });
  assert.equal((await request(author, endpoint, "PATCH", { body: "更新后的正文" })).status, 200);
  assert.equal((await (await request(reader, endpoint)).json() as { body: string }).body, "更新后的正文");
  assert.equal((await (await request(reader, `${endpoint}/file?path=scripts/demo.sh`)).json() as { text: string }).text, "echo demo");
  assert.equal((await request(author, endpoint, "PATCH", { visibility: "all" })).status, 200);
  assert.equal((await request(admin, endpoint, "PATCH", { body: "管理员越权" })).status, 403);
  assert.equal((await request(stranger, `${endpoint}/install`, "POST", { on: true })).status, 200);
  assert.equal((await request(reader, `${endpoint}/install`, "POST", { on: false })).status, 200);
  assert.deepEqual(skills.activeSkills(reader.id), []);
  assert.equal((await request(reader, `${endpoint}/install`, "POST", { on: true })).status, 200, "卸载后可以重新安装");
  const changed: string[][] = [];
  const onChanged = (ids: string[]) => changed.push(ids);
  skills.skillEvents.on("changed", onChanged);
  t.after(() => skills.skillEvents.off("changed", onChanged));
  assert.equal((await request(author, endpoint, "PATCH", { visibility: "users", sharedWith: [reader.id] })).status, 200);
  assert.deepEqual(skills.activeSkills(stranger.id), [], "缩小范围后立即停止加载");
  assert.equal((await request(stranger, endpoint)).status, 404);
  assert.equal((await request(author, endpoint, "PATCH", { visibility: "private" })).status, 200);
  assert.deepEqual(skills.activeSkills(reader.id), []);
  assert.deepEqual(skills.skillEnv(reader.id), {});
  assert.equal((await request(reader, `${endpoint}/install`, "POST", { on: true })).status, 404);
  assert.ok(changed.at(-1)?.includes(reader.id), "撤回共享通知已安装用户刷新会话");
  assert.equal((await request(author, endpoint, "PATCH", { visibility: "all" })).status, 200);
  assert.equal((await request(admin, endpoint, "DELETE")).status, 200, "管理员可下架可见的共享技能");
  assert.equal(skills.userPrefs(reader.id).installed.includes(skill.id), false);
});
