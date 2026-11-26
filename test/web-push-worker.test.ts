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
    location:{origin}, addEventListener:(kind:string,fn:(e:Record<string,unknown>)=>void) => listeners.set(kind,fn),
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
    push:(tag:string,url:string,purpose = "workbench")=>dispatch("push",{data:{json:()=>({title:tag,body:"通知",tag,url,purpose})}}),
    read:(page:string,data:object)=>dispatch("message",{source:{url:new URL(page, origin).href},data}),
  };
}

test("工作台保留通知和角标，旧 Bot 推送不展示正文或跳转地址", async () => {
  const workbench = worker(systemOrigin);
  await workbench.push("workbench notice", "/#chat");
  assert.equal(workbench.badge(), 1);
  assert.equal(workbench.notices.get("workbench notice")?.data.url, systemOrigin + "/#chat");
  await workbench.push("private Bot preview", "/?thread=A&message=5", "bot");
  assert.equal([...workbench.notices.values()].some(n => n.title === "private Bot preview"), false);
  assert.equal(workbench.notices.get("subscription-updated")?.data.url, "/");
  await workbench.read(botOrigin, { type:"notifications-disabled" });
  assert.equal(workbench.badge(), 2);
  await workbench.read("/", { type:"workbench-notices-read" });
  assert.equal(workbench.badge(), 0);
  await workbench.push("before sign-out", "/");
  await workbench.read("/", { type:"session-ended" });
  assert.equal(workbench.badge(), 0);
});
