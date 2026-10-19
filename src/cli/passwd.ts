// im-agent passwd：在终端里重置 Web 登录密码（忘记密码时用）。所有已登录设备会下线。
import readline from "node:readline/promises";
import { loadConfig } from "../core/config.js";
import { setPassword } from "../channels/web/auth.js";

loadConfig();
const fromArg = process.argv[2];
let password = fromArg;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("新的 Web 登录密码（至少 8 位）：");
  rl.close();
}
setPassword(password.trim());
console.log("密码已更新，所有已登录的设备需要重新登录。");
