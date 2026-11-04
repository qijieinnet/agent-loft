import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-tasks-"));
process.env.AGENT_LOFT_HOME = home;
fs.mkdirSync(path.join(home, "data"), { recursive: true });
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const sched = await import("../src/core/task-schedule.js");
const tasks = await import("../src/core/tasks.js");
const { isSilentReply, stripSilentMark, taskMessage } = await import("../src/core/task-prompt.js");
const { stripContext } = await import("../src/core/expert-prompt.js");
// 任务现在按账号校验内置 Agent 使用权，存储层测试也使用真实账号。
const { createUser: createTaskUser } = await import("../src/core/users.js");
const [weeklyOwner, ownerA, ownerB, manyOwner] = ["weekly", "owner-a", "owner-b", "many"].map((name) => createTaskUser({ name, password: "test-password" }).id);

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("频率：结构化写法换成 cron，按本地时间算下一次", () => {
  const from = at(2026, 10, 23, 10, 30); // 周五
  assert.equal(sched.nextRun({ kind: "daily", time: "02:00" }, from), at(2026, 10, 24, 2, 0));
  assert.equal(sched.nextRun({ kind: "daily", time: "11:00" }, from), at(2026, 10, 23, 11, 0));
  // 工作日：周五 10:30 之后的 09:00 是下周一
  assert.equal(sched.nextRun({ kind: "weekdays", time: "09:00" }, from), at(2026, 10, 26, 9, 0));
  assert.equal(sched.nextRun({ kind: "weekly", days: [0, 3], time: "08:00" }, from), at(2026, 10, 25, 8, 0));
  assert.equal(sched.nextRun({ kind: "monthly", day: 1, time: "07:15" }, from), at(2026, 11, 1, 7, 15));
  assert.equal(sched.nextRun({ kind: "hourly", every: 6, minute: 5 }, from), at(2026, 10, 23, 12, 5));
  assert.equal(sched.nextRun({ kind: "cron", expr: "30 9 * * 1-5" }, from), at(2026, 10, 26, 9, 30));
  // 日期和星期都限定：满足其一就算（标准 cron）
  assert.equal(sched.nextRun({ kind: "cron", expr: "0 0 13 * 5" }, from), at(2026, 10, 30, 0, 0));
  // 「一次」：过了就没有下一次
  assert.equal(sched.nextRun({ kind: "once", at: from + 60_000 }, from), from + 60_000);
  assert.equal(sched.nextRun({ kind: "once", at: from - 60_000 }, from), undefined);
});

test("频率：校验不合规的写法，太频繁的拒绝", () => {
  const now = at(2026, 10, 23, 10, 30);
  assert.deepEqual(sched.normalizeSchedule({ kind: "daily", time: "2:05" }, now), { kind: "daily", time: "02:05" });
  assert.deepEqual(sched.normalizeSchedule({ kind: "weekly", days: [3, 1, 7, 1], time: "09:00" }, now), { kind: "weekly", days: [0, 1, 3], time: "09:00" });
  assert.throws(() => sched.normalizeSchedule({ kind: "daily", time: "25:00" }, now), /HH:MM/);
  assert.throws(() => sched.normalizeSchedule({ kind: "cron", expr: "*/5 * * * *" }, now), /太频繁/);
  assert.throws(() => sched.normalizeSchedule({ kind: "cron", expr: "0 9 * *" }, now), /5 段/);
  assert.throws(() => sched.normalizeSchedule({ kind: "weekly", days: [], time: "09:00" }, now), /至少选一天/);
  assert.throws(() => sched.normalizeSchedule({ kind: "once", at: now - 3600_000 }, now), /现在之后/);
  assert.throws(() => sched.normalizeSchedule({ kind: "nope" }, now), /不认识/);
  assert.equal(sched.describeSchedule({ kind: "weekly", days: [1, 3], time: "08:00" }), "每周一、三 08:00");
  assert.equal(sched.describeSchedule({ kind: "weekly", days: [0, 1, 6], time: "08:00" }), "每周一、六、日 08:00");
  assert.equal(sched.parseLocalDateTime("2026-10-24 15:00"), at(2026, 10, 24, 15, 0));
});

