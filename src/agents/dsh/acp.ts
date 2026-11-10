// 和 `dsh --profile acp` 的连接：标准 ACP（Agent Client Protocol）v1，stdio 上按行分隔的 JSON-RPC。
//
// 为什么不用 SDK profile（--profile sdk）：它没有中断当前回复、也没有关闭会话的方法（官方 README 写明），
// 停止按钮做不了。ACP 有 session/cancel，模型 / 思考程度、MCP、授权请求、会话列表 / 恢复也都齐。
//
// 一个 agent-loft 会话一个 dsh 进程：权限（沙箱档位）、追加的系统提示都只能在启动时给（环境变量和 --patch），
// 一个进程带多条会话就没法各配各的。代价是拉起要 4~5 秒，所以进程常驻、按需重拉。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export type McpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };

export type ConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: ({ value: string; name?: string; description?: string } | { group?: string; name?: string; options: { value: string; name?: string; description?: string }[] })[];
};

export type SessionUpdate = { sessionUpdate: string; [k: string]: unknown };

export type PermissionRequest = {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; rawInput?: unknown; kind?: string };
  options: { optionId: string; name?: string; kind: string }[];
};

export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/** stderr 只留最后这些行，给报错当线索 */
const STDERR_KEEP = 30;

export type AcpSpawn = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

export class AcpConnection {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stderr: string[] = [];
  private closedWith: Error | null = null;
  /** 会话更新：按会话 id 分发 */
  onUpdate: (sessionId: string, update: SessionUpdate) => void = () => {};
  /** dsh 要授权：返回选了哪个选项 */
  onPermission: (req: PermissionRequest) => Promise<PermissionOutcome> = async () => ({ outcome: "cancelled" });
  /** 进程退了（被杀、崩了、自己退出） */
  onExit: (err: Error) => void = () => {};

  constructor(spec: AcpSpawn) {
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderr.push(line);
      if (this.stderr.length > STDERR_KEEP) this.stderr.shift();
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (err) => this.close(err));
    this.child.on("exit", (code, signal) => {
      const tail = this.stderrTail();
      this.close(new Error(`dsh 进程退出了（${signal ?? `退出码 ${code}`}）${tail ? `：${tail}` : ""}`));
    });
  }

  get alive(): boolean {
    return !this.closedWith;
  }

  stderrTail(lines = 5): string {
    return this.stderr
      .filter((l) => l.trim())
      .slice(-lines)
      .join("\n");
  }

  private close(err: Error): void {
    if (this.closedWith) return;
    this.closedWith = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.onExit(err);
  }

  private write(msg: object): void {
    if (this.closedWith) return;
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      // stdout 只该有协议帧；混进来的别的输出（插件打日志）当 stderr 记下
      this.stderr.push(line);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      void this.onServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) {
      if (msg.method === "session/update") {
        const p = msg.params as { sessionId?: string; update?: SessionUpdate } | undefined;
        if (p?.sessionId && p.update) this.onUpdate(p.sessionId, p.update);
      }
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      const details = (msg.error.data as { details?: unknown } | undefined)?.details;
      const text = [msg.error.message, typeof details === "string" ? details : ""].filter(Boolean).join("：");
      pending.reject(new AcpError(text || "dsh 返回了错误", msg.error.code, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  private async onServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (method === "session/request_permission") {
        const outcome = await this.onPermission(params as PermissionRequest);
        this.write({ jsonrpc: "2.0", id, result: { outcome } });
        return;
      }
      // 没声明客户端文件系统 / 终端能力，正常不会来
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `agent-loft 不支持 ${method}` } });
    } catch (err) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  /** 先关 stdin 让它自己收尾（会 flush 会话记录），几秒不退再杀 */
  async shutdown(graceMs = 5000): Promise<void> {
    if (this.closedWith) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    try {
      this.child.stdin.end();
    } catch {
      // 已经关了
    }
    const timer = setTimeout(() => this.child.kill("SIGTERM"), graceMs);
    const hard = setTimeout(() => this.child.kill("SIGKILL"), graceMs + 3000);
    await exited;
    clearTimeout(timer);
    clearTimeout(hard);
  }
}

/** ACP 的 initialize：只声明最小能力（不接管文件系统和终端，让 dsh 自己的沙箱管） */
export async function initialize(conn: AcpConnection): Promise<void> {
  await conn.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "agent-loft", version: "1" },
  });
}

/** 把配置选项（可能分组）摊平 */
export function flatOptions(opt: ConfigOption | undefined): { value: string; name?: string; description?: string }[] {
  if (!opt?.options) return [];
  return opt.options.flatMap((o) => ("options" in o && Array.isArray(o.options) ? o.options : [o as { value: string; name?: string; description?: string }]));
}
