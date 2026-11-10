// ACP 的 stdio MCP 要绝对路径的命令：按 PATH 找出来
import fs from "node:fs";
import path from "node:path";

export function resolveCommand(cmd: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  if (!cmd) return undefined;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : undefined;
  if (cmd.includes("/")) {
    const abs = path.resolve(cmd);
    return fs.existsSync(abs) ? abs : undefined;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // 这个目录没有
    }
  }
  return undefined;
}