test("星期多选：保存、修改后按所选星期计算下次执行时间", () => {
  const task = tasks.createTask(weeklyOwner!, { prompt: "按选中的星期执行", schedule: { kind: "weekly", days: [1, 3, 0], time: "08:30" } }, "user");
  assert.deepEqual(task.schedule, { kind: "weekly", days: [0, 1, 3], time: "08:30" });
  const saved = JSON.parse(fs.readFileSync(path.join(home, "data", "tasks.json"), "utf8")).find((t: { id: string }) => t.id === task.id);
  assert.deepEqual(saved.schedule, task.schedule);
  assert.equal(sched.nextRun(task.schedule, at(2026, 10, 26, 8, 30)), at(2026, 10, 28, 8, 30));
  assert.equal(sched.nextRun(task.schedule, at(2026, 10, 28, 8, 30)), at(2026, 11, 1, 8, 30));

  const updated = tasks.updateTask(weeklyOwner!, task.id, { schedule: { kind: "weekly", days: [6, 0], time: "10:15" } });
  assert.deepEqual(updated.schedule, { kind: "weekly", days: [0, 6], time: "10:15" });
  assert.equal(updated.nextRunAt, sched.nextRun(updated.schedule, Date.now()));
  assert.equal(sched.nextRun(updated.schedule, at(2026, 10, 31, 10, 15)), at(2026, 11, 1, 10, 15));
  tasks.deleteUserTasks(weeklyOwner!);
});

test("当前聊天的定时任务：创建、暂停、迁移和删除同步会话标记，多任务互不覆盖", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { createUser } = await import("../src/core/users.js");
  const owner = createUser({ name: "task-marks", password: "password-123" }).id;
  const keys = ["web:task-mark-a", "web:task-mark-b"];
  for (const key of keys) hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner });
  const refreshed: string[] = [];
  const listener = (env: { key: string; ev: { type: string } }) => {
    if (env.ev.type === "meta" && keys.includes(env.key)) refreshed.push(env.key);
  };
  hub.on("event", listener);
  const input = { prompt: "检查", schedule: { kind: "daily", time: "08:00" }, target: { kind: "conv", key: keys[0] } };
  try {
    assert.equal(hub.info(keys[0]!)?.tasks, undefined);
    const first = tasks.createTask(owner, input, "agent");
    assert.deepEqual(refreshed.splice(0), [keys[0]]);
    assert.deepEqual(hub.info(keys[0]!)?.tasks, [{ id: first.id, title: first.title }]);
    assert.equal(hub.info(keys[0]!)?.taskId, undefined, "普通对话的权限不改为跟随任务");
    const second = tasks.createTask(owner, input, "user");
    tasks.updateTask(owner, first.id, { enabled: false });
    assert.equal(hub.info(keys[0]!)?.tasks?.length, 2, "暂停的任务仍然关联对话");
    refreshed.length = 0;
    tasks.updateTask(owner, first.id, { target: { kind: "conv", key: keys[1] } });
    assert.deepEqual(refreshed.splice(0), keys, "迁移同时刷新新旧对话");
    assert.deepEqual(hub.info(keys[0]!)?.tasks?.map((t) => t.id), [second.id], "原对话还有第二个任务");
    assert.deepEqual(hub.info(keys[1]!)?.tasks?.map((t) => t.id), [first.id]);
    tasks.deleteTask(owner, second.id);
    assert.equal(hub.info(keys[0]!)?.tasks, undefined);
    assert.deepEqual(refreshed.splice(0), [keys[0]]);
    tasks.deleteUserTasks(owner);
    assert.equal(hub.info(keys[1]!)?.tasks, undefined);
    assert.deepEqual(refreshed.splice(0), [keys[1]]);
  } finally {
    hub.off("event", listener);
    tasks.deleteUserTasks(owner);
  }
});

