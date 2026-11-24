import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-photo-retry-"));
process.env.AGENT_LOFT_HOME = home;
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const { createUser, getUser } = await import("../src/core/users.js");
const { listBots, startTurn, finishTurn, retryBotTurn, retryableBotMessages, getBotMessage, createInvite, acceptInvite, removeMember } = await import("../src/core/web-bots.js");
const { handleBotsApi } = await import("../src/channels/web/bots-api.js");
const { sanitizeBotImage } = await import("../src/core/web-bot-photo.js");
const { closeDatabaseForTest } = await import("../src/core/db.js");
after(() => { closeDatabaseForTest(); fs.rmSync(home, { recursive:true, force:true }); });

test("旧照片下载及失败重试会清除 EXIF 并保留方向，重试仅原作者当前成员身份可用且幂等", async () => {
  const owner = createUser({name:"a",password:"test-password"}), guest = createUser({name:"b",password:"test-password"});
  const bot = listBots(owner.id)[0]!;
  const shared = acceptInvite(guest.id, createInvite(owner.id, bot.id).token).sharedThreadId!;
  const raw = await sharp({create:{width:12,height:8,channels:3,background:"orange"}})
    .withMetadata({orientation:6}).withExifMerge({ IFD0:{ImageDescription:"private-location-marker"} }).jpeg().toBuffer();
  assert.ok((await sharp(raw).metadata()).exif);
  const first = startTurn(guest.id, shared, "old-photo", "这张照片", [{name:"home.jpg",mediaType:"image/jpeg",data:raw.toString("base64")}]).message;
  finishTurn(guest.id, shared, "old-photo", "中断", true);
  let download: Buffer | undefined;
  const res = {writeHead(code: number) { assert.equal(code, 200); }, end(buffer: Buffer) {download = buffer;} } as unknown as ServerResponse;
  await handleBotsApi({method:"GET"} as IncomingMessage, res, new URL("http://localhost/api/bots/threads/" + shared + "/messages/" + first.id + "/image"), getUser(guest.id)!);
  async function checkPhoto(bytes: Buffer) {
    const meta = await sharp(bytes).metadata();
    assert.deepEqual([meta.width, meta.height], [8,12]);
    assert.equal(meta.exif, undefined);
    assert.equal(bytes.includes("private-location-marker"), false);
  }
  assert.ok(download);
  await checkPhoto(download);
  assert.deepEqual([...retryableBotMessages(guest.id, shared, first.id, first.id)], [first.id]);
  await assert.rejects(retryBotTurn(owner.id, shared, first.id), /不可重试/);
  const [a,b] = await Promise.all([retryBotTurn(guest.id, shared, first.id), retryBotTurn(guest.id, shared, first.id)]);
  assert.equal(a.message.id, b.message.id);
  assert.equal(Number(a.started) + Number(b.started), 1);
  const retry = getBotMessage(guest.id, shared, a.message.id)!;
  assert.equal(retry.text, first.text);
  await checkPhoto(Buffer.from(retry.images[0]!.data!, "base64"));
  finishTurn(guest.id, shared, "retry:" + first.id, "完成");
  assert.equal((await retryBotTurn(guest.id, shared, first.id)).started, false);
  assert.equal(retryableBotMessages(guest.id, shared, first.id, first.id).size, 0);
  removeMember(owner.id, bot.id, guest.id);
  acceptInvite(guest.id, createInvite(owner.id, bot.id).token);
  await assert.rejects(retryBotTurn(guest.id, shared, first.id), /不可重试/);
});

test("客户端和服务端可清理动图附加字段并保留两帧、播放间隔和循环", async () => {
  const clientModule = "../web/bot/animated-photo.js";
  const {cleanAnimation} = await import(clientModule);
  const raw = Buffer.from([255,0,0, 0,0,255]);
  for (const format of ["gif","webp"] as const) {
    const twoFrames = await sharp(raw, {raw:{width:1,height:2,channels:3,pageHeight:1}})
      [format]({delay:[150,250], loop:3}).toBuffer();
    const marker = Buffer.from("secret");
    let bytes: Buffer;
    if (format === "gif") bytes = Buffer.concat([twoFrames.subarray(0,-1), Buffer.from([0x21,0xfe,marker.length]), marker, Buffer.from([0,0x3b])]);
    else {
      const chunk = Buffer.alloc(8);
      chunk.write("XMP "); chunk.writeUInt32LE(marker.length,4);
      bytes = Buffer.concat([twoFrames,chunk,marker]); bytes.writeUInt32LE(bytes.length-8,4);
    }
    const mime = "image/" + format;
    const client = cleanAnimation(Uint8Array.from(bytes), mime)!;
    const service = await sanitizeBotImage({name:"test",mediaType:mime,data:bytes.toString("base64")});
    for (const output of [Buffer.from(await client.arrayBuffer()),Buffer.from(service.data,"base64")]) {
      assert.equal(output.includes(marker), false);
      const meta = await sharp(output, {animated:true}).metadata();
      assert.deepEqual([meta.pages,meta.loop,meta.delay], [2,3,[150,250]]);
    }
  }
});
