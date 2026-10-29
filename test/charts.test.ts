import { test } from "node:test";
import assert from "node:assert/strict";
import { chartsToTables } from "../src/core/charts.js";

test("飞书：```chart 换成表格，坏的原样留着", () => {
  const text = [
    "看图：",
    "```chart",
    '{"type":"line","title":"访问量","x":["10-23","10-24"],"series":[{"name":"PV","data":[1200,null]},{"name":"UV","data":[80,66]}],"unit":"次"}',
    "```",
    "完。",
  ].join("\n");
  const out = chartsToTables(text);
  assert.match(out, /\*\*📊 访问量\*\*/);
  assert.match(out, /\|  \| PV（次） \| UV（次） \|/);
  assert.match(out, /\| 10-23 \| 1,200 \| 80 \|/);
  assert.match(out, /\| 10-24 \| — \| 66 \|/);
  assert.match(out, /^看图：/);
  assert.match(out, /完。$/);
  assert.doesNotMatch(out, /```/);

  const pie = chartsToTables('```chart\n{"type":"pie","series":[{"name":"占比","data":[{"name":"A|B","value":3}]}]}\n```');
  assert.match(pie, /\| A\\\|B \| 3 \|/);

  const broken = "```chart\n{坏的\n```";
  assert.equal(chartsToTables(broken), broken);
  const other = "```js\nconst chart = 1\n```";
  assert.equal(chartsToTables(other), other);
});
