import os from "node:os";
import path from "node:path";

/** 配置里的家目录缩写按服务用户展开；命令名、空值和其他路径保持原意。 */
export function expandHomePath(input: string): string {
  const value = input.trim();
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
