import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-ui-prefs-"));
process.env.AGENT_LOFT_HOME = home;
fs.mkdirSync(path.join(home, "data"), { recursive: true });

const prefs = await import("../src/core/ui-prefs.js");

test("目录顺序：没存过是 undefined，存了之后按用户分开、重启后还在", () => {
  assert.equal(prefs.getDirOrder("u1"), undefined);
  prefs.setDirOrder("u1", ["/b", "/a", "/b", 3, ""]);
  prefs.setDirOrder("u2", ["/x"]);
  prefs.resetUiPrefsForTest();
  assert.deepEqual(prefs.getDirOrder("u1"), ["/b", "/a"]);
  assert.deepEqual(prefs.getDirOrder("u2"), ["/x"]);
});

test("追加只把新目录接在最后，不动已有的名次", () => {
  prefs.setDirOrder("u1", ["/b", "/a"]);
  assert.deepEqual(prefs.appendDirOrder("u1", ["/a", "/c"]), ["/b", "/a", "/c"]);
  assert.deepEqual(prefs.appendDirOrder("u3", []), []);
  assert.deepEqual(prefs.getDirOrder("u3"), []);
});

test("删用户时一起删掉", () => {
  prefs.deleteUiPrefs("u1");
  assert.equal(prefs.getDirOrder("u1"), undefined);
  assert.deepEqual(prefs.getDirOrder("u2"), ["/x"]);
});

test("侧栏菜单：默认设置收进更多，勾选和排序按账号保存，且不覆盖项目顺序", () => {
  const defaults = prefs.getSidebarNav("new");
  assert.deepEqual(defaults.map((it) => it.id), ["search", "tasks", "library", "remote", "settings"]);
  assert.deepEqual(defaults.filter((it) => !it.visible).map((it) => it.id), ["settings"]);
  const items = [
    { id: "library", visible: true },
    { id: "search", visible: true },
    { id: "tasks", visible: false },
    { id: "settings", visible: false },
    { id: "remote", visible: false },
  ];
  prefs.setDirOrder("nav-user", ["/b", "/a"]);
  assert.deepEqual(prefs.setSidebarNav("nav-user", items), items);
  prefs.resetUiPrefsForTest();
  assert.deepEqual(prefs.getSidebarNav("nav-user"), items);
  assert.deepEqual(prefs.getDirOrder("nav-user"), ["/b", "/a"]);
  prefs.appendDirOrder("nav-user", ["/c"]);
  assert.deepEqual(prefs.getSidebarNav("nav-user"), items);
  assert.deepEqual(prefs.getSidebarNav("other-user"), defaults);
  prefs.deleteUiPrefs("nav-user");
  assert.deepEqual(prefs.getSidebarNav("nav-user"), defaults);
});

test("侧栏菜单：过滤未知项和重复项，补回缺失菜单；允许把所有菜单收进更多", () => {
  assert.deepEqual(prefs.setSidebarNav("nav-clean", [
    null, 3, { id: "unknown", visible: true }, { id: "settings", visible: true },
    { id: "settings", visible: false }, { id: "tasks", visible: "no" },
  ]), [
    { id: "settings", visible: true }, { id: "tasks", visible: true },
    { id: "search", visible: true }, { id: "library", visible: true }, { id: "remote", visible: true },
  ]);
  const allHidden = prefs.getSidebarNav("nav-clean").map((it) => ({ ...it, visible: false }));
  assert.deepEqual(prefs.setSidebarNav("nav-clean", allHidden), allHidden);
});
