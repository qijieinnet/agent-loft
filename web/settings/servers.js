import { fill, h, icon, toast } from "../lib/dom.js";
import { canFrame, openForAuth } from "../lib/shell.js";
import { field, markDirty, saveButton, saveConfig } from "./common.js";

// ---------- 设置 → 服务器 ----------
// 左上角切换到别的 agent-loft（lib/shell.js、服务端 core/servers.ts）。两件事：
//   - 这台能切到哪几台（这台当外壳）；
//   - 允许哪些地址把这台嵌进去（这台被别人切过来）。

const HINT =
  "在左上角切换到别的 agent-loft，像 Codex 桌面端切换「Codex」和「ChatGPT」那样。别的服务器的页面原样嵌在这里，各自登录、直接连它自己的服务端，这台不中转。" +
  "几台要在同一个主域名下（比如 mac.example.com、nas.example.com），都要用 HTTPS；对方还要允许这台嵌入：加好后点「授权」，在打开的页面里确认。";

export function serversTab(cfg, panel) {
  fill(panel, listSection(cfg), embeddersSection(cfg));
}

/** 这台能切到哪几台 */
function listSection(cfg) {
  const box = h("div", { class: "section", "data-form": "" });
  const selfIcon = h("input", { class: "srv-emoji", value: cfg.servers.selfIcon, placeholder: "🖥️", maxlength: 16 });
  const selfName = h("input", { value: cfg.servers.selfName, placeholder: "空着用主机名" });
  const rows = h("div", { class: "srv-rows" });
  let list = cfg.servers.list.map((s) => ({ ...s }));

  const render = () => {
    fill(
      rows,
      list.length === 0
        ? h("div", { class: "muted" }, "还没有加别的服务器")
        : list.map((s, i) => {
            let saved = cfg.servers.list.find((x) => x.id === s.id && x.url === s.url);
            const authorize = h("button", {
              class: "btn small",
              disabled: !saved,
              title: saved ? "在新标签页打开那台，允许这台嵌入" : "先保存",
              onclick: () => saved && openForAuth(saved),
            }, "授权");
            const em = h("input", { class: "srv-emoji", value: s.icon, placeholder: "🗄️", maxlength: 16, oninput: () => (s.icon = em.value) });
            const name = h("input", { value: s.name, placeholder: "名称", oninput: () => (s.name = name.value) });
            const url = h("input", {
              value: s.url,
              placeholder: "https://nas.example.com",
              autocapitalize: "off",
              spellcheck: "false",
              oninput: () => {
                s.url = url.value;
                saved = cfg.servers.list.find((x) => x.id === s.id && x.url === s.url);
                authorize.disabled = !saved;
                authorize.title = saved ? "在新标签页打开那台，允许这台嵌入" : "先保存";
              },
            });
            const move = (d) => () => {
              [list[i], list[i + d]] = [list[i + d], list[i]];
              markDirty(box);
              render();
            };
            return h(
              "div",
              { class: "srv-edit" },
              h("div", { class: "srv-edit-fields" }, em, name, url),
              h(
                "div",
                { class: "srv-edit-actions" },
                h("button", { class: "btn small", disabled: i === 0, title: "上移", onclick: move(-1) }, "↑"),
                h("button", { class: "btn small", disabled: i === list.length - 1, title: "下移", onclick: move(1) }, "↓"),
                // 没保存的地址先别去授权：那边确认后会通知这边重新加载，这边得已经有它
                authorize,
                h(
                  "button",
                  {
                    class: "icon-btn",
                    title: "移除",
                    onclick: () => {
                      list.splice(i, 1);
                      markDirty(box);
                      render();
                    },
                  },
                  icon("trash"),
                ),
              ),
            );
          }),
    );
  };
  render();

  const add = h(
    "button",
    {
      class: "btn",
      onclick: () => {
        list.push({ id: "", name: "", icon: "", url: "" });
        markDirty(box);
        render();
        rows.querySelectorAll(".srv-edit-fields input:nth-child(3)")[list.length - 1]?.focus();
      },
    },
    icon("plus"),
    "添加服务器",
  );

  const save = async () => {
    const clean = list.filter((s) => s.url.trim() || s.name.trim());
    if (clean.some((s) => !s.url.trim())) {
      toast("有一台没填地址");
      return false;
    }
    const ok = await saveConfig(cfg, { servers: { selfName: selfName.value, selfIcon: selfIcon.value, list: clean } });
    if (!ok) return false;
    // 新加的地址要刷新页面才嵌得进来（页面的 CSP 是加载时按旧列表出的）
    if (cfg.servers.list.some((s) => !canFrame(s.url))) {
      toast("已保存，刷新页面后生效…");
      setTimeout(() => location.reload(), 900);
    }
    box.replaceWith(listSection(cfg));
    return true;
  };

  fill(
    box,
    h("h4", {}, "切换服务器"),
    h("div", { class: "muted" }, HINT),
    field("这台", h("div", { class: "srv-edit-fields self" }, selfIcon, selfName), "左上角列表里这台的图标（一个 emoji）和名字"),
    h("div", { class: "field" }, h("span", {}, "其他服务器"), rows),
    h("div", { class: "row" }, add, saveButton(save)),
  );
  return box;
}

/** 允许哪些地址把这台嵌进去 */
function embeddersSection(cfg) {
  const box = h("div", { class: "section", "data-form": "" });
  let list = [...cfg.servers.embedders];
  const rows = h("div", {});
  const input = h("input", { class: "input grow", placeholder: "https://loft.example.com", autocapitalize: "off", spellcheck: "false" });

  const render = () => {
    fill(
      rows,
      list.length === 0
        ? h("div", { class: "muted" }, "还没有")
        : list.map((origin, i) =>
            h(
              "div",
              { class: "list-item" },
              h("div", { class: "grow" }, h("div", { class: "t" }, origin)),
              h(
                "button",
                {
                  class: "btn small",
                  onclick: () => {
                    list.splice(i, 1);
                    markDirty(box);
                    render();
                  },
                },
                "移除",
              ),
            ),
          ),
    );
  };
  render();

  const addOne = () => {
    const v = input.value.trim();
    if (!v) return;
    let origin;
    try {
      origin = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).origin;
    } catch {
      toast("地址不对");
      return;
    }
    if (!list.includes(origin)) list.push(origin);
    input.value = "";
    markDirty(box);
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addOne();
    }
  });

  const save = async () => {
    const ok = await saveConfig(cfg, { servers: { embedders: list } });
    if (ok) box.replaceWith(embeddersSection(cfg));
    return ok;
  };

  fill(
    box,
    h("h4", {}, "允许被嵌入"),
    h(
      "div",
      { class: "muted" },
      `别的 agent-loft 要在左上角切到这台，得先允许它嵌入这台的页面。一般不用手填：在那边加上这台（${location.origin}）后点「授权」，在打开的页面里确认就行。切过来时照样要登录这台的账号。`,
    ),
    rows,
    h("div", { class: "row" }, input, h("button", { class: "btn", onclick: addOne }, "添加"), saveButton(save)),
  );
  return box;
}