test("提示词：说明附在后面、给人看时剥掉；静默暗号", () => {
  const msg = taskMessage({ title: "查更新", prompt: "看看有没有新版本", notify: "smart" }, { now: at(2026, 10, 23, 2, 0) });
  assert.match(msg, /\[\[静默\]\]/);
  assert.equal(stripContext(msg), "看看有没有新版本");
  assert.doesNotMatch(taskMessage({ title: "t", prompt: "p", notify: "always" }), /\[\[静默\]\]/);
  assert.equal(isSilentReply("  [[静默]]\n没有更新"), true);
  assert.equal(isSilentReply("有更新：[[静默]]"), false);
  assert.equal(stripSilentMark("[[静默]]\n当前 0.2.30，没有更新"), "当前 0.2.30，没有更新");
});

test("提示词：不携带上下文时不提对比上次", () => {
  const msg = taskMessage({ title: "t", prompt: "p", notify: "smart" }, { fresh: true });
  assert.match(msg, /不带之前的上下文/);
  assert.doesNotMatch(msg, /对比/);
  assert.match(taskMessage({ title: "t", prompt: "p", notify: "smart" }), /对比/);
});

test("运行：不携带上下文时每次换新会话，留在同一条对话，历史接着显示", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { agentBinding, getConversation } = await import("../src/core/store.js");
  const { createUser } = await import("../src/core/users.js");
  const runner = await import("../src/core/task-runner.js");

  const resumed: (string | undefined)[] = [];
  let seq = 0;
  hub.registerDriver({
    id: "claude",
    label: "Fake",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: (opts, events) => {
      resumed.push(opts.resumeId);
      const id = opts.resumeId ?? `fresh-${++seq}`;
      return {
        sessionId: opts.resumeId,
        send: () => {
          setTimeout(() => {
            events.onSessionId(id);
            events.onResult({ text: `来自 ${id}`, durationMs: 1 });
          }, 5);
        },
        interrupt: async () => {},
        setModel: async () => {},
        describeRuntime: async () => ({}),
        dispose: async () => {},
      };
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async (id: string) => {
      if (id === "fresh-1") throw new Error("读不到");
      return [{ role: "user" as const, text: `问 ${id}`, anchor: `a-${id}` }];
    },
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: () => ({ kind: "x", chatMessage: "x", consoleHint: "" }),
  });
  const owner = createUser({ name: "fresh-owner", password: "password-123", role: "admin" });
  runner.startTaskRunner();
  try {
    const task = tasks.createTask(owner.id, { title: "不带", prompt: "看看", schedule: { kind: "daily", time: "02:00" }, freshContext: true, model: "m1" }, "user");
    for (let i = 0; i < 3; i++) {
      assert.equal(runner.runTaskNow(task), undefined);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(tasks.getTask(owner.id, task.id)!.runs[0]!.status, "notified");
    }
    const key = task.target.key!;
    // 三次都没有 resume，还在同一条对话，任务定的模型没丢
    assert.deepEqual(resumed, [undefined, undefined, undefined]);
    const binding = agentBinding(getConversation(key)!);
    assert.deepEqual(binding.pastSessions, ["fresh-1", "fresh-2"]);
    assert.equal(binding.sessionId, "fresh-3");
    assert.equal(binding.model, "m1");

    // 旧会话接着显示、不能回退或分叉；读不到的那条跳过，不影响别的
    assert.deepEqual(await hub.history(key), [
      { role: "user", text: "问 fresh-2" },
      { role: "user", text: "问 fresh-3", anchor: "a-fresh-3" },
    ]);

    // 改回携带：接着最后一次的会话
    tasks.updateTask(owner.id, task.id, { freshContext: false });
    assert.equal(tasks.getTask(owner.id, task.id)!.freshContext, undefined);
    assert.equal(runner.runTaskNow(task), undefined);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agentBinding(getConversation(key)!).sessionId, "fresh-3");

    // 手动开新会话：旧记录也不再显示
    await hub.newSession(key);
    assert.deepEqual(await hub.history(key), []);

  } finally {
    runner.stopTaskRunner();
    tasks.deleteUserTasks(owner.id);
  }
});

