import { test } from "node:test";
import assert from "node:assert/strict";
import { albumReferences, albumsToText } from "../src/core/albums.js";
import { mentions } from "../src/core/reply-files.js";

const fence = (spec: unknown) => `\`\`\`album\n${JSON.stringify(spec)}\n\`\`\``;

test("相册 JSON 中转义的路径也可访问，只认完整引用的缩略图和预览文件", () => {
  const src = '/tmp/家庭 "合照"\\1.webp';
  const preview = "/tmp/合照 大图.jpg";
  const reply = fence({ items: [{ src, preview }] }).replace(/家庭/g, "\\u5bb6\\u5ead");
  assert.deepEqual(albumReferences(reply).paths, [src, preview]);
  assert.ok(mentions(reply, src));
  assert.ok(mentions(reply, preview));
  assert.ok(!mentions(reply, "/tmp/合照"));
  assert.ok(!mentions(reply, "/tmp/家庭"));
  assert.ok(!mentions(reply, "/etc/passwd"));
});

test("飞书相册摘要保留总数和日期，限制为 12 条且不输出本地路径", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ src: `/tmp/${i}.webp`, name: `照片 ${i + 1}`, date: "2026-10-31", caption: "香港" }));
  const summary = albumsToText(`找到这些照片：\n\n${fence({ title: "家庭相片", total: 80, items })}`);
  assert.match(summary, /共 80 张（已载入 30 张）/);
  assert.match(summary, /12\. 照片 12 · 2026-10-31 · 香港/);
  assert.match(summary, /还有 18 张/);
  assert.doesNotMatch(summary, /\/tmp\/|```|照片 13/);
  assert.match(summary, /Web/);
});

test("相册空结果、多代码块、波浪围栏；无效 JSON、远程路径、过大列表不当成相册", () => {
  const empty = fence({ items: [] });
  assert.match(albumsToText(empty), /没有照片/);
  const one = '~~~album\r\n{"items":[{"src":"/tmp/a.webp"}]}\r\n~~~';
  assert.deepEqual(albumReferences(`${empty}\n\n${one}`).paths, ["/tmp/a.webp"]);
  assert.match(albumsToText(one), /照片 1/);
  for (const invalid of ["```album\n{\n```", fence({ items: [{ src: "https://remote.example/photo" }] }), fence({ items: Array.from({ length: 201 }, () => ({ src: "/tmp/a.jpg" })) })]) {
    assert.equal(albumsToText(invalid), invalid);
    assert.deepEqual(albumReferences(invalid).paths, []);
  }
});
