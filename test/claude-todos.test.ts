// Claude 任务清单的还原：TodoWrite 整份替换，TaskCreate / TaskUpdate 逐条改（编号从工具结果来）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedTodos, TodoTracker } from "../src/agents/claude/todos.js";

const assistant = (blocks: unknown[]) => ({ type: "assistant", message: { content: blocks } });
const user = (blocks: unknown[], toolUseResult?: unknown) => ({ type: "user", message: { content: blocks }, tool_use_result: toolUseResult });

test("TodoWrite：每次给整份，直接替换", () => {
  const t = new TodoTracker();
  const r = t.use("TodoWrite", {
    todos: [
      { content: "读代码", status: "completed", activeForm: "读代码中" },
      { content: "改代码", status: "in_progress", activeForm: "改代码中" },
      { content: "跑测试", status: "pending", activeForm: "跑测试中" },
    ],
  });
  assert.equal(r?.changed, true);
  assert.equal(r?.step, "📋 更新任务清单（1/3）");
  assert.deepEqual(t.list.map((x) => x.status), ["completed", "in_progress", "pending"]);
});

test("TaskCreate / TaskUpdate：编号从工具结果里拿，按编号更新、删除", () => {
  const t = new TodoTracker();
  assert.equal(feedTodos(t, assistant([{ type: "tool_use", id: "u1", name: "TaskCreate", input: { subject: "配置层", description: "x", activeForm: "改配置" } }])), true);
  // 结构化结果
  feedTodos(t, user([{ type: "tool_result", tool_use_id: "u1", content: "Task #1 created successfully: 配置层" }], { task: { id: "1", subject: "配置层" } }));
  feedTodos(t, assistant([{ type: "tool_use", id: "u2", name: "TaskCreate", input: { subject: "数据层", description: "y" } }]));
  // 只有文字结果（读历史时可能拿不到结构化的）
  feedTodos(t, user([{ type: "tool_result", tool_use_id: "u2", content: [{ type: "text", text: "Task #2 created successfully: 数据层" }] }]));

  assert.equal(t.use("TaskUpdate", { taskId: "1", status: "in_progress" })?.step, "📋 开始：配置层");
  assert.deepEqual(t.list[0], { content: "配置层", status: "in_progress", activeForm: "改配置" });
  t.use("TaskUpdate", { taskId: "1", status: "completed" });
  t.use("TaskUpdate", { taskId: "2", subject: "数据层（含迁移）" });
  assert.deepEqual(t.list.map((x) => [x.content, x.status]), [["配置层", "completed"], ["数据层（含迁移）", "pending"]]);

  // 不认识的编号：不改清单
  assert.equal(t.use("TaskUpdate", { taskId: "9", status: "completed" })?.changed, false);
  t.use("TaskUpdate", { taskId: "2", status: "deleted" });
  assert.deepEqual(t.list.map((x) => x.content), ["配置层"]);
});

test("上一批全做完了再新建：当成新的一批", () => {
  const t = new TodoTracker();
  t.use("TaskCreate", { subject: "旧的" }, "a");
  t.result("a", "Task #1 created successfully: 旧的", undefined, false);
  t.use("TaskUpdate", { taskId: "1", status: "completed" });
  t.use("TaskCreate", { subject: "新的" }, "b");
  assert.deepEqual(t.list.map((x) => x.content), ["新的"]);
});

test("新建失败（工具报错）就拿掉；不是任务工具返回 null", () => {
  const t = new TodoTracker();
  t.use("TaskCreate", { subject: "会失败" }, "a");
  assert.equal(t.result("a", "error", undefined, true), true);
  assert.equal(t.list.length, 0);
  assert.equal(t.use("Bash", { command: "ls" }), null);
});

test("恢复老会话：先放进之前的清单，后面按编号接着改", () => {
  const t = new TodoTracker();
  t.seed([{ id: "1", content: "老任务", status: "in_progress" }]);
  t.use("TaskUpdate", { taskId: "1", status: "completed" });
  assert.deepEqual(t.list, [{ content: "老任务", status: "completed" }]);
});
