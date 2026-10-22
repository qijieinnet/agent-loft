// agent-loft passwd [新密码] [--user 用户名]：在终端里重置 Web 登录密码（忘记密码时用）。
// 不指定用户就是最早的那个管理员；还一个用户都没有时，建一个叫 admin（或 --user 给的名字）的管理员。
// 被重置的用户所有已登录设备会下线。
import readline from "node:readline/promises";
import { loadConfig } from "../core/config.js";
import { findUserByName, getUser, hasUsers, legacyOwnerId } from "../core/users.js";
import { setUserPassword, setupFirstAdmin } from "../channels/web/auth.js";

loadConfig();
const args = process.argv.slice(2);
const at = args.indexOf("--user");
const name = at >= 0 ? args[at + 1] : undefined;
if (at >= 0 && !name) throw new Error("--user 后面要跟用户名");
const positional = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));

const target = !hasUsers() ? undefined : name ? findUserByName(name) : getUser(legacyOwnerId());
if (hasUsers() && !target) throw new Error(name ? `没有用户「${name}」。用 agent-loft user list 看看有哪些` : "没有能登录的管理员，用 --user 指定用户");

let password = positional[0];
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question(`${target ? `「${target.name}」` : "管理员"}的新 Web 登录密码（至少 8 位）：`);
  rl.close();
}

if (target) {
  setUserPassword(target.id, password.trim());
  console.log(`「${target.name}」的密码已更新，他已登录的设备需要重新登录。`);
} else {
  const user = setupFirstAdmin(name ?? "admin", password.trim());
  console.log(`已创建管理员「${user.name}」，用这个用户名和密码登录。`);
}
