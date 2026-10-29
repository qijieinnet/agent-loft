import { test } from "node:test";
import assert from "node:assert/strict";
import { dirsOf, forkTrees, inDir, inRecent, pageOf, parseCursor, searchConvs } from "../src/channels/web/conv-pages.js";
import type { ConversationInfo } from "../src/core/hub.js";

const conv = (key: string, activeAt: number, extra: Partial<ConversationInfo> = {}): ConversationInfo =>
  ({ key, activeAt, channel: "web", channelId: "web", agent: "claude", cwd: "/w", busy: false, createdAt: 0, mode: "work", ...extra }) as ConversationInfo;

test("分叉挂在主对话下面算一棵树，按整棵树最近的活跃时间排", () => {
  const list = [conv("a", 10), conv("b", 50), conv("a1", 90, { forkOf: "a" }), conv("a1x", 20, { forkOf: "a1" }), conv("c", 70)];
  const trees = forkTrees(list);
  assert.deepEqual(
    trees.map((t) => [t.root.key, t.at, t.convs.map((c) => c.key).sort()]),
    [
      ["a", 90, ["a", "a1", "a1x"]],
      ["c", 70, ["c"]],
      ["b", 50, ["b"]],
    ],
  );
  // 父对话不在这一组（删了 / 在别的目录）：自己就是根；父链绕回自己也当根
  assert.deepEqual(forkTrees([conv("x", 1, { forkOf: "gone" })]).map((t) => t.root.key), ["x"]);
  assert.deepEqual(forkTrees([conv("p", 1, { forkOf: "q" }), conv("q", 2, { forkOf: "p" })]).length, 2);
});

test("按游标翻页：一棵树整棵返回；期间有会话变活跃、被删也不漏", () => {
  const list = Array.from({ length: 25 }, (_, i) => conv(`k${String(i).padStart(2, "0")}`, 1000 - i));
  list.push(conv("k00-fork", 5, { forkOf: "k00" }));
  const p1 = pageOf(list, null, 10);
  assert.equal(new Set(p1.conversations.map((c) => c.key)).size, 11); // k00 带着它的分叉
  assert.deepEqual(p1.next, { at: 991, key: "k09" });

  // 第一页里的一条被删了、第二页里的一条变得最活跃：第二页仍从 k10 接着
  const changed = list.filter((c) => c.key !== "k03").map((c) => (c.key === "k15" ? { ...c, activeAt: 5000 } : c));
  const p2 = pageOf(changed, p1.next, 10);
  assert.deepEqual(
    p2.conversations.map((c) => c.key),
    ["k10", "k11", "k12", "k13", "k14", "k16", "k17", "k18", "k19", "k20"],
  );
  const p3 = pageOf(changed, p2.next, 10);
  assert.deepEqual(p3.conversations.map((c) => c.key), ["k21", "k22", "k23", "k24"]);
  assert.equal(p3.next, null);
  assert.deepEqual(pageOf(changed, { at: 0, key: "" }, 10), { conversations: [], next: null });
});

test("最近不含飞书；项目按目录；目录按最近活跃排；游标参数", () => {
  const list = [conv("w1", 3, { cwd: "/a" }), conv("w2", 9, { cwd: "/b" }), conv("f", 99, { channel: "feishu", channelId: "bot" }), conv("w3", 5, { cwd: "/a" })];
  assert.deepEqual(list.filter(inRecent).map((c) => c.key), ["w1", "w2", "w3"]);
  assert.deepEqual(list.filter(inDir("/a")).map((c) => c.key), ["w1", "w3"]);
  assert.deepEqual(dirsOf(list), [
    { dir: "/b", at: 9 },
    { dir: "/a", at: 5 },
  ]);
  assert.deepEqual(parseCursor("12", "k"), { at: 12, key: "k" });
  assert.equal(parseCursor(null, null), null);
  assert.equal(parseCursor("x", "k"), null);
});

test("搜索会话：标题里每个词都有的才算，整句在标题里的靠前；再接上聊天内容搜到的，不重复", () => {
  const list = [
    conv("a", 10, { title: "接口 401 上报规则" }),
    conv("b", 30, { title: "401 登录问题" }),
    conv("c", 20, { title: "登录 接口 401" }),
    conv("d", 40, { title: "别的", cwd: "/w/tclaw-web" }),
    conv("e", 50, { title: "无关" }),
  ];
  assert.deepEqual(searchConvs(list, "401").map((r) => r.conv.key), ["b", "c", "a"]);
  assert.deepEqual(searchConvs(list, "接口 401").map((r) => r.conv.key), ["c", "a"]);
  assert.deepEqual(searchConvs(list, "登录 401").map((r) => r.conv.key), ["b", "c"]);
  // 目录名也算
  assert.deepEqual(searchConvs(list, "TCLAW").map((r) => r.conv.key), ["d"]);
  const hits = searchConvs(list, "401", [{ key: "b", text: "x" }, { key: "e", text: "说到 401" }, { key: "gone", text: "y" }]);
  assert.deepEqual(hits.map((r) => [r.conv.key, r.snippet]), [["b", undefined], ["c", undefined], ["a", undefined], ["e", "说到 401"]]);
  // 没输入：最近活跃的
  assert.deepEqual(searchConvs(list, "  ").map((r) => r.conv.key), ["e", "d", "b", "c", "a"]);
});
