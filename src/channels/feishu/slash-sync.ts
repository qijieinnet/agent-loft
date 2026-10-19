// 把命令表同步成飞书的「斜杠指令」：用户在飞书输入框里打「/」就能看到并选择。
//
// 接口：/open-apis/application/v7/app_slash_commands（增删改查）。扫码创建的应用自带读写权限。
// 实测出来的规矩（文档没写全，别凭感觉改）：
//   - 指令名必须匹配 ^[a-z][a-z0-9_-]{0,31}$ —— 带冒号的 plugin skill、大写、超长的都注册不了，跳过；
//   - 说明最长 100 字；每个应用最多 100 条；
//   - 列表按创建时间倒序返回（后建的在前），没有排序字段。所以想要某个顺序，就得
//     按目标顺序倒着建，每条之间隔开 1 秒以上（create_time 精确到秒，同一秒内顺序不定）；
//   - 改动约 5 分钟生效，客户端还有约 3 分钟缓存。
//
// 这个应用是 im-agent 专用的：同步时会删掉不在命令表里的指令，包括手动加的。
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { CommandEntry } from "../../core/command-catalog.js";

const API = "/open-apis/application/v7/app_slash_commands";
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_COMMANDS = 100;
const MAX_DESCRIPTION = 100;
/** create_time 精确到秒，间隔要超过 1 秒顺序才稳定 */
const CREATE_GAP_MS = 1100;

export type FeishuSlashCommand = { command: string; description: string };
export type RemoteSlashCommand = { command_id: string; command: string; description?: { default_value?: string } };

export type SlashSyncStatus = {
  state: "idle" | "syncing" | "done" | "error";
  /** 最近一次完成（或失败）的时间 */
  at?: number;
  /** 飞书上现在注册了多少条 */
  registered?: number;
  /** 名字不合飞书规矩、或者超出 100 条而没注册的命令 */
  skipped?: string[];
  /** 最近一次是否真的改了东西（没改就是已经一致） */
  changed?: boolean;
  error?: string;
};

function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** 命令表 → 飞书指令。参数提示并进说明里，飞书那边没有单独的参数字段。 */
export function toFeishuCommands(entries: CommandEntry[]): { commands: FeishuSlashCommand[]; skipped: string[] } {
  const commands: FeishuSlashCommand[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const c of entries) {
    if (c.hidden || seen.has(c.name)) continue;
    seen.add(c.name);
    if (!NAME.test(c.name) || commands.length >= MAX_COMMANDS) {
      skipped.push(c.name);
      continue;
    }
    const text = `${c.args ? `${c.args} ` : ""}${c.description}`.replace(/\s+/g, " ").trim() || c.name;
    commands.push({ command: c.name, description: clipChars(text, MAX_DESCRIPTION) });
  }
  return { commands, skipped };
}

export type SyncPlan =
  | { action: "none" }
  | { action: "patch"; updates: { id: string; description: string }[] }
  | { action: "rebuild" };

/**
 * remote 是飞书返回的顺序（后建的在前），desired 是想要的显示顺序（第一条在最前）。
 * 名字和顺序都对得上，最多改改说明；否则整体重建 —— 飞书没有排序字段，只能靠重建来排。
 */
export function planSync(remote: RemoteSlashCommand[], desired: FeishuSlashCommand[]): SyncPlan {
  const sameOrder =
    remote.length === desired.length && remote.every((r, i) => r.command === desired[i]!.command);
  if (!sameOrder) return { action: "rebuild" };
  const updates = remote
    .map((r, i) => ({ r, d: desired[i]! }))
    .filter(({ r, d }) => (r.description?.default_value ?? "") !== d.description)
    .map(({ r, d }) => ({ id: r.command_id, description: d.description }));
  return updates.length > 0 ? { action: "patch", updates } : { action: "none" };
}

type ApiResponse<T> = { code?: number; msg?: string; data?: T };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一个机器人一个。request() 可以随便多次调用：会合并成一次，正在同步时再要求就等这次完了再跑一遍。
 */
export class SlashSync {
  status: SlashSyncStatus = { state: "idle" };
  private running = false;
  private again = false;
  private stopped = false;
  private debounce: NodeJS.Timeout | null = null;

  constructor(
    private readonly lark: Lark.Client,
    /** 现在应该注册哪些命令（已排好序） */
    private readonly desired: () => Promise<CommandEntry[]>,
    private readonly tag: string,
  ) {}

  /** delayMs：设置里连着点几次保存，只同步一次 */
  request(delayMs = 3000): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.run();
    }, delayMs);
    this.debounce.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.status = { ...this.status, state: "syncing" };
    try {
      const { commands, skipped } = toFeishuCommands(await this.desired());
      const remote = await this.list();
      const plan = planSync(remote, commands);
      if (plan.action === "patch") {
        for (const u of plan.updates) {
          await this.call("PATCH", `${API}/${u.id}`, { description: { default_value: u.description } });
        }
      } else if (plan.action === "rebuild") {
        for (const r of remote) {
          if (this.stopped) return;
          await this.call("DELETE", `${API}/${r.command_id}`);
        }
        // 倒着建：最后建的显示在最前
        for (const [i, c] of [...commands].reverse().entries()) {
          if (this.stopped) return;
          if (i > 0) await sleep(CREATE_GAP_MS);
          await this.call("POST", API, { command: c.command, description: { default_value: c.description } });
        }
      }
      this.status = {
        state: "done",
        at: Date.now(),
        registered: commands.length,
        skipped,
        changed: plan.action !== "none",
      };
      if (plan.action !== "none") {
        console.log(`${this.tag} 斜杠指令已同步：${commands.length} 条（${plan.action === "rebuild" ? "重建" : "更新说明"}），约 5～8 分钟后在飞书里生效`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { ...this.status, state: "error", at: Date.now(), error: message };
      console.error(`${this.tag} 斜杠指令同步失败：${message}`);
    } finally {
      this.running = false;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.run();
      }
    }
  }

  private async list(): Promise<RemoteSlashCommand[]> {
    const data = await this.call<{ items?: RemoteSlashCommand[] }>("GET", API);
    return data?.items ?? [];
  }

  private async call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, data?: unknown): Promise<T | undefined> {
    let res: ApiResponse<T>;
    try {
      res = await this.lark.request<ApiResponse<T>>({ method, url, ...(data !== undefined ? { data } : {}) });
    } catch (err) {
      const body = (err as { response?: { data?: ApiResponse<T> } })?.response?.data;
      if (body?.code) throw new Error(explain(body.code, body.msg));
      throw err;
    }
    if (res?.code) throw new Error(explain(res.code, res.msg));
    return res?.data;
  }
}

function explain(code: number, msg?: string): string {
  if (code === 99991640 || code === 99991672) {
    return `应用没有斜杠指令权限（${code}）。到飞书开发者后台给这个应用开通 application:app_slash_command:write / read，并发布新版本`;
  }
  return `code=${code} ${msg ?? ""}`.trim();
}
