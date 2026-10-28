import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopScreens, nameScreens, parseXrandr, screenSource } from "../src/core/desktop-screens.js";

test("多块屏：macOS 的从整屏画面里学，拼满整个画面、又发回第一块才算学全", async () => {
  const src = await screenSource("test:1", { local: false });
  const left = { x: 0, y: 50, w: 100, h: 100 };
  const right = { x: 100, y: 0, w: 200, h: 200 };
  assert.equal(src.get(300, 200), null);
  assert.equal(src.learn(300, 200, [left]), false);
  // 拼满了，但不知道一共几块：等它转一圈
  assert.equal(src.learn(300, 200, [right]), false);
  assert.equal(src.learn(300, 200, [left]), true);
  assert.deepEqual(src.get(300, 200), [
    { ...left, name: "屏幕 1" },
    { ...right, name: "屏幕 2" },
  ]);
  assert.deepEqual(desktopScreens(), { screens: [{ name: "屏幕 1" }, { name: "屏幕 2" }] });
  // 画面大小变了：不算数
  assert.equal(src.get(300, 201), null);
  // 下次连上直接用
  assert.deepEqual((await screenSource("test:1", { local: false })).get(300, 200)?.length, 2);
  // 换了一个 VNC 服务：重新来
  assert.equal((await screenSource("test:2", { local: false })).get(300, 200), null);
});

test("多块屏：重叠的说明摆法变了，旧的换掉；没拼满整个画面不算学全", async () => {
  const src = await screenSource("test:3", { local: false });
  assert.equal(src.learn(300, 200, [{ x: 0, y: 0, w: 150, h: 200 }]), false);
  assert.equal(src.learn(300, 200, [{ x: 0, y: 0, w: 100, h: 200 }]), false);
  // 转了一圈，可还没拼满
  assert.equal(src.learn(300, 200, [{ x: 0, y: 0, w: 100, h: 200 }]), false);
  assert.equal(src.learn(300, 200, [{ x: 100, y: 0, w: 200, h: 200 }]), true);
  assert.deepEqual(
    src.get(300, 200)?.map((s) => s.w),
    [100, 200],
  );
});

test("多块屏：按像素大小和从左到右的顺序对上系统里的名字", () => {
  // 实测的一台 MacBook 接 5K 显示器：画面 8540×2880
  const system = [
    { name: "内建视网膜显示器", w: 3420, h: 2224, x: 0, y: 0 },
    { name: "Mi Monitor", w: 5120, h: 2880, x: 1710, y: -123 },
  ];
  assert.deepEqual(
    nameScreens(
      [
        { x: 3420, y: 0, w: 5120, h: 2880 },
        { x: 0, y: 205, w: 3420, h: 2224 },
      ],
      system,
    ).map((s) => [s.x, s.name]),
    [
      [0, "内建视网膜显示器"],
      [3420, "Mi Monitor"],
    ],
  );
  // 两块一样大：按左右顺序；对不上的叫「屏幕 N」
  const twins = [
    { name: "左", w: 100, h: 100, x: -100, y: 0 },
    { name: "右", w: 100, h: 100, x: 0, y: 0 },
  ];
  assert.deepEqual(
    nameScreens(
      [
        { x: 100, y: 0, w: 100, h: 100 },
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 200, y: 0, w: 50, h: 100 },
      ],
      twins,
    ).map((s) => s.name),
    ["左", "右", "屏幕 3"],
  );
  assert.deepEqual(
    nameScreens([{ x: 0, y: 0, w: 10, h: 10 }], null).map((s) => s.name),
    ["屏幕 1"],
  );
});

test("多块屏：xrandr 的输出里取接上了、开着的屏", () => {
  const text = `Screen 0: minimum 8 x 8, current 3840 x 1200, maximum 32767 x 32767
eDP-1 connected primary 1920x1080+1920+120 (normal left inverted right x axis y axis) 344mm x 194mm
   1920x1080     60.02*+
HDMI-1 connected 1920x1200+0+0 (normal left inverted right x axis y axis) 527mm x 296mm
DP-1 disconnected (normal left inverted right x axis y axis)
DP-2 connected (normal left inverted right x axis y axis)
`;
  assert.deepEqual(parseXrandr(text), {
    w: 3840,
    h: 1200,
    screens: [
      { name: "HDMI-1", w: 1920, h: 1200, x: 0, y: 0 },
      { name: "eDP-1", w: 1920, h: 1080, x: 1920, y: 120 },
    ],
  });
  assert.equal(parseXrandr("xrandr: Can't open display"), null);
});
