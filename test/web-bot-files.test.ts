import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeZip } from "../src/core/zip.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-bot-files-"));
process.env.AGENT_LOFT_HOME = home;
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const { createUser, getUser } = await import("../src/core/users.js");
const { listBots, startTurn, finishTurn, retryBotTurn, createInvite, acceptInvite, stopSharing } = await import("../src/core/web-bots.js");
const { fileContext, filesInPage, parseBotFile } = await import("../src/core/web-bot-files.js");
const { handleBotsApi } = await import("../src/channels/web/bots-api.js");
const { sql, closeDatabaseForTest } = await import("../src/core/db.js");
after(() => { closeDatabaseForTest(); fs.rmSync(home, { recursive: true, force: true }); });
const file = (name: string, bytes: string | Buffer) => parseBotFile({ name, data: Buffer.from(bytes).toString("base64") });

test("附件正文、归档下载、重试和删除都遵循原话题", async () => {
  const owner = createUser({name:"上传者",password:"test-password"}), guest = createUser({name:"成员",password:"test-password"});
  const bot = listBots(owner.id)[0]!;
  const thread = acceptInvite(guest.id, createInvite(owner.id, bot.id).token).sharedThreadId!;
  const doc = file("计划.docx", writeZip([{ path:"word/document.xml", data:Buffer.from('<w:document xmlns:w="urn:test"><w:p><w:r><w:t>周三出发</w:t></w:r></w:p></w:document>') }]));
  const sheet = file("表.xlsx", writeZip([
    { path:"xl/sharedStrings.xml",data:Buffer.from("<sst><si><t>水壶</t></si></sst>") },
    { path:"xl/worksheets/sheet1.xml",data:Buffer.from('<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>3</v></c></row></worksheet>') },
  ]));
  assert.throws(() => file("a.constructor", "abc"), /支持/);
  assert.throws(() => file("a.pdf", "abc"), /不符/);
  const message = startTurn(owner.id, thread, "with-files", "", [], [doc, sheet, file("备忘.md", "乘车")]).message;
  const contents = await fileContext(message.id, () => {});
  assert.match(contents[0]!.text, /周三出发/);
  assert.match(contents[1]!.text, /A1=水壶\tB1=3/);
  assert.equal(contents[2]!.text, "乘车");
  finishTurn(owner.id, thread, "with-files", "失败", true);
  const retry = await retryBotTurn(owner.id, thread, message.id);
  assert.deepEqual(await fileContext(retry.message.id, () => {}), contents);
  finishTurn(owner.id, thread, "retry:" + message.id, "已读");
  stopSharing(owner.id, bot.id);
  const url = new URL(`http://localhost/api/bots/${bot.id}/archives/${thread}/${message.id}/files/2`);
  const req = { method:"GET", headers:{} } as IncomingMessage;
  let output: Buffer | undefined;
  const res = {writeHead(code:number) { assert.equal(code,200); },end(value:Buffer) { output=value; }} as unknown as ServerResponse;
  await handleBotsApi(req, res, url, getUser(owner.id)!);
  assert.equal(output?.toString(), "乘车");
  await assert.rejects(handleBotsApi(req, res, url, getUser(guest.id)!));
  sql("DELETE FROM web_bot_messages WHERE id=?").run(message.id);
  assert.equal(sql("SELECT 1 FROM web_bot_files WHERE message=?").get(message.id), undefined);
});

test("语音转写在发送后进行，转写内容可回看并可重用", async t => {
  const owner = createUser({name:"录音者", password:"test-password"});
  const bot = listBots(owner.id)[0]!;
  const recording = file("语音.wav", Buffer.from("RIFF0000WAVEdata"));
  const m = startTurn(owner.id, bot.privateThreadId, "audio", "", [], [recording]).message;
  delete process.env.AGENT_LOFT_BOT_TRANSCRIPTION_URL;
  await assert.rejects(fileContext(m.id, () => {}), /录音已保存/);
  process.env.AGENT_LOFT_BOT_TRANSCRIPTION_URL = "https://transcribe.example/v1/audio/transcriptions";
  process.env.AGENT_LOFT_BOT_TRANSCRIPTION_KEY = "fixture";
  process.env.AGENT_LOFT_BOT_TRANSCRIPTION_MODEL = "test-model";
  const call = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, process.env.AGENT_LOFT_BOT_TRANSCRIPTION_URL);
    assert.deepEqual(init.headers, { Authorization:"Bearer fixture" });
    const form = init.body as FormData;
    assert.equal(form.get("model"), "test-model");
    assert.deepEqual(Buffer.from(await (form.get("file") as File).arrayBuffer()), recording.data);
    return Response.json({ text:"周五带上雨伞" });
  });
  const first = await fileContext(m.id, () => {});
  assert.equal(first[0]?.text, "周五带上雨伞");
  assert.equal(filesInPage(bot.privateThreadId, m.id, m.id).get(m.id)?.[0]?.transcript, first[0]?.text);
  assert.deepEqual(await fileContext(m.id, () => {}), first);
  assert.equal(call.mock.callCount(), 1);
});

test("PDF 文字层通过标准输入提取", { skip: spawnSync("pdftotext", ["-v"]).status !== 0 }, async () => {
  const owner = createUser({ name:"pdf-owner", password:"test-password" });
  const bot = listBots(owner.id)[0]!;
  const content = "BT /F1 14 Tf 50 100 Td (Friday train) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return String(offset).padStart(10, "0") + " 00000 n \n";
  });
  const start = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n" + offsets.join("") + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const { message } = startTurn(owner.id, bot.privateThreadId, "pdf", "", [], [file("trip.pdf", pdf)]);
  const [body] = await fileContext(message.id, () => {});
  assert.match(body!.text, /Friday train/);
});
