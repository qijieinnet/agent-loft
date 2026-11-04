// 解析 git diff 的 unified 格式。不碰 DOM，方便单独测试。

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/**
 * 返回 { meta, hunks, combined }：
 *   meta：第一个 @@ 之前的行（diff --git、rename from、old mode…）
 *   hunks：[{ header, section, lines: [{ type: "ctx" | "add" | "del" | "note", text, oldNo, newNo }] }]
 *   combined：合并冲突时的 @@@ 格式，每行有两列标记，行号对不上单双栏，由调用方原样显示
 */
export function parseUnifiedDiff(text) {
  const meta = [];
  const hunks = [];
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.some((l) => l.startsWith("@@@ "))) return { meta: [], hunks: [], combined: true, raw: lines };
  for (const line of lines) {
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, section: m[3].trim(), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      meta.push(line);
      continue;
    }
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "+") hunk.lines.push({ type: "add", text: body, newNo: newNo++ });
    else if (mark === "-") hunk.lines.push({ type: "del", text: body, oldNo: oldNo++ });
    else if (mark === "\\") hunk.lines.push({ type: "note", text: line.slice(2) });
    else if (mark === " " || line === "") hunk.lines.push({ type: "ctx", text: body, oldNo: oldNo++, newNo: newNo++ });
    else {
      // 下一个文件的头（重命名时可能一次带两段）：后面的再遇到 @@ 才算内容
      meta.push(line);
      hunk = null;
    }
  }
  return { meta, hunks, combined: false };
}

/** 增删行数 */
export function diffStat(parsed) {
  let added = 0;
  let removed = 0;
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") added++;
      else if (line.type === "del") removed++;
    }
  }
  return { added, removed };
}

/**
 * 并排显示用：把一段连续的删除和紧跟的新增配成对，其余的上下对齐。
 * 返回 [{ left, right }]，没有对应的一侧是 null；note（文件末尾没有换行）跟在它那一行的那一侧后面单独成行
 */
export function pairLines(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "ctx") {
      rows.push({ left: line, right: line });
      i++;
    } else if (line.type === "note") {
      rows.push({ left: line, right: line });
      i++;
    } else {
      const dels = [];
      const adds = [];
      while (lines[i]?.type === "del") dels.push(lines[i++]);
      while (lines[i]?.type === "add") adds.push(lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}