test("发到聊天对话、不携带上下文：借临时会话跑，跑完换回聊天的会话", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { agentBinding, getConversation, updateAgentBinding } = await import("../src/core/store.js");
  const { createUser } = await import("../src/core/users.js");
  const runner = await import("../src/core/task-runner.js");

  const sent: { session: string; text: string }[] = [];
  const created: (string | undefined)[] = [];
  let seq = 0;
  let holdTask = false;
  let release = () => {};
  hub.registerDriver({
    id: "claude",
    label: "Fake",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: (opts, events) => {
      created.push(opts.resumeId);
      const id = opts.resumeId ?? `s${++seq}`;
      const answer = () => {
        events.onSessionId(id);
        events.onResult({ text: `来自 ${id}`, durationMs: 1, anchor: `end-${id}` });
      };
      return {
        sessionId: opts.resumeId,
        send: (input: { text: string }) => {
          sent.push({ session: id, text: input.text });
          if (holdTask && input.text.includes("看看")) {
            events.onSessionId(id);
            release = answer;
            return;
          }
          setTimeout(answer, 5);
        },
        interrupt: async () => {
          release = () => {};
          events.onError(new Error("interrupted"));
        },
        setModel: async () => {},
        describeRuntime: async () => ({}),
        dispose: async () => {},
      };
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async (id: string) =>
      id === "s1"
        ? [
            { role: "user" as const, text: "聊两句", anchor: "a-1" },
            { role: "assistant" as const, text: "好", ts: 100, anchor: "a-2" },
            { role: "user" as const, text: "再聊", anchor: "a-3" },
            { role: "assistant" as const, text: "嗯", ts: 300, anchor: "a-4" },
          ]
        : [
            { role: "user" as const, text: `任务 ${id}`, anchor: `t-${id}` },
            { role: "assistant" as const, text: `结果 ${id}`, ts: 200, anchor: `r-${id}` },
          ],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: () => ({ kind: "x", chatMessage: "x", consoleHint: "" }),
  });
  const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  // 刚停止的 15 秒内不让再跑，这里不用真的等
  const clearStopped = () => (hub as unknown as { stoppedAt: Map<string, number> }).stoppedAt.delete(key);
  const owner = createUser({ name: "isolated-owner", password: "password-123", role: "admin" });
  const key = "web:isolated";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner: owner.id });
  const binding = () => agentBinding(getConversation(key)!);
  const chat = (text: string) => hub.send(key, { text, attachments: [] }, { channel: "web", channelId: "web" });
  runner.startTaskRunner();
  try {
    const task = tasks.createTask(owner.id, { title: "独立", prompt: "看看", schedule: { kind: "daily", time: "02:00" }, target: { kind: "conv", key }, freshContext: true }, "user");
    chat("聊两句");
    await wait();
    assert.equal(binding().sessionId, "s1");

    // 跑完：聊天的会话换回来，任务的进历史，运行状态正常
    assert.equal(runner.runTaskNow(task), undefined);
    await wait();
    assert.equal(sent.at(-1)!.session, "s2", "任务在新会话里跑");
    assert.equal(binding().sessionId, "s1");
    assert.deepEqual(binding().pastSessions, ["s2"]);
    assert.equal(binding().parked, undefined);
    assert.equal(task.runs[0]!.status, "notified");

    // 显示：按时间穿插，不能回退或分叉任务那一段；聊天的还能
    assert.deepEqual((await hub.history(key)).map((m) => [m.text, m.anchor]), [
      ["聊两句", "a-1"],
      ["好", "a-2"],
      ["任务 s2", undefined],
      ["结果 s2", undefined],
      ["再聊", "a-3"],
      ["嗯", "a-4"],
    ]);

    // 下一条聊天接着聊天的会话，结果只带一次，页面上看不到这段背景
    chat("刚才那个结果什么意思");
    await wait();
    assert.equal(sent.at(-1)!.session, "s1");
    assert.match(sent.at(-1)!.text, /来自 s2/);
    assert.equal(stripContext(sent.at(-1)!.text), "刚才那个结果什么意思");
    chat("再问一句");
    await wait();
    assert.equal(sent.at(-1)!.text, "再问一句");

    // 运行期间发的消息：不进临时会话，跑完才发到聊天的会话
    holdTask = true;
    assert.equal(runner.runTaskNow(task), undefined);
    await wait();
    assert.equal(sent.at(-1)!.session, "s3");
    assert.deepEqual(binding().parked, { sessionId: "s1" });
    assert.equal((await hub.history(key)).filter((m) => m.text === "聊两句").length, 1, "运行中聊天记录还在");
    chat("等你跑完");
    await wait();
    assert.ok(!sent.some((m) => m.text.startsWith("等你跑完")), "排着不发");
    release();
    await wait();
    assert.equal(sent.at(-1)!.session, "s1");
    assert.ok(sent.at(-1)!.text.startsWith("等你跑完"));
    assert.equal(task.runs[0]!.status, "notified");

    // 停止：换回聊天的会话，任务记成中断
    assert.equal(runner.runTaskNow(task), undefined);
    await wait();
    assert.equal(binding().sessionId, "s4");
    await hub.stop(key);
    await wait();
    assert.equal(binding().sessionId, "s1");
    assert.equal(binding().parked, undefined);
    assert.equal(task.runs[0]!.status, "interrupted");
    clearStopped();

    // 打断并发送：排着的消息照常发到聊天的会话
    assert.equal(runner.runTaskNow(task), undefined);
    await wait();
    const pending: { id?: string }[] = [];
    const listen = (env: { key: string; ev: { type: string; id?: string } }) => {
      if (env.key === key && env.ev.type === "user") pending.push(env.ev);
    };
    hub.on("event", listen);
    chat("马上看这条");
    hub.off("event", listen);
    await wait();
    assert.match(await hub.jump(key, pending[0]!.id!), /已打断定时任务/);
    await wait();
    assert.equal(sent.at(-1)!.session, "s1");
    assert.ok(sent.at(-1)!.text.startsWith("马上看这条"));
    clearStopped();

    // 开新会话：打断运行，新会话不沾旧的
    assert.equal(runner.runTaskNow(task), undefined);
    await wait();
    await hub.newSession(key);
    assert.equal(binding().sessionId, undefined);
    assert.equal(binding().parked, undefined);
    assert.equal(binding().pastSessions, undefined);

    // 上次退出时还在跑：启动时换回来
    updateAgentBinding(key, "claude", { sessionId: "s-run", parked: { sessionId: "s-chat" } });
    hub.recoverIsolatedRuns();
    assert.equal(binding().sessionId, "s-chat");
    assert.equal(binding().parked, undefined);
    assert.deepEqual(binding().pastSessions, ["s-run"]);
  } finally {
    holdTask = false;
    runner.stopTaskRunner();
    tasks.deleteUserTasks(owner.id);
  }
});

