import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { copyText } from "../lib/markdown.js";
import { isAdmin, S } from "../state.js";
import { dropPushSub } from "../lib/push.js";
import { field, saveButton } from "./common.js";

/** 设置 → 账号：我是谁、改密码、绑定飞书、我登录着的设备。别人的设备在 管理 →「用户」里 */
export async function accountTab(page) {
  const logout = h("button", { class: "btn small danger" }, "退出登录");
  logout.onclick = async () => {
    logout.disabled = true;
    // 退出了就别再收这个账号的通知：换个人在这台设备上登录，不能收到上一个人的
    try {
      await dropPushSub();
      await api("/api/logout", { method: "POST" });
      location.reload();
    } catch (err) {
      toast(err.message);
      logout.disabled = false;
    }
  };
  const old = h("input", { type: "password", autocomplete: "current-password" });
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const name = h("input", { value: S.user?.name ?? "", autocomplete: "username", autocapitalize: "off", spellcheck: "false", maxlength: "32" });
  const currentName = h("span", {}, S.user?.name ?? "");
  const devicesBox = h("div", { class: "section" }, h("h4", {}, "已登录的设备"), h("span", { class: "spinner" }));
  page.append(
    h(
      "div",
      { class: "section", "data-form": "" },
      h(
        "h4",
        {},
        "当前账号",
        h("span", { class: "grow" }),
        logout,
      ),
      S.user ? h("div", {}, currentName, " ", h("span", { class: "status-tag" }, S.user.role === "admin" ? "管理员" : "成员")) : null,
      field("账号名称", name, "也是登录时使用的用户名。1～32 个字符，可用文字、数字和 _ . @ -；修改后请用新名称登录。"),
      h("div", { class: "row" }, saveButton(async () => {
        const data = await api("/api/account", { method: "PATCH", body: { name: name.value.trim() } });
        S.user = data.user;
        name.value = currentName.textContent = data.user.name;
        toast("账号名称已修改");
      }, "保存账号名称")),
    ),
    h(
      "div",
      { class: "section", "data-form": "" },
      h("h4", {}, "修改登录密码"),
      field("原密码", old),
      field("新密码（至少 8 位）", pw),
      h(
        "div",
        { class: "row" },
        saveButton(async () => {
          await api("/api/password", { method: "POST", body: { old: old.value, password: pw.value } });
          toast("密码已修改，你的其它设备已下线");
          old.value = pw.value = "";
          void loadDevices();
        }, "修改"),
      ),
    ),
    feishuLinkSection(),
    devicesBox,
  );
  const loadDevices = async () => {
    let sessions;
    try {
      sessions = await api("/api/web-sessions");
    } catch (err) {
      fill(devicesBox, h("h4", {}, "已登录的设备"), h("div", { class: "error-text" }, err.message));
      return;
    }
    // 管理员拿到的是所有人的：这里只放自己的（以前单用户时登录的设备没有主人，也算管理员自己的）
    const mine = isAdmin() && S.user ? sessions.filter((s) => !s.userId || s.userId === S.user.id) : sessions;
    fill(devicesBox, h("h4", {}, `已登录的设备（${mine.length}）`), deviceList(mine, { onChange: loadDevices }));
  };
  await loadDevices();
}

/** 登录设备列表，每台一个「下线」。showOwner：标上是谁的（管理员看所有人时） */
export function deviceList(sessions, { showOwner = false, onChange }) {
  if (!sessions.length) return h("div", { class: "muted" }, "没有");
  return sessions
    .slice()
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((s) => {
      const off = h("button", { class: "btn small danger" }, "下线");
      off.onclick = async () => {
        off.disabled = true;
        try {
          await api("/api/web-sessions/revoke", { method: "POST", body: { id: s.id } });
          toast("已下线");
          onChange();
        } catch (err) {
          toast(err.message);
          off.disabled = false;
        }
      };
      return h(
        "div",
        { class: "list-item" },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "t" }, s.userAgent.slice(0, 80) || "未知设备"),
          h("div", { class: "s" }, `${showOwner ? `${s.userName ?? "已删除的用户"} · ` : ""}${s.ip} · 最近活动 ${relTime(s.lastSeen)}`),
        ),
        off,
      );
    });
}

/** 「账号」页里的飞书绑定：Web 上生成绑定码，再在飞书私聊里发 /bind，两边都证明是本人 */
function feishuLinkSection() {
  const box = h("div", { class: "section" });
  const load = async () => {
    let data;
    try {
      data = await api("/api/account/feishu");
    } catch (err) {
      fill(box, h("h4", {}, "飞书账号"), h("div", { class: "error-text" }, err.message));
      return;
    }
    // 没有飞书机器人、也没绑过：整节不显示
    box.hidden = !data.bots.length && !data.links.length;
    if (box.hidden) return fill(box);
    const codeBox = h("div");
    const gen = h("button", { class: "btn" }, data.links.length ? "再绑一个" : "生成绑定码");
    gen.onclick = async () => {
      gen.disabled = true;
      try {
        const { code, expiresAt } = await api("/api/account/feishu/code", { method: "POST" });
        const cmd = `/bind ${code}`;
        const copy = h("button", { class: "btn small" }, "复制");
        copy.onclick = () => copyText(cmd, copy);
        fill(
          codeBox,
          h(
            "div",
            { class: "list-item" },
            h(
              "div",
              { class: "grow" },
              h("div", { class: "t" }, h("code", {}, cmd)),
              h("div", { class: "s" }, `在飞书里私聊机器人（${data.bots.map((b) => b.name).join("、") || "飞书机器人"}）发这条消息，${Math.round((expiresAt - Date.now()) / 60000)} 分钟内有效。没用过机器人的话，要先让管理员批准你的配对码。`),
            ),
            copy,
          ),
        );
      } catch (err) {
        toast(err.message);
      }
      gen.disabled = false;
    };
    fill(
      box,
      h("h4", {}, "飞书账号"),
      h("div", { class: "muted" }, "绑定后，你和飞书机器人的私聊就是你的个人会话：用你的记忆，/sessions 只列你的会话，/web 能接上你自己的 Web 会话。群聊不受影响。"),
      data.links.map((l) => {
        const rm = h("button", { class: "btn small danger" }, "解除绑定");
        rm.onclick = async () => {
          rm.disabled = true;
          try {
            await api("/api/account/feishu", { method: "DELETE", body: { botId: l.botId, openId: l.openId } });
            toast("已解除，那个私聊不再用你的记忆");
            void load();
          } catch (err) {
            toast(err.message);
            rm.disabled = false;
          }
        };
        return h(
          "div",
          { class: "list-item" },
          h("div", { class: "grow" }, h("div", { class: "t" }, l.botName), h("div", { class: "s" }, `${l.openIdShort} · 绑定于 ${relTime(l.boundAt)}`)),
          rm,
        );
      }),
      h("div", { class: "row" }, gen),
      codeBox,
    );
  };
  void load();
  return box;
}
