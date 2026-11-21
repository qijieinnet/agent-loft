import { h, toast } from "../lib/dom.js";
import { modal } from "../lib/overlay.js";
import { api } from "../lib/api.js";
import { memoAccessSelect } from "../lib/memo-access.js";

function memoAccessField() {
  const select = memoAccessSelect("智能体访问", "off");
  select.name = "access";
  const hint = h("small", {}, "授权后，Agent Loft 会在服务器建立本库的全文索引。");
  const update = () => { hint.hidden = select.value === "off"; };
  select.addEventListener("change", update);
  update();
  return { select, field: h("label", {}, "智能体访问", select, hint) };
}

export async function memoAccessSettings(source) {
  const url = action => "/api/memos/" + action + "?" + new URLSearchParams({ source: source.id });
  Object.assign(source, await api(url("access")));
  const select = memoAccessSelect("默认权限", source.access ?? "off");
  const status = h("p", { role: "status" });
  const refresh = h("button", { class: "btn", type: "button" }, "立即刷新索引");
  const save = h("button", { class: "btn primary", type: "submit" }, "保存权限");
  const form = h("form", { class: "modal-body memo-fields" },
    h("label", {}, "默认权限", select),
    h("small", {}, "专家默认沿用此权限。可在「设置 → 专家」中为指定专家单独设置。"),
    h("small", {}, "授权后会建立全文索引。在专家对话里直接说「帮我搜笔记」或「把这段记到笔记里」即可。"),
    status, refresh, save);
  let timer, sequence = 0;
  async function load(method = "GET") {
    clearTimeout(timer);
    const request = ++sequence;
    refresh.hidden = ![source.access, ...Object.values(source.expertAccess ?? {})].some(a => a === "read" || a === "write");
    if (refresh.hidden) { status.textContent = ""; return; }
    try {
      const index = await api(url("index"), { method });
      if (!form.isConnected || sequence !== request) return;
      const last = index.success ? "最近成功：" + new Date(index.success).toLocaleString() : "首次索引尚未完成";
      status.textContent = [index.running ? "正在扫描，已检查 " + index.scanned + " 份文本" : "", index.error, last].filter(Boolean).join(" · ");
      refresh.disabled = index.running;
      if (index.running) timer = setTimeout(load, 1500);
    } catch (err) { if (sequence === request) status.textContent = err.message; }
  }
  modal({ title: source.name + " · 智能体访问", body: form, beforeClose: () => { if (save.disabled) return false; clearTimeout(timer); ++sequence; } });
  refresh.onclick = () => void load("POST");
  form.onsubmit = async e => {
    e.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      Object.assign(source, await api(url("access"), { method: "PUT", body: { access: select.value, defaultOnly: true } }));
      await load();
    } catch (err) { status.textContent = err.message; }
    finally { save.disabled = false; }
  };
  void load();
}

export async function shareMemoSource(source) {
  const url = "/api/memos/sharing?" + new URLSearchParams({ source: source.id });
  const members = await api(url);
  const fields = members.map(member => {
    const select = memoAccessSelect(member.name, member.access);
    if (member.disabled) for (const option of select.options) option.disabled = option.value !== "off" && option.value !== member.access;
    return { member, select };
  });
  const error = h("div", { class: "memo-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit", disabled: !fields.length }, "保存共享");
  const form = h("form", { class: "modal-body memo-fields" },
    h("small", {}, "成员可在自己的备忘录里打开整个笔记库，包括文件和版本历史。共享给成员不会同时授权给对方的专家。"),
    fields.length ? fields.map(({ member, select }) => h("label", { class: "memo-expert-access" },
      member.name + (member.disabled ? "（已停用）" : ""), select)) : h("p", {}, "还没有其他可共享的账号。"), error, save);
  let saving = false;
  const close = modal({ title: source.name + " · 共享给成员", body: form, beforeClose: () => !saving });
  form.onsubmit = async e => {
    e.preventDefault();
    if (saving) return;
    saving = save.disabled = true;
    try {
      const changes = Object.fromEntries(fields.filter(({ member, select }) => member.access !== select.value)
        .map(({ member, select }) => [member.id, select.value]));
      await api(url, { method: "PUT", body: { changes } });
      close();
      toast("共享设置已保存");
    } catch (err) { error.textContent = err.message; }
    finally { saving = save.disabled = false; }
  };
}