test("任务按人隔离：别人的任务看不到、改不了、删不掉", () => {
  const a = tasks.createTask(ownerA!, { prompt: "每天看新闻", schedule: { kind: "daily", time: "08:00" } }, "user");
  tasks.createTask(ownerB!, { prompt: "B 的任务", schedule: { kind: "daily", time: "09:00" } }, "user");
  assert.deepEqual(tasks.listTasks(ownerA!).map((t) => t.id), [a.id]);
  assert.equal(tasks.getTask(ownerB!, a.id), undefined);
  assert.throws(() => tasks.updateTask(ownerB!, a.id, { enabled: false }), /不存在/);
  assert.equal(tasks.deleteTask(ownerB!, a.id), undefined);
  assert.equal(tasks.getTask(ownerA!, a.id)?.enabled, true);
  assert.equal(a.agent, "claude", "默认内置的 Claude Code 专家");
  assert.equal(a.expert, undefined);
  assert.throws(() => tasks.createTask(ownerA!, { prompt: "p", schedule: { kind: "daily", time: "08:00" }, expert: "e_nope" }, "user"), /专家不存在/);
  assert.equal(a.title, "每天看新闻", "没给名称就用提示词");
  assert.ok(a.nextRunAt && a.nextRunAt > Date.now());

  // 暂停清掉下次时间，恢复重新算
  assert.equal(tasks.updateTask(ownerA!, a.id, { enabled: false }).nextRunAt, undefined);
  assert.ok(tasks.updateTask(ownerA!, a.id, { enabled: true }).nextRunAt);

  // 专用对话的专家变了：旧对话对不上了（对话中途不能换专家），下次新开
  const t = tasks.getTask(ownerA!, a.id)!;
  t.target = { kind: "dedicated", key: "web:old" };
  const switched = tasks.updateTask(ownerA!, a.id, { expert: "codex" });
  assert.deepEqual(switched.target, { kind: "dedicated" });
  assert.equal(switched.agent, "codex");

  // 清空目录 / 模型：字段真的去掉，不是留着旧值
  tasks.updateTask(ownerA!, a.id, { cwd: "/tmp/x", model: "m1" });
  const cleared = tasks.updateTask(ownerA!, a.id, { cwd: "", model: "" });
  assert.equal(cleared.cwd, undefined);
  assert.equal(cleared.model, undefined);

  // 删用户：他的任务一起删，别人的不动
  assert.equal(tasks.deleteUserTasks(ownerA!), 1);
  assert.equal(tasks.listTasks(ownerA!).length, 0);
  assert.equal(tasks.listTasks(ownerB!).length, 1);

  // 落盘了
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, "data", "tasks.json"), "utf8")) as { owner: string }[];
  assert.deepEqual(onDisk.map((t) => t.owner), [ownerB!]);
});

