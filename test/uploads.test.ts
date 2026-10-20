// 附件清单解析（历史里把附件拆出来展示）和附件文件的路径校验。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-uploads-"));
const { describeAttachments, resolveUploadFile, saveBuffer, splitAttachmentNote } = await import("../src/core/uploads.js");

test("splitAttachmentNote 拆出原文和附件，顺序不变", () => {
  const a = saveBuffer({ key: "web:t", data: Buffer.from("89504e470d0a1a0a00000000", "hex"), name: "图 1（副本）.png" });
  const b = saveBuffer({ key: "web:t", data: Buffer.from("hello"), name: "notes.txt" });
  const text = `看看这两个\n\n${describeAttachments([a, b], (x) => x.kind === "image")}`;
  const out = splitAttachmentNote(text);
  assert.equal(out.text, "看看这两个");
  assert.deepEqual(
    out.attachments.map((x) => [x.kind, x.name, x.path, x.size]),
    [
      ["image", a.name, a.path, 12],
      ["file", "notes.txt", b.path, 5],
    ],
  );
});

test("splitAttachmentNote 没有清单时原样返回", () => {
  assert.deepEqual(splitAttachmentNote("普通消息"), { text: "普通消息", attachments: [] });
});

test("resolveUploadFile 只放行上传目录里的文件", () => {
  const a = saveBuffer({ key: "web:t2", data: Buffer.from("x"), name: "a.txt" });
  assert.equal(resolveUploadFile(a.path), fs.realpathSync(a.path));
  assert.equal(resolveUploadFile(path.join(path.dirname(a.path), "../../../config.json")), undefined);
  assert.equal(resolveUploadFile("/etc/passwd"), undefined);
  assert.equal(resolveUploadFile(path.dirname(a.path)), undefined);
});
