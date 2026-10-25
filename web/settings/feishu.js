import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { S } from "../state.js";
import { confirmDialog, modal } from "../lib/overlay.js";
import { field, markDirty, saveButton, saveConfig } from "./common.js";

/**
 * 设置 → 飞书：机器人、谁能用（配对请求、已配对的人）、指令面板同步，都是飞书这一侧的事，放在一页。
 * 每个机器人一张表单各自保存；存了一个，其它机器人没保存的改动原样留着（表单按机器人缓存，不重建）。
 */
export function feishuTab(cfg, page) {
  /** 已经存进配置的机器人（以服务端为准） + 手动添加、还没保存的 */
  let saved = structuredClone(cfg.feishu.bots);
  let drafts = [];
  const forms = new Map();
  const statusTags = new Map();
  const botsBox = h("div", { class: "settings-stack" });
  const pairBox = h("div", { class: "settings-stack" });
  const slashBox = h("div");

  const refresh = () => {
    saved = structuredClone(cfg.feishu.bots);
    render();
  };
  /** 把 next（整个机器人列表）存下去；成功后以服务端返回的为准 */
  const persist = async (next) => {
    if (!(await saveConfig(cfg, { feishu: { bots: next } }))) return false;
    refresh();
    void loadStatus();
    return true;
  };

  const render = () => {
    const all = [...saved, ...drafts];
    // 已删掉的机器人，表单也扔掉
    const keep = new Set(all.map((b) => b._draft ?? b.id));
    for (const k of forms.keys()) if (!keep.has(k)) forms.delete(k);
    fill(
      botsBox,
      h(
        "div",
        { class: "section" },
        h("h4", {}, "飞书机器人"),
        h("div", { class: "muted" }, "一个机器人可以对应一个 agent，也可以在会话里用 /agent 切换。扫码创建会自动建好飞书应用；Lark 国际版请用「手动添加」，填开发者后台里的 App ID 和 App Secret。"),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn accent", onclick: () => registerBot() }, "扫码创建新机器人"),
          h(
            "button",
            {
              class: "btn",
              onclick: () => {
                drafts.push({ _draft: Symbol("draft"), id: "", name: "新机器人", enabled: true, appId: "", appSecret: "", domain: "feishu", allowFrom: [], agents: ["claude"], defaultAgent: "claude" });
                render();
                botsBox.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              },
            },
            "手动添加",
          ),
        ),
        all.length === 0 ? h("div", { class: "muted" }, "还没有飞书机器人。") : null,
      ),
      all.map((b) => {
        const key = b._draft ?? b.id;
        if (!forms.has(key)) forms.set(key, botSection(b));
        return forms.get(key);
      }),
    );
  };

  const botSection = (b) => {
    const isDraft = !!b._draft;
    const name = h("input", { value: b.name });
    const appId = h("input", { value: b.appId, placeholder: "cli_xxx" });
    const secret = h("input", { value: b.appSecret, placeholder: "App Secret", type: "password", autocomplete: "off" });
    const domain = h("select", {}, h("option", { value: "feishu", selected: b.domain !== "lark" }, "飞书"), h("option", { value: "lark", selected: b.domain === "lark" }, "Lark"));
    const allow = h("textarea", { rows: 2, placeholder: "ou_xxx，一行一个" });
    allow.value = b.allowFrom.join("\n");
    const enabled = h("input", { type: "checkbox", checked: b.enabled });
    const agentChecks = S.agents.map((a) => {
      const box = h("input", { type: "checkbox", checked: b.agents.includes(a.id), value: a.id });
      return { id: a.id, box, el: h("label", { class: "check" }, box, a.label) };
    });
    const def = h("select", {}, S.agents.map((a) => h("option", { value: a.id, selected: a.id === b.defaultAgent }, a.label)));
    const status = h("span", { class: "status-tag" }, b.enabled ? "…" : "未启用");
    if (!isDraft) statusTags.set(b.id, status);
    const collect = () => {
      const { _draft, ...rest } = b;
      return {
        ...rest,
        name: name.value.trim(),
        appId: appId.value.trim(),
        appSecret: secret.value.trim(),
        domain: domain.value,
        allowFrom: allow.value.split(/[\s,]+/).filter(Boolean),
        enabled: enabled.checked,
        agents: agentChecks.filter((c) => c.box.checked).map((c) => c.id),
        defaultAgent: def.value,
      };
    };
    const save = async () => {
      const v = collect();
      if (!v.agents.length) {
        toast("至少勾选一个 agent");
        return false;
      }
      // 只存这一个：其它机器人按服务端现在的样子原样带上，别的草稿不跟着存
      const next = isDraft ? [...saved, v] : saved.map((x) => (x.id === b.id ? v : x));
      if (isDraft) drafts = drafts.filter((d) => d !== b);
      const ok = await persist(next);
      if (!ok && isDraft) drafts.push(b);
      // 存好的机器人表单要换成新的（标题、连接状态）
      if (ok) {
        forms.delete(b._draft ?? b.id);
        render();
      }
      return ok;
    };
    const sec = h(
      "div",
      { class: "section", "data-form": "" },
      h("h4", {}, b.name || "机器人", isDraft ? h("span", { class: "status-tag" }, "未保存") : status, h("span", { class: "grow" }), h("label", { class: "check" }, enabled, "启用")),
      field("名称", name),
      h("div", { class: "row" }, h("div", { style: { flex: 1 } }, field("App ID", appId)), h("div", { style: { flex: 1 } }, field("App Secret", secret))),
      field("域名", domain),
      field("可用的 Agent", h("div", { class: "row" }, agentChecks.map((c) => c.el)), "勾一个 = 一个机器人对应一个 agent；勾多个可在会话里用 /agent 切换"),
      field("默认 Agent", def),
      field("Owner 白名单（open_id）", allow, "陌生人发消息会拿到配对码，在下面「配对请求」里批准即可，不必手填"),
      h(
        "div",
        { class: "row" },
        saveButton(save),
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              const v = collect();
              try {
                const r = await api("/api/feishu/test", { method: "POST", body: { id: b.id, appId: v.appId, appSecret: v.appSecret, domain: v.domain } });
                toast(r.ok ? "✅ 凭据有效" : `❌ ${r.message}`);
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "测试凭据",
        ),
        h("span", { class: "grow" }),
        h(
          "button",
          {
            class: "btn danger",
            onclick: async () => {
              if (isDraft) {
                drafts = drafts.filter((d) => d !== b);
                render();
                return;
              }
              if (!(await confirmDialog({ title: `删除机器人「${b.name}」？`, message: "机器人会立刻停止，飞书那边的应用不会删除。", confirmText: "删除", danger: true }))) return;
              await persist(saved.filter((x) => x.id !== b.id));
            },
          },
          isDraft ? "取消" : "删除",
        ),
      ),
    );
    // 新加的还没存过：一开始就能点保存，离开时也会提醒
    if (isDraft) markDirty(sec);
    return sec;
  };

  const registerBot = async () => {
    const nameInput = h("input", { value: "Agent 助手" });
    const checks = S.agents.filter((a) => a.enabled).map((a) => ({ id: a.id, box: h("input", { type: "checkbox", checked: true }), label: a.label }));
    const body = h(
      "div",
      { class: "modal-body" },
      h("div", { class: "muted" }, "用飞书扫码，会自动创建一个飞书应用（机器人），并把扫码的你设为 owner。"),
      field("机器人名称", nameInput),
      field("可用的 Agent", h("div", { class: "row" }, checks.map((c) => h("label", { class: "check" }, c.box, c.label)))),
    );
    const go = h("button", { class: "btn primary" }, "生成二维码");
    const closeReg = modal({ title: "扫码创建飞书机器人", body, foot: h("div", { class: "modal-foot" }, go) });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const reg = await api("/api/feishu/register", {
          method: "POST",
          body: { name: nameInput.value, agents: checks.filter((c) => c.box.checked).map((c) => c.id) },
        });
        const state = h("div", { class: "muted", style: { textAlign: "center" } }, "等待扫码确认…");
        fill(
          body,
          h("div", { class: "qr", html: reg.qrSvg }),
          h("div", { class: "row", style: { justifyContent: "center" } }, h("a", { href: reg.qrUrl, target: "_blank", rel: "noopener" }, "手机上直接打开链接")),
          state,
        );
        go.remove();
        const poll = async () => {
          if (!body.isConnected) return;
          try {
            const r = await api(`/api/feishu/register/${reg.id}`);
            if (r.status === "pending") return setTimeout(poll, 3000);
            if (r.status === "success") {
              toast("✅ 机器人已创建并启动");
              closeReg();
              const fresh = await api("/api/config");
              Object.assign(cfg, fresh);
              // 顺带刷新侧栏、顶栏里的机器人列表
              await saveConfig(cfg, {});
              refresh();
              void loadStatus();
              void loadPairing();
              return;
            }
            state.textContent = { access_denied: "已拒绝授权", expired: "二维码已过期", timeout: "超时了" }[r.status] ?? `出错：${r.message ?? r.status}`;
          } catch (err) {
            state.textContent = err.message;
          }
        };
        setTimeout(poll, 3000);
      } catch (err) {
        toast(err.message);
        go.disabled = false;
      }
    };
  };

  const loadStatus = () =>
    api("/api/feishu/status")
      .then((list) => {
        for (const s of list) {
          const el = statusTags.get(s.id);
          if (!el) continue;
          el.textContent = { connected: "已连接", connecting: "连接中", reconnecting: "重连中", failed: "连接失败", stopped: "已停止" }[s.state] ?? s.state;
          el.className = `status-tag ${s.state === "connected" ? "ok" : s.state === "failed" ? "bad" : ""}`;
          if (s.error) el.title = s.error;
        }
      })
      .catch(() => {});

  // ---- 配对：陌生人发消息拿到配对码，在这里批准 ----
  const loadPairing = async () => {
    let pairs;
    try {
      pairs = await api("/api/pairing");
    } catch (err) {
      fill(pairBox, h("div", { class: "section" }, h("h4", {}, "配对请求"), h("div", { class: "error-text" }, err.message)));
      return;
    }
    // 没有机器人、也没有配对过的人：这两节用不上
    if (!cfg.feishu.bots.length && !pairs.pending.length && !pairs.approved.length) return fill(pairBox);
    const botName = (id) => S.bots.find((b) => b.id === id)?.name ?? cfg.feishu.bots.find((b) => b.id === id)?.name ?? id;
    /** fn 返回 false = 没做（比如取消了确认），不用重新拉 */
    const act = (btn, fn) => async () => {
      btn.disabled = true;
      try {
        if ((await fn()) !== false) return void loadPairing();
      } catch (err) {
        toast(err.message);
      }
      btn.disabled = false;
    };
    fill(
      pairBox,
      h(
        "div",
        { class: "section" },
        h("h4", {}, "配对请求", pairs.pending.length ? h("span", { class: "status-tag bad" }, `${pairs.pending.length} 个待批准`) : null, h("span", { class: "grow" }), h("button", { class: "btn small", onclick: () => void loadPairing() }, "刷新")),
        h("div", { class: "muted" }, "不在白名单里的人给机器人发消息，会收到一个配对码，同时出现在这里；批准后他就能用这个机器人。每个机器人单独授权。"),
        pairs.pending.length === 0
          ? h("div", { class: "muted" }, "没有待批准的请求。")
          : pairs.pending.map(({ channelId, request }) => {
              const ok = h("button", { class: "btn small accent" }, "批准");
              ok.onclick = act(ok, async () => {
                await api("/api/pairing/approve", { method: "POST", body: { code: request.code } });
                toast("已批准");
              });
              return h(
                "div",
                { class: "list-item" },
                h("div", { class: "grow" }, h("div", { class: "t" }, `${request.code} · ${botName(channelId)}`), h("div", { class: "s" }, `${request.userId} · ${relTime(request.createdAt)}`)),
                ok,
              );
            }),
      ),
      h(
        "div",
        { class: "section" },
        h("h4", {}, `已配对的用户（${pairs.approved.length}）`),
        pairs.approved.length === 0
          ? h("div", { class: "muted" }, "还没有")
          : pairs.approved.map(({ channelId, userId }) => {
              const rm = h("button", { class: "btn small danger" }, "撤销");
              rm.onclick = act(rm, async () => {
                const sure = await confirmDialog({ title: "撤销配对？", message: `${userId} 之后再给「${botName(channelId)}」发消息，要重新配对。`, confirmText: "撤销", danger: true });
                if (!sure) return false;
                await api("/api/pairing/revoke", { method: "POST", body: { channelId, userId } });
              });
              return h("div", { class: "list-item" }, h("div", { class: "grow" }, h("div", { class: "t" }, userId), h("div", { class: "s" }, botName(channelId))), rm);
            }),
      ),
    );
  };

  // ---- 指令面板：飞书输入框打「/」看到的指令，由「命令」页的设置同步过去 ----
  let slashTimer = null;
  const describeSlash = (st) => {
    if (st.state === "syncing") return "同步中…（重建时每条间隔 1 秒，命令多要一两分钟）";
    if (st.state === "error") return `同步失败：${st.error}`;
    if (st.state === "done") {
      const when = new Date(st.at).toLocaleTimeString();
      const skipped = st.skipped?.length
        ? `；${st.skipped.length} 个名字不符合飞书规则（只能小写字母、数字、- _，最长 32）没注册：${st.skipped.slice(0, 8).join("、")}${st.skipped.length > 8 ? " 等" : ""}`
        : "";
      return `${when} ${st.changed ? "已同步" : "已是最新"}，共 ${st.registered} 条${skipped}。飞书端约 5～8 分钟后生效。`;
    }
    return "等待首次同步";
  };
  const loadSlash = async () => {
    if (!cfg.feishu.bots.length) return fill(slashBox);
    const list = h("div", {}, h("span", { class: "spinner" }));
    const syncBtn = h("button", { class: "btn small" }, "立即同步");
    syncBtn.onclick = async () => {
      try {
        await api("/api/feishu/slash/sync", { method: "POST" });
        setTimeout(() => void loadSlash(), 500);
      } catch (err) {
        toast(err.message);
      }
    };
    fill(
      slashBox,
      h(
        "div",
        { class: "section" },
        h("h4", {}, "指令面板", h("span", { class: "grow" }), syncBtn),
        h("div", { class: "muted" }, "飞书输入框打「/」看到的指令，内容和顺序跟着 Agent →「命令」里的设置走。面板是每个机器人一份：默认 agent 的命令在前，其它 agent 的命令接在后面。启动时、保存命令设置后、以及每 6 小时会自动同步。"),
        list,
      ),
    );
    let data;
    try {
      data = await api("/api/feishu/slash");
    } catch (err) {
      fill(list, h("div", { class: "error-text" }, err.message));
      return;
    }
    fill(
      list,
      data.bots.length === 0
        ? h("div", { class: "muted" }, "没有运行中的飞书机器人。")
        : data.bots.map((b) => h("div", { class: `muted${b.status.state === "error" ? " error-text" : ""}` }, h("b", {}, b.name), "：", describeSlash(b.status))),
    );
    clearTimeout(slashTimer);
    slashTimer = data.bots.some((b) => b.status.state === "syncing") ? setTimeout(() => slashBox.isConnected && void loadSlash(), 2000) : null;
  };

  page.append(botsBox, pairBox, slashBox);
  render();
  void loadStatus();
  void loadPairing();
  void loadSlash();
}
