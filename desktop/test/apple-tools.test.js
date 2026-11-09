import assert from "node:assert/strict";
import test from "node:test";
import { serviceOf, TOOLS, toolArgs, toolList } from "../src/apple-tools.js";

test("工具列表：名字唯一，必填参数都在 properties 里", () => {
  const list = toolList();
  assert.equal(new Set(list.map((t) => t.name)).size, list.length);
  for (const t of list) {
    assert.match(t.name, /^[a-z_]{1,64}$/);
    for (const r of t.inputSchema.required ?? []) assert.ok(r in t.inputSchema.properties, `${t.name}.${r}`);
    // 内部用的 flag 不出现在 schema 里
    for (const p of Object.values(t.inputSchema.properties)) assert.equal("flag" in p, false);
  }
  assert.equal(list.length, TOOLS.length);
});

test("参数一律写成 --key=value，下划线换成连字符", () => {
  const { args } = toolArgs("calendar_add_event", { title: "--不是参数", start: "2026-11-10 15:00", all_day: false, duration: 30, location: "" });
  assert.deepEqual(args, ["events", "add", "--title=--不是参数", "--start=2026-11-10 15:00", "--all-day=false", "--duration=30", "--location="]);
});

test("勾完成按 completed 挑子命令，completed 本身不传给 Bridge", () => {
  assert.deepEqual(toolArgs("reminders_set_completed", { id: "X" }).args, ["reminders", "complete", "--id=X"]);
  assert.deepEqual(toolArgs("reminders_set_completed", { id: "X", completed: false }).args, ["reminders", "reopen", "--id=X"]);
});

test("搜索正文的 in_body 对应 notes.js 的 --body", () => {
  assert.deepEqual(toolArgs("notes_search", { query: "鸡腿", in_body: true }).args, ["notes", "search", "--query=鸡腿", "--body=true"]);
});

test("参数不对时报错", () => {
  assert.throws(() => toolArgs("calendar_add_event", { title: "x" }), /缺少参数 start/);
  assert.throws(() => toolArgs("calendar_list_events", { nope: 1 }), /没有参数 nope/);
  assert.throws(() => toolArgs("calendar_list_events", { limit: "3" }), /正整数/);
  assert.throws(() => toolArgs("reminders_list", { status: "x" }), /只能是/);
  assert.throws(() => toolArgs("no_such_tool", {}), /没有这个工具/);
});

test("删改类工具标成 destructive，并给足等确认的时间", () => {
  for (const name of ["calendar_update_event", "calendar_delete_event", "reminders_update", "reminders_delete", "notes_update", "notes_delete", "contacts_update", "contacts_delete"]) {
    const t = TOOLS.find((x) => x.name === name);
    assert.equal(t.annotations.destructiveHint, true, name);
    assert.ok(t.timeout >= 150_000, name);
  }
});

test("数组参数转成 JSON 交给 Bridge", () => {
  const { args } = toolArgs("contacts_add", { given_name: "小明", phones: [{ label: "mobile", value: "138 0000 0000" }, { value: "021-1234" }] });
  assert.deepEqual(args, ["contacts", "add", "--given-name=小明", '--phones=[{"label":"mobile","value":"138 0000 0000"},{"label":"","value":"021-1234"}]']);
  assert.deepEqual(toolArgs("photos_get_thumbnails", { ids: ["A/L0/001", "B/L0/001"] }).args, ["photos", "thumbnails", '--ids=["A/L0/001","B/L0/001"]']);
  assert.equal(toolArgs("photos_get_thumbnails", { ids: ["x"] }).images, true);
  assert.throws(() => toolArgs("contacts_add", { phones: [{ label: "x" }] }), /格式不对/);
  assert.throws(() => toolArgs("photos_search", { offset: -1 }), /非负整数/);
  assert.deepEqual(toolArgs("photos_search", { offset: 0 }).args, ["photos", "search", "--offset=0"]);
});

test("按应用开关过滤工具：关掉的应用不列，apple_status 一直在", () => {
  const names = toolList({ calendars: true, reminders: false, notes: false, contacts: false, photos: true, mail: false }).map((t) => t.name);
  assert.ok(names.includes("apple_status"));
  assert.ok(names.includes("calendar_list_events") && names.includes("photos_search"));
  assert.ok(!names.some((n) => n.startsWith("reminders_") || n.startsWith("notes_") || n.startsWith("contacts_") || n.startsWith("mail_")));
  assert.equal(serviceOf("calendar_add_event"), "calendars");
  assert.equal(serviceOf("apple_status"), null);
  // 照片、邮件没有删改工具
  assert.ok(!TOOLS.some((t) => /^(photos|mail)_/.test(t.name) && t.annotations.destructiveHint));
});
