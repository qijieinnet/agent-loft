import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-scheduled-"));
process.env.AGENT_LOFT_HOME = home;
fs.mkdirSync(path.join(home, "data"), { recursive: true });

const sched = await import("../src/core/scheduled.js");

test("定时消息：按时间排序、可取消、到点发出并从列表里移除", async () => {
  const fired: string[] = [];
  sched.startScheduler((m) => fired.push(m.text));
  try {
    const later = sched.addScheduled("web:a", "later", Date.now() + 3600_000);
    sched.addScheduled("web:a", "soon", Date.now() + 50);
    sched.addScheduled("web:b", "other", Date.now() + 3600_000);
    assert.deepEqual(sched.listScheduled("web:a").map((m) => m.text), ["soon", "later"]);

    assert.equal(sched.removeScheduled("web:b", later.id), false, "别的对话删不掉");
    assert.equal(sched.removeScheduled("web:a", later.id), true);

    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(fired, ["soon"]);
    assert.equal(sched.listScheduled("web:a").length, 0);

    // 落盘了：清掉对话后文件里也没了
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(home, "data", "scheduled.json"), "utf8")) as { key: string }[];
    assert.deepEqual(onDisk().map((m) => m.key), ["web:b"]);
    sched.clearScheduled("web:b");
    assert.deepEqual(onDisk(), []);
  } finally {
    sched.stopScheduler();
  }
});

test("定时消息：空内容和超出条数上限会被拒绝", () => {
  assert.throws(() => sched.addScheduled("web:c", "  ", Date.now() + 1000));
  for (let i = 0; i < sched.SCHEDULED_MAX; i++) sched.addScheduled("web:c", `m${i}`, Date.now() + 3600_000);
  assert.throws(() => sched.addScheduled("web:c", "one more", Date.now() + 3600_000));
  sched.clearScheduled("web:c");
});
