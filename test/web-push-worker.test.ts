import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../web/lib/push-worker.js", import.meta.url), "utf8");
const botOrigin = "https://loft.test:8810";
const systemOrigin = "https://loft.test";
type Notice = { title:string; data:{url:string}; close:()=>void };

function worker(origin: string) {
  const notices = new Map<string,Notice>();
  const listeners = new Map<string,(event:Record<string,unknown>)=>void>();
  let badge = 0;
  const self = {
    loftBot: origin === botOrigin, location:{origin}, addEventListener:(kind:string,fn:(e:Record<string,unknown>)=>void) => listeners.set(kind,fn),
    registration:{
      scope:origin+"/", getNotifications: async () => [...notices.values()],
      showNotification: async (title:string,body:{tag:string;data:{url:string}}) => {
        notices.set(body.tag,{title,data:body.data,close:()=>{notices.delete(body.tag);}});
      },
    },
    navigator:{setAppBadge:async (count:number)=>{badge=count;},clearAppBadge:async()=>{badge=0;}},
  };
  vm.runInNewContext(script,{URL,self});
  async function dispatch(kind:string,event:Record<string,unknown>) {
    let running:Promise<void>|undefined;
    listeners.get(kind)!({...event,waitUntil:(promise:Promise<void>)=>{running=promise;}});
    await running;
  }
  return {
    notices, badge:()=>badge,
    push:(tag:string,url:string,purpose = origin === botOrigin ? "bot" : "workbench")=>dispatch("push",{data:{json:()=>({title:tag,body:"通知",tag,url,purpose})}}),
    read:(page:string,data:object)=>dispatch("message",{source:{url:new URL(page, origin).href},data}),
  };
}

test("两个通知注册分别计数；Bot 只清已读消息或点开的失败协作", async () => {
  const bot = worker(botOrigin);
  const workbench = worker(systemOrigin);
  const botRead = {type:"bot-notices-read",threadId:"A",through:6};
  const workbenchRead = {type:"workbench-notices-read"};
  await workbench.push("workbench notice","/#chat");
  await bot.push("a5","/?thread=A&message=5");
  await bot.push("a7","/?thread=A&message=7");
  await bot.push("b1","/?thread=B&message=1");
  await bot.push("task","/?thread=A&delegation=assist");
  assert.equal(bot.badge(),4);
  await bot.read("/",workbenchRead);
  assert.equal(bot.badge(),4);
  await bot.read(systemOrigin,botRead);
  assert.equal(bot.badge(),4);
  await bot.read("/",botRead);
  assert.deepEqual([...bot.notices.keys()],["a7","b1","task"]);
  assert.equal(bot.badge(),3);
  await workbench.read(botOrigin,botRead);
  assert.equal(workbench.badge(),1);
  await workbench.read("/",workbenchRead);
  assert.equal(workbench.badge(),0);
  await bot.read("/",{type:"bot-notices-read",threadId:"A",delegationId:"assist"});
  assert.deepEqual([...bot.notices.keys()],["a7","b1"]);
  await bot.push("private preview","/#workbench", "workbench");
  assert.equal([...bot.notices.values()].some(n=>n.title==="private preview"), false);
  await workbench.push("second workbench", "/");
  await workbench.read(botOrigin, {type:"notifications-disabled"});
  assert.equal(workbench.notices.size, 1);
  await bot.read("/", {type:"notifications-disabled"});
  assert.equal(bot.notices.size, 0);
  await bot.push("before sign-out", "/?thread=C&message=9");
  await bot.read("/", {type:"session-ended"});
  assert.equal(bot.notices.size, 0);
  assert.equal(bot.badge(), 0);
});
