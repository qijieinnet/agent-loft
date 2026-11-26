import { api, button, field, h, requestId } from "./client.js";
import { action, currentPanel, divider, note, panel, panelError, run } from "./panel.js";

const stages = { open: "跟进中", waiting: "等确认", closed: "已完成" };

export async function openMyDecisions(onSelect) {
  const active = currentPanel();
  const { items } = await api("/api/bots/followups/pending");
  if (!active()) return;
  panel("待我确认", !items.length && note("目前没有需要你确认的事。"), ...items.map(item => {
    const row = action(item.title, () => onSelect(item.threadId, item.id));
    row.append(h("small", {}, [item.botName, item.scope === "shared" ? "成员共享" : "仅你可见",
      item.decisionExpired ? "需重新发起" : "待确认"].join(" · ")));
    return row;
  }));
}

export async function openFollowups({ threadId, members, onChange, startNew = false, initialId }) {
  const path = "/api/bots/threads/" + encodeURIComponent(threadId) + "/followups";
  async function list() {
    const { followups } = await api(path);
    const rows = followups.map((item) => {
      const row = button(item.title, () => detail(item));
      row.append(h("small", {}, stages[item.status]));
      return row;
    });
    panel("跟进的事", ...rows, !rows.length && note("这里会留下进展，之后还能接着处理。"), button("新建跟进", create, "primary"));
  }
  function create() {
    const title = h("input", { id: "follow-title", required: true, maxlength: "120" });
    const save = h("button", { type: "submit", class: "primary" }, "开始跟进");
    const id = requestId();
    panel(
      "想跟进什么？",
      h(
        "form",
        {
          class: "sheet-form",
          onsubmit: (e) => {
            e.preventDefault();
            run(save, async () => {
              const { followup } = await api(path, "POST", { title: title.value, requestId: id });
              onChange?.();
              detail(followup);
            });
          },
        },
        field("事情名称", title),
        save,
      ),
    );
  }
  function detail(item) {
    const itemPath = path + "/" + encodeURIComponent(item.id);
    const mutate = async (kind, values = {}, id = requestId()) => {
      try {
        const response = await api(itemPath + "/actions", "POST", { kind, requestId: id, revision: item.revision, ...values });
        onChange?.();
        detail(response.followup);
      } catch (err) {
        if (err.status === 409) {
          await list();
          panelError(err.message);
          return;
        }
        throw err;
      }
    };
    const controls = [];
    if (item.status !== "closed") {
      controls.push(button("补充进展", () => edit("补充进展", "note")));
      if (item.canDecide) {
        controls.push(
          action("同意", () => mutate("approve"), "primary"),
          action("不同意", () => mutate("decline"), "secondary"),
        );
      }
      if (item.canManage) {
        if (item.needsAssignee || members.length > 1) {
          const label = item.needsAssignee ? "重新指定负责人" : "交给成员跟进";
          controls.push(button(label, () => edit(label, "assign")));
        }
        if (item.status !== "waiting" || item.decisionExpired) {
          const label = item.decisionExpired ? "重新发起确认" : "请人确认";
          controls.push(button(label, () => edit(label, "ask")));
        }
        if (item.status !== "waiting") controls.push(action("标记完成", () => mutate("close")));
      }
    } else if (item.canManage) {
      controls.push(action("继续跟进", () => mutate("resume")));
    }
    panel(
      item.title,
      note(stages[item.status] + (item.assigneeName ? " · " + item.assigneeName : "")),
      item.question && h("strong", {}, item.question),
      item.status === "waiting" && note(item.decisionExpired
        ? "上一次确认已过期。请核对最新进展，再重新发起确认。"
        : "请在 " + new Date(item.decisionExpiresAt).toLocaleString() + " 前决定。"),
      item.latest && h("p", {}, item.latest),
      ...controls,
      action("查看进展记录", async () => {
        const { events, followup } = await api(itemPath);
        const history = events.map((event) => h("li", {}, note(new Date(event.at).toLocaleString()), event.text));
        panel(
          "进展记录",
          h("ol", {}, ...history),
          button("返回", () => detail(followup), "secondary"),
        );
      }),
      item.canConnect && item.status !== "closed" && button("连接状态来源", () => connection(itemPath, () => detail(item))),
      divider(),
      action("查看全部", list),
    );
    function edit(label, kind) {
      const input = h("textarea", {
        id: "progress-note",
        rows: 3,
        maxlength: "500",
        required: kind !== "assign",
      });
      if (item.decisionExpired && kind === "ask") input.value = item.question || "";
      const select = h("select", { id: "progress-member" }, ...members.map((m) => h("option", { value: m.id }, m.name)));
      if (members.some(member => member.id === item.assigneeId)) select.value = item.assigneeId;
      const submit = h("button", { type: "submit", class: "primary" }, label);
      const id = requestId();
      panel(
        label,
        h(
          "form",
          {
            class: "sheet-form",
            onsubmit: (e) => {
              e.preventDefault();
              const values = input.value.trim() ? { text: input.value.trim() } : {};
              if (kind !== "note") values.assigneeId = select.value;
              run(submit, () => mutate(kind, values, id));
            },
          },
          kind !== "note" && field(kind === "ask" ? "谁来确认" : "负责人", select),
          field(kind === "ask" ? "需要确认什么" : "说明", input),
          submit,
        ),
        button("返回", () => detail(item), "secondary"),
      );
    }
  }
  function connection(itemPath, back) {
    const hook = itemPath + "/hook";
    const create = action("生成接收凭据", async () => {
      const { url, token } = await api(hook, "POST", {});
      const endpoint = h("input", { id: "source-url", readOnly: true, value: new URL(url, location.origin).href });
      const credential = h("input", { id: "source-token", readOnly: true, type: "password", value: token });
      panel(
        "连接状态来源",
        field("接收地址", endpoint),
        field("访问令牌", credential),
        button("显示或隐藏令牌", () => {
          credential.type = credential.type === "password" ? "text" : "password";
        }),
        note("由数据来源向此地址 POST 状态。每次变化只记一条进展，令牌仅在这里显示一次。"),
        button("完成", back, "primary"),
      );
    });
    panel(
      "连接状态来源",
      note("适用于备份等能主动上报状态的服务。生成新凭据后，之前的令牌会失效。"),
      create,
      action("断开来源", async () => {
        await api(hook, "DELETE");
        back();
      }),
      button("返回", back, "secondary"),
    );
  }
  if (startNew) return create();
  if (initialId) {
    const active = currentPanel();
    const { followup } = await api(path + "/" + encodeURIComponent(initialId));
    if (active()) detail(followup);
    return;
  }
  await list();
}
