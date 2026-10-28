// Claude 的任务清单：从工具调用里还原出「列了哪些事、做到哪一步」。
//
// 两套工具都认：TodoWrite 每次给整份清单；TaskCreate / TaskUpdate 一条条加、一条条改，
// 新建的那条编号多少要等工具结果（"Task #3 created successfully: …"）才知道。
// 实时（session.ts）和翻历史（driver.ts）用的是同一套规则，两边看到的才一样。
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { TodoItem } from "../../core/types.js";
import { summarize } from "./session.js";

type Tracked = TodoItem & { id?: string };

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export class TodoTracker {
  private items: Tracked[] = [];
  /** 新建了、还没拿到编号的：tool_use id → 那一条 */
  private creating = new Map<string, Tracked>();

  get list(): TodoItem[] {
    return this.items.map(({ content, status, activeForm }) => ({ content, status, ...(activeForm ? { activeForm } : {}) }));
  }

  /**
   * 一次工具调用。不是任务工具返回 null；是的话返回过程里显示的那一行，changed = 清单变了。
   */
  use(name: string, input: unknown, toolUseId?: string): { step: string; changed: boolean } | null {
    const r = (input ?? {}) as Record<string, unknown>;
    if (name === "TodoWrite") {
      if (!Array.isArray(r.todos)) return { step: "📋 更新任务清单", changed: false };
      this.items = r.todos.flatMap((t) => {
        const item = t as Record<string, unknown>;
        if (typeof item.content !== "string" || !STATUSES.has(item.status as string)) return [];
        return [{ content: item.content, status: item.status as TodoItem["status"], ...(typeof item.activeForm === "string" ? { activeForm: item.activeForm } : {}) }];
      });
      const done = this.items.filter((t) => t.status === "completed").length;
      return { step: `📋 更新任务清单（${done}/${this.items.length}）`, changed: true };
    }
    if (name === "TaskCreate") {
      if (typeof r.subject !== "string") return { step: "📋 新增任务", changed: false };
      // 上一批全做完了又开始列新的：当成新的一批，旧的不再挂着
      if (this.items.length && this.items.every((t) => t.status === "completed")) this.items = [];
      const item: Tracked = { content: r.subject, status: "pending", ...(typeof r.activeForm === "string" ? { activeForm: r.activeForm } : {}) };
      this.items.push(item);
      if (toolUseId) this.creating.set(toolUseId, item);
      return { step: `📋 新增任务：${summarize(r.subject, 50)}`, changed: true };
    }
    if (name === "TaskUpdate") {
      const id = r.taskId === undefined ? "" : String(r.taskId);
      const item = this.items.find((t) => t.id === id);
      if (!item) return { step: `📋 更新任务 #${id}`, changed: false };
      if (r.status === "deleted") {
        this.items = this.items.filter((t) => t !== item);
        return { step: `📋 删除任务：${summarize(item.content, 50)}`, changed: true };
      }
      if (typeof r.subject === "string") item.content = r.subject;
      if (typeof r.activeForm === "string") item.activeForm = r.activeForm;
      if (STATUSES.has(r.status as string)) item.status = r.status as TodoItem["status"];
      const verb = r.status === "completed" ? "完成" : r.status === "in_progress" ? "开始" : "更新任务";
      return { step: `📋 ${verb}：${summarize(item.content, 50)}`, changed: true };
    }
    return null;
  }

  /** 工具结果：补上新建任务的编号。建失败了就拿掉，返回 true 表示清单变了 */
  result(toolUseId: string, text: string, structured: unknown, isError: boolean): boolean {
    const item = this.creating.get(toolUseId);
    if (!item) return false;
    this.creating.delete(toolUseId);
    if (isError) {
      this.items = this.items.filter((t) => t !== item);
      return true;
    }
    const id = (structured as { task?: { id?: unknown } } | null)?.task?.id ?? /Task #(\S+) created/.exec(text)?.[1];
    if (id !== undefined) item.id = String(id);
    return false;
  }

  /** 接着老会话说：之前列过的先放进来（已经有同编号的不重复放） */
  seed(items: Tracked[]): void {
    const known = new Set(this.items.map((t) => t.id).filter(Boolean));
    this.items = [...items.filter((t) => !t.id || !known.has(t.id)), ...this.items];
  }

  snapshot(): Tracked[] {
    return this.items.map((t) => ({ ...t }));
  }
}

type Block = { type?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** tool_result 的内容：字符串，或者一组 text 块 */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
}

/** 把一条记录里的工具调用 / 工具结果喂给 tracker。返回这条里有没有改过清单 */
export function feedTodos(tracker: TodoTracker, msg: { type: string; message?: unknown; tool_use_result?: unknown }): boolean {
  const content = (msg.message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const b of content as Block[]) {
    if (msg.type === "assistant" && b.type === "tool_use" && b.name) {
      changed = !!tracker.use(b.name, b.input, b.id)?.changed || changed;
    } else if (msg.type === "user" && b.type === "tool_result" && b.tool_use_id) {
      changed = tracker.result(b.tool_use_id, resultText(b.content), msg.tool_use_result, !!b.is_error) || changed;
    }
  }
  return changed;
}

/** 老会话最后的任务清单（恢复会话时接着用）。读不到就当没有 */
export async function readTodos(sessionId: string, cwd: string): Promise<Tracked[]> {
  try {
    const tracker = new TodoTracker();
    for (const msg of await getSessionMessages(sessionId, { dir: cwd })) {
      if (!msg.parent_tool_use_id) feedTodos(tracker, msg as never);
    }
    return tracker.snapshot();
  } catch {
    return [];
  }
}
