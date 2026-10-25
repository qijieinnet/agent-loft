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
