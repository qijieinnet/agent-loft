import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { isAdmin, S } from "../state.js";
import { dropPushSub } from "../lib/push.js";
import { field } from "./common.js";
import { feishuLinkSection } from "./memory.js";

export async function authTab(panel) {
  const [pairs, allowlist] = await Promise.all([api("/api/pairing"), api("/api/claude/allowlist")]);
  const botName = (id) => S.bots.find((b) => b.id === id)?.name ?? id;
  const allowText = h("textarea", { rows: 8 });
  allowText.value = allowlist.join("\n");
  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "待批准的配对"),
      pairs.pending.length === 0
        ? h("div", { class: "muted" }, "没有待批准的请求。陌生人给机器人发消息时会出现在这里。")
        : pairs.pending.map(({ channelId, request }) =>
            h(
              "div",
              { class: "list-item" },
              h("div", { class: "grow" }, h("div", { class: "t" }, `${request.code} · ${botName(channelId)}`), h("div", { class: "s" }, `${request.userId} · ${relTime(request.createdAt)}`)),
              h(
                "button",
                {
                  class: "btn small accent",
                  onclick: async () => {
                    try {
                      await api("/api/pairing/approve", { method: "POST", body: { code: request.code } });
                      toast("已批准");
                      fill(panel, );
                      void authTab(panel);
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                },
                "批准",
              ),
            ),
          ),
    ),
    h(
      "div",
      { class: "section" },
      h("h4", {}, "已配对的用户"),
      pairs.approved.length === 0
        ? h("div", { class: "muted" }, "无")
        : pairs.approved.map(({ channelId, userId }) =>
            h(
              "div",
              { class: "list-item" },
              h("div", { class: "grow" }, h("div", { class: "t" }, userId), h("div", { class: "s" }, botName(channelId))),
              h(
                "button",
                {
                  class: "btn small danger",
                  onclick: async () => {
                    await api("/api/pairing/revoke", { method: "POST", body: { channelId, userId } });
                    fill(panel, );
                    void authTab(panel);
                  },
                },
                "撤销",
              ),
            ),
          ),
    ),
    h(
      "div",
      { class: "section" },
      h("h4", {}, "Claude「总是允许」名单"),
      h("div", { class: "muted" }, "点过「总是允许」的会记在这里。Bash:git 表示 git 开头的命令都放行；Edit:/路径 表示该目录下的修改都放行。一行一条，删掉即撤销。"),
      allowText,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              await api("/api/claude/allowlist", { method: "PUT", body: { list: allowText.value.split("\n") } });
              toast("已保存");
            },
          },
          "保存",
        ),
      ),
    ),
  );
}

export async function securityTab(panel) {
  const old = h("input", { type: "password", autocomplete: "current-password" });
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const sessions = await api("/api/web-sessions");
  // 管理员看到的是所有人的设备：不止一个人时标上是谁的
  const owners = new Set(sessions.map((s) => s.userId));
  const showOwner = isAdmin() && owners.size > 1;
  panel.append(
    S.user
      ? h(
          "div",
          { class: "section" },
          h("h4", {}, "当前账号"),
          h("div", {}, S.user.name, " ", h("span", { class: "status-tag" }, S.user.role === "admin" ? "管理员" : "成员")),
        )
      : null,
    h(
      "div",
      { class: "section" },
      h("h4", {}, "修改登录密码"),
      field("原密码", old),
      field("新密码（至少 8 位）", pw),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              try {
                await api("/api/password", { method: "POST", body: { old: old.value, password: pw.value } });
                toast("密码已修改，你的其它设备已下线");
                old.value = pw.value = "";
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "修改",
        ),
      ),
    ),
    feishuLinkSection(),
    h(
      "div",
      { class: "section" },
      h("h4", {}, showOwner ? "已登录的设备（所有用户）" : "已登录的设备"),
      sessions.map((s) =>
        h(
          "div",
          { class: "list-item" },
          h(
            "div",
            { class: "grow" },
            h("div", { class: "t" }, s.userAgent.slice(0, 80) || "未知设备"),
            h("div", { class: "s" }, `${showOwner ? `${s.userName ?? "已删除的用户"} · ` : ""}${s.ip} · 最近活动 ${relTime(s.lastSeen)}`),
          ),
          h(
            "button",
            {
              class: "btn small danger",
              onclick: async () => {
                await api("/api/web-sessions/revoke", { method: "POST", body: { id: s.id } });
                fill(panel, );
                void securityTab(panel);
              },
            },
            "下线",
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn danger",
          onclick: async () => {
            // 退出了就别再收这个账号的通知：换个人在这台设备上登录，不能收到上一个人的
            await dropPushSub().catch(() => {});
            await api("/api/logout", { method: "POST" });
            location.reload();
          },
        },
        "退出登录",
      ),
    ),
  );
}