test("每人有数量上限", () => {
  for (let i = 0; i < tasks.TASKS_PER_USER; i++) tasks.createTask(manyOwner!, { prompt: `p${i}`, schedule: { kind: "daily", time: "08:00" } }, "user");
  assert.throws(() => tasks.createTask(manyOwner!, { prompt: "再来", schedule: { kind: "daily", time: "08:00" } }, "user"), /最多/);
  tasks.deleteUserTasks(manyOwner!);
});

test("运行：发到专用对话，agent 判断不用提醒时标成 silent，否则照常提醒", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { getConversation } = await import("../src/core/store.js");
  const { createUser } = await import("../src/core/users.js");
  const runner = await import("../src/core/task-runner.js");

  const replies = ["[[静默]]\n当前 0.2.30，没有更新", "有新版本 0.2.31"];
  const received: string[] = [];
  hub.registerDriver({
    id: "claude",
    label: "Fake",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: (_opts, events) => ({
      sessionId: undefined,
      send: (input) => {
        received.push(input.text);
        setTimeout(() => {
          events.onSessionId("s-task");
          events.onResult({ text: replies.shift() ?? "", durationMs: 5 });
        }, 5);
      },
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => ({}),
      dispose: async () => {},
    }),
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: () => ({ kind: "x", chatMessage: "x", consoleHint: "" }),
  });
  const owner = createUser({ name: "alice", password: "password-123", role: "admin" });
  const results: { silent?: boolean; task?: unknown }[] = [];
  const onEvent = (env: { ev: { type: string } }) => {
    if (env.ev.type === "result") results.push(env.ev as never);
  };
  hub.on("event", onEvent as never);
  runner.startTaskRunner();
  try {
    const task = tasks.createTask(owner.id, { title: "查更新", prompt: "看看有没有新版本", schedule: { kind: "daily", time: "02:00" } }, "user");
    assert.equal(runner.runTaskNow(task), undefined);
    await new Promise((r) => setTimeout(r, 60));

    // 新建了专用对话，归任务的主人，提示词后面带着说明
    const key = task.target.key!;
    const conv = getConversation(key)!;
    assert.equal(conv.owner, owner.id);
    assert.equal(conv.taskId, task.id);
    assert.equal(conv.expert, undefined, "内置专家");
    assert.match(received[0]!, /^看看有没有新版本\n\n<agent-loft-context>/);
    assert.equal(results[0]?.silent, true);
    assert.equal(tasks.getTask(owner.id, task.id)!.runs[0]!.status, "silent");
    assert.equal(tasks.getTask(owner.id, task.id)!.runs[0]!.preview, "当前 0.2.30，没有更新");

    // 第二次：续用同一条专用对话，这次有事要说
    assert.equal(runner.runTaskNow(task), undefined);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(task.target.key, key);
    assert.equal(results[1]?.silent, undefined);
    assert.deepEqual(results[1]?.task, { id: task.id, title: "查更新" });
    assert.equal(tasks.getTask(owner.id, task.id)!.runs[0]!.status, "notified");

    // 普通消息的结果不带任务标记
    hub.send(key, { text: "谢谢", attachments: [] }, { channel: "web", channelId: "web" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(results[2]?.task, undefined);

    // 专家被删：已有专用对话、尚未开对话、发回原对话三条路都暂停，不能继续送进 hub。
    const experts = await import("../src/core/experts.js");
    const helper = experts.createExpert(owner.id, { name: "任务助手", engine: "claude", access: "web" });
    const dedicated = tasks.createTask(owner.id, { prompt: "专家任务", expert: helper.id, schedule: { kind: "daily", time: "08:00" } }, "user");
    assert.equal(runner.runTaskNow(dedicated), undefined);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(getConversation(dedicated.target.key!)?.expert, helper.id);
    const unopened = tasks.createTask(owner.id, { prompt: "还没开对话", expert: helper.id, schedule: { kind: "daily", time: "08:00" } }, "user");
    const original = tasks.createTask(owner.id, { prompt: "发回原对话", target: { kind: "conv", key: dedicated.target.key! }, schedule: { kind: "daily", time: "08:00" } }, "user");
    experts.deleteExpert(owner.id, helper.id);
    const before = received.length;
    for (const dead of [dedicated, unopened, original]) {
      assert.match(runner.runTaskNow(dead) ?? "", /专家已经删除/);
      assert.equal(dead.enabled, false);
      assert.equal(dead.nextRunAt, undefined);
      assert.equal(dead.runs[0]!.status, "skipped");
      assert.match(dead.runs[0]!.note!, /专家已经删除/);
      assert.equal(runner.isTaskRunning(dead.id), false);
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(received.length, before, "暂停前不能先把消息发出去");
    // 选个可用专家后恢复：丢掉原专用对话，下次正常开新对话。
    tasks.updateTask(owner.id, dedicated.id, { expert: "claude", enabled: true });
    assert.equal(dedicated.target.key, undefined);
    assert.equal(runner.runTaskNow(dedicated), undefined);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(received.length, before + 1);
    assert.equal(dedicated.runs[0]!.status, "notified");

    // 对话换了主人：任务暂停，不再往里发
    task.target = { kind: "conv", key };
    hub.reassignOwner(key, "someone-else");
    assert.match(runner.runTaskNow(task) ?? "", /不属于你/);
    assert.equal(tasks.getTask(owner.id, task.id)!.enabled, false);
  } finally {
    runner.stopTaskRunner();
    hub.off("event", onEvent as never);
  }
});

test("agent 的工具：经 MCP 子进程转给主进程，建任务要用户点授权卡，签名对不上就拒绝", async () => {
  const { spawn } = await import("node:child_process");
  const { hub } = await import("../src/core/hub.js");
  const { interactions } = await import("../src/core/interactions.js");
  const { createUser } = await import("../src/core/users.js");
  const { startTasksBridge, stopTasksBridge } = await import("../src/core/tasks-bridge.js");
  const { tasksMcpSpawn } = await import("../src/core/tasks-mcp.js");

  const bob = createUser({ name: "bob", password: "password-123", role: "member" });
  const key = "web:bob-chat";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner: bob.id });
  startTasksBridge();

  /** 拉起一个 MCP 子进程，按行收发 JSON-RPC */
  const start = (env: Record<string, string>) => {
    const spec = tasksMcpSpawn(bob.id, key, "test");
    const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    const waiting = new Map<number, (v: any) => void>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, n));
        buf = buf.slice(n + 1);
        waiting.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const call = (method: string, params: unknown) =>
      new Promise<any>((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    return { child, call };
  };

  const mcp = start({});
  try {
    const tools = await mcp.call("tools/list", {});
    assert.deepEqual(tools.result.tools.map((t: { name: string }) => t.name), ["list_tasks", "create_task", "update_task", "delete_task"]);

    const listed = await mcp.call("tools/call", { name: "list_tasks", arguments: {} });
    assert.match(listed.result.content[0].text, /还没有定时任务/);

    // 建任务：等授权卡，点了允许才建
    const creating = mcp.call("tools/call", {
      name: "create_task",
      arguments: { title: "查更新", prompt: "看看 agent-loft 有没有新版本", schedule: { kind: "daily", time: "02:00" } },
    });
    let card;
    for (let i = 0; i < 100 && !card; i++) {
      await new Promise((r) => setTimeout(r, 20));
      card = interactions.listPending(key)[0];
    }
    assert.ok(card, "弹了授权卡");
    assert.equal(card.spec.kind, "approval");
    assert.equal((card.spec as { alwaysLabel?: string }).alwaysLabel, undefined, "没有「总是允许」");
    assert.match((card.spec as { detail: string }).detail, /每天 02:00/);
    interactions.decide(card.id, "allow-once", "test");
    const created = await creating;
    assert.equal(created.result.isError, undefined, created.result.content[0].text);
    const mine = tasks.listTasks(bob.id);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0]!.target, { kind: "conv", key }, "默认回到这条对话");
    assert.equal(mine[0]!.createdBy, "agent");

    // 拒绝：不建
    const refused = mcp.call("tools/call", {
      name: "create_task",
      arguments: { prompt: "每小时跑一次", schedule: { kind: "hourly", every: 1, minute: 0 } },
    });
    for (let i = 0; i < 100 && !interactions.listPending(key)[0]; i++) await new Promise((r) => setTimeout(r, 20));
    interactions.decide(interactions.listPending(key)[0]!.id, "deny", "test");
    assert.equal((await refused).result.isError, true);
    assert.equal(tasks.listTasks(bob.id).length, 1);

    // 暂停不用问
    const paused = await mcp.call("tools/call", { name: "update_task", arguments: { id: mine[0]!.id, enabled: false } });
    assert.equal(paused.result.isError, undefined);
    assert.equal(tasks.listTasks(bob.id)[0]!.enabled, false);

    // 删除也要点卡片
    const deleting = mcp.call("tools/call", { name: "delete_task", arguments: { id: mine[0]!.id } });
    for (let i = 0; i < 100 && !interactions.listPending(key)[0]; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match((interactions.listPending(key)[0]!.spec as { title: string }).title, /删除定时任务/);
    assert.equal(tasks.listTasks(bob.id).length, 1, "点之前还在");
    interactions.decide(interactions.listPending(key)[0]!.id, "allow-once", "test");
    assert.equal((await deleting).result.isError, undefined);
    assert.equal(tasks.listTasks(bob.id).length, 0);
  } finally {
    mcp.child.kill();
  }

  // 冒充别人：改了环境变量里的用户，签名对不上
  const fake = start({ AGENT_LOFT_TASKS_USER: "someone-else" });
  try {
    const res = await fake.call("tools/call", { name: "list_tasks", arguments: {} });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /身份校验没通过/);
  } finally {
    fake.child.kill();
    stopTasksBridge();
  }
});