export function connectSource(onConnect) {
  const kind = h("select", { class: "input" }, h("option", { value: "webdav" }, "WebDAV"), h("option", { value: "s3" }, "S3 / 兼容存储"));
  const input = (name, placeholder = "", type = "text") => h("input", { class: "input", name, placeholder, type, autocomplete: "off" });
  const name = input("name", "我的笔记"), endpoint = input("endpoint", "https://nas.example.com/dav/Notes/", "url");
  const username = input("username"), secret = input("secret", "", "password");
  const bucket = input("bucket"), region = input("region", "us-east-1"), prefix = input("prefix", "可选，如 Notes");
  const label = (caption, field) => h("label", {}, caption, field);
  const userLabel = h("span"), secretLabel = h("span");
  const s3 = h("div", { class: "memo-fields" }, label("存储桶", bucket), label("区域", region), label("目录前缀", prefix));
  const configure = () => {
    const aws = kind.value === "s3";
    s3.hidden = !aws;
    bucket.required = username.required = secret.required = aws;
    endpoint.required = !aws;
    endpoint.placeholder = aws ? "兼容存储填写端点，AWS 可留空" : "https://nas.example.com/dav/Notes/";
    userLabel.textContent = aws ? "Access Key ID" : "用户名";
    secretLabel.textContent = aws ? "Secret Access Key" : "密码 / 应用专用密码";
  };
  configure();
  kind.onchange = configure;
  name.required = true;
  const error = h("div", { class: "memo-error", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "连接笔记库");
  const form = h("form", { class: "modal-body memo-fields" }, label("名称", name), label("数据源", kind), label("服务地址", endpoint), s3, label(userLabel, username), label(secretLabel, secret), memoAccessField().field, error, submit);
  const close = modal({ title: "连接笔记库", body: form, beforeClose: () => !submit.disabled });
  form.onsubmit = async e => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = "正在验证连接…";
    error.textContent = "";
    try {
      const source = await api("/api/memos/sources", { method: "POST", body: {
        ...Object.fromEntries(new FormData(form)), kind: kind.value,
      } });
      close();
      await onConnect(source);
    } catch (err) { error.textContent = err.message; }
    finally { submit.disabled = false; submit.textContent = "连接笔记库"; }
  };
  name.focus();
}

export function confirmDisconnect(source) {
  return new Promise(resolve => {
    const input = h("input", { class: "input", autocomplete: "off", spellcheck: "false" });
    const submit = h("button", { type: "submit", class: "btn danger-fill", disabled: true }, "断开连接");
    const cancel = h("button", { type: "button", class: "btn ghost", onclick: () => finish(false) }, "取消");
    const form = h("form", { class: "modal-body memo-fields" },
      h("p", {}, "断开会移除连接配置，并撤回此库的成员共享和智能体访问权限。远端文件和本地版本历史会保留。"),
      h("label", {}, "输入库名「" + source.name + "」确认", input),
      h("div", { class: "memo-dialog-actions" }, cancel, submit));
    const close = modal({ title: "断开笔记库", body: form, beforeClose: () => resolve(false) });
    function finish(result) { close(); resolve(result); }
    input.oninput = () => { submit.disabled = input.value !== source.name; };
    form.onsubmit = e => { e.preventDefault(); if (input.value === source.name) finish(true); };
    form.onkeydown = e => { if (e.key === "Escape") finish(false); };
    input.focus();
  });
}

export function askMemoName(title, initial, directory) {
  return new Promise(resolve => {
    const input = h("input", { class: "input", required: true, value: initial, "aria-label": "名称" });
    const form = h("form", { class: "modal-body memo-fields" },
      h("label", {}, "位置", h("span", { class: "memo-path" }, "/" + directory)),
      h("label", {}, "名称", input), h("button", { class: "btn primary" }, "确定"));
    const close = modal({ title, body: form, beforeClose: () => { resolve(null); } });
    input.oninput = () => input.setCustomValidity("");
    form.onsubmit = e => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
        input.setCustomValidity("请输入单个文件或文件夹名称");
        input.reportValidity();
        return;
      }
      close();
      resolve(name);
    };
    input.focus();
    input.setSelectionRange(0, initial.lastIndexOf(".") > 0 ? initial.lastIndexOf(".") : initial.length);
  });
}

/** Only fetch the selected snapshot. Restoring returns its text to the normal conditional save path. */
export async function chooseMemoVersion(url, readOnly = false) {
  const versions = await api(url);
  return new Promise(resolve => {
    let request = 0, selected = null;
    const select = h("select", { class: "input", "aria-label": "选择历史版本" },
      versions.map(v => h("option", { value: v.id }, new Date(v.at).toLocaleString() + " · #" + v.id)));
    const preview = h("pre", { class: "memo-snapshot", "aria-label": "版本正文" });
    const apply = h("button", { class: "btn primary", disabled: true, onclick: () => { close(); resolve(selected); } }, "恢复此版本");
    const body = h("div", { class: "modal-body memo-fields" },
      versions.length ? [select, preview, readOnly ? null : apply] : h("p", {}, "还没有历史版本。下次保存修改时，会保留修改前的正文。"));
    const close = modal({ title: "版本历史", body, beforeClose: () => { resolve(null); } });
    async function load() {
      const seq = ++request;
      selected = null;
      apply.disabled = true;
      preview.textContent = "正在读取…";
      try {
        const { text } = await api(url + "&id=" + encodeURIComponent(select.value));
        if (seq !== request) return;
        selected = text;
        preview.textContent = text || "（空文件）";
        apply.disabled = false;
      } catch (err) { if (seq === request) preview.textContent = err.message; }
    }
    select.onchange = load;
    if (versions.length) void load();
  });
}
