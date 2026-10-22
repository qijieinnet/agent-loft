// agent-loft user …：在终端里管理 Web 登录用户（Web 上 设置 → 用户 里也能做）。
//
//   list                         列出用户
//   add <用户名> [--admin] [密码]  新建用户（默认普通成员）
//   passwd <用户名> [新密码]       重置密码，他的设备全部下线
//   role <用户名> admin|member     改角色
//   disable <用户名> / enable <用户名>
//   remove <用户名>
import readline from "node:readline/promises";
import { loadConfig } from "../core/config.js";
import { createUser, findUserByName, legacyOwnerId, listUsers, removeUser } from "../core/users.js";
import { patchUser, revokeUserSessions } from "../channels/web/auth.js";
import { removeSubscriptionsOf } from "../channels/web/push.js";

loadConfig();

const USAGE = `用法：
  agent-loft user list
  agent-loft user add <用户名> [--admin] [密码]
  agent-loft user passwd <用户名> [新密码]
  agent-loft user role <用户名> admin|member
  agent-loft user disable <用户名>
  agent-loft user enable <用户名>
  agent-loft user remove <用户名>

注意：多用户是「信任型」的 —— 所有 agent 都以同一个系统用户运行，能读到这台机器上的任何东西。
只把账号给你信任的人。`;

const [sub, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

function need(name: string | undefined) {
  if (!name) throw new Error(USAGE);
  const user = findUserByName(name);
  if (!user) throw new Error(`没有用户「${name}」`);
  return user;
}

switch (sub) {
  case undefined:
  case "list": {
    const users = listUsers();
    if (users.length === 0) console.log("还没有用户。打开网页用启动日志里的设置码建第一个管理员，或者运行 agent-loft passwd。");
    for (const u of users) {
      console.log(`${u.name}\t${u.role === "admin" ? "管理员" : "成员"}${u.disabled ? "\t已停用" : ""}`);
    }
    break;
  }
  case "add": {
    const name = args[0];
    if (!name) throw new Error(USAGE);
    const password = args[1] ?? (await ask(`「${name}」的登录密码（至少 8 位）：`));
    const user = createUser({ name, password, role: flags.has("--admin") ? "admin" : "member" });
    console.log(`已创建${user.role === "admin" ? "管理员" : "成员"}「${user.name}」。`);
    break;
  }
  case "passwd": {
    const user = need(args[0]);
    const password = args[1] ?? (await ask(`「${user.name}」的新密码（至少 8 位）：`));
    patchUser(user.id, { password });
    console.log(`「${user.name}」的密码已更新，他已登录的设备需要重新登录。`);
    break;
  }
  case "role": {
    const user = need(args[0]);
    const role = args[1];
    if (role !== "admin" && role !== "member") throw new Error(USAGE);
    patchUser(user.id, { role });
    console.log(`「${user.name}」现在是${role === "admin" ? "管理员" : "成员"}。`);
    break;
  }
  case "disable":
  case "enable": {
    const user = need(args[0]);
    patchUser(user.id, { disabled: sub === "disable" });
    console.log(`「${user.name}」已${sub === "disable" ? "停用，设备已全部下线" : "启用"}。`);
    break;
  }
  case "remove": {
    const user = need(args[0]);
    // 升级前没记主人的推送订阅算在最早的管理员名下：删人之前先记下是谁
    const legacy = legacyOwnerId();
    removeUser(user.id);
    removeSubscriptionsOf((owner) => (owner ?? legacy) === user.id);
    revokeUserSessions(user.id);
    console.log(`已删除「${user.name}」。他的会话还在，归管理员。`);
    break;
  }
  default:
    throw new Error(USAGE);
}
