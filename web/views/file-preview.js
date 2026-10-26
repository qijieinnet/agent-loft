// agent 回复里提到的文件：路径变成能点的链接，点开在弹层里预览（图片 / PDF / 音视频 / 文本代码），其它的下载。
// 能不能看由服务端判断（只认回复里写过的路径、挡掉密钥之类的敏感文件，见 core/reply-files.ts）。
import hljs from "/vendor/hljs.js";
import { h, icon, starsLoader, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { renderMarkdown } from "../lib/markdown.js";
import { S } from "../state.js";

const fileUrl = (key, p, extra = "") =>
  `/api/conversations/${encodeURIComponent(key)}/file?path=${encodeURIComponent(p)}${extra}`;
/** 网页（含 Codex visualize 画的图表）套好外壳、放进沙箱显示的地址 */
const htmlUrl = (key, p) => `/api/conversations/${encodeURIComponent(key)}/html?path=${encodeURIComponent(p)}`;

// ---------- 认路径 ----------

/** 末尾的行号：a.ts:12、a.ts:12:5、a.ts:12-20、a.ts#L12、a.ts#L12-L20 */
const LINE_SUFFIX = /(?::\d+(?:[:-]\d+)?|#L\d+(?:-L?\d+)?)$/;

/** 不带目录的文件名只认这些常见的文档 / 媒体后缀（a.js、Vue.js 这种多半是在说技术名词，不认） */
const BARE_EXT = /\.(md|markdown|txt|pdf|png|jpe?g|gif|webp|svg|csv|tsv|xlsx?|docx?|pptx?|html?|zip|tgz|gz|mp4|mov|webm|mp3|m4a|wav|log)$/i;

/** 路径里不该有的字符（通配符、模板、管道…） */
const NOT_PATH = /[\s*?{}$<>|"'`]/;

function stripLine(p) {
  return p.replace(LINE_SUFFIX, "");
}

/** 行内代码里的字：像不像一个文件路径。像就返回去掉行号后的路径 */
function codePath(text) {
  const t = stripLine(text.trim());
  if (!t || t.length > 400 || NOT_PATH.test(t) || /^[a-z][\w+.-]*:\/\/(?!\/)/i.test(t)) return null;
  if (/^(?:file:\/\/)?(?:~|\.{1,2})?\//.test(t)) {
    if (t.startsWith("//")) return null;
    // 至少两级（/a/b），或者带后缀（/a.md）：单独一个 / 、/tmp 这种多半是在说目录
    const segs = t.replace(/^(?:file:\/\/)?(?:~|\.{1,2})?\//, "").split("/").filter(Boolean);
    return segs.length >= 2 || /\.[A-Za-z]\w{0,9}$/.test(t) ? t : null;
  }
  // 相对路径：a/b.ts 这种带目录、带后缀的
  if (/^[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)+$/u.test(t) && /\.[A-Za-z]\w{0,9}$/.test(t)) return t;
  if (/^[\p{L}\p{N}_.@+-]+$/u.test(t) && BARE_EXT.test(t)) return t;
  return null;
}

/** 链接地址是不是本机文件（没有协议的、file://、绝对路径）。是就返回路径 */
function hrefPath(raw) {
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (/^[a-z][\w+.-]*:/i.test(raw) && !raw.startsWith("file://")) return null;
  let p = raw;
  // marked 会把地址里的中文、空格编码掉；服务端拿回复原文对，要还原成原样
  try {
    p = decodeURI(raw);
  } catch {
    // 编码坏了就按原样
  }
  return stripLine(p) || null;
}

/** 正文里的绝对路径（要带后缀，免得把「/ 斜杠」之类的当成路径） */
const TEXT_PATH = /(?<![\p{L}\p{N}_./~:-])(?:file:\/\/)?~?\/(?!\/)[^\s<>"'`()（）[\]{}，。；：！？、“”‘’「」|*]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?(?![\p{L}\p{N}_/-])/gu;

function fileLink(key, p, ...children) {
  return h(
    "a",
    {
      class: "file-link",
      href: fileUrl(key, p),
      target: "_blank",
      rel: "noopener",
      title: `${p}\n点击预览`,
      onclick: (e) => {
        // 新标签页打开（Ctrl / ⌘ / 中键）照浏览器的来
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openReplyFile(key, p);
      },
    },
    ...children,
  );
}

/** patchMarkdown 的 enhance：把一块回复里的文件路径（链接、行内代码、正文里的绝对路径、图片）变成能点开的 */
export function linkReplyFiles(box) {
  const key = S.current;
  if (!key) return;
  embedVisualizations(box, key);
  for (const a of box.querySelectorAll("a[href]")) {
    const p = hrefPath(a.getAttribute("href"));
    if (!p) continue;
    a.replaceWith(fileLink(key, p, ...a.childNodes));
  }
  for (const code of box.querySelectorAll("code")) {
    if (code.closest("pre, a")) continue;
    const p = codePath(code.textContent);
    if (p) code.replaceWith(fileLink(key, p, code.cloneNode(true)));
  }
  for (const img of box.querySelectorAll("img[src]")) {
    const p = hrefPath(img.getAttribute("src"));
    if (!p) continue;
    const alt = img.getAttribute("alt") || p.split("/").pop();
    const pic = h("img", { src: fileUrl(key, p), alt, loading: "lazy" });
    const link = fileLink(key, p, pic);
    link.classList.add("file-img");
    // 打不开（文件没了、不能看）：退回成一个文字链接，点了会说明原因
    pic.onerror = () => link.replaceChildren(alt);
    img.replaceWith(link);
  }
  linkTextPaths(box, key);
}

function linkTextPaths(box, key) {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("pre, code, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes("/")) nodes.push(n);
  for (const node of nodes) {
    const text = node.nodeValue;
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(TEXT_PATH)) {
      parts.push(text.slice(last, m.index), fileLink(key, stripLine(m[0]), m[0]));
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    parts.push(text.slice(last));
    node.replaceWith(...parts.filter((x) => x !== ""));
  }
}

// ---------- Codex visualize 画的图表 ----------
//
// Codex 自带的 visualize 插件把图表写成 HTML 片段，回复里单独一行 visualize{"path":"…"} 标出放在哪
// （官方客户端照这个把图表嵌进对话）。这里一样嵌进来：服务端套好插件的外壳，放进沙箱 iframe

const VIZ_LINE = /^\s*(?:::)?visualize\s*(\{.*\})\s*$/s;

function vizSpec(text) {
  const m = VIZ_LINE.exec(text);
  if (!m) return null;
  try {
    const spec = JSON.parse(m[1]);
    return typeof spec?.path === "string" && spec.path ? spec : null;
  } catch {
    // 还在输出、JSON 还没写完：先当普通文字
    return null;
  }
}

function embedVisualizations(box, key) {
  for (const p of box.querySelectorAll("p")) {
    if (!p.textContent.includes("visualize")) continue;
    const whole = vizSpec(p.textContent);
    if (whole) {
      p.replaceWith(vizFrame(key, whole));
      continue;
    }
    // 和别的文字挤在同一段里（中间只隔了一个换行）
    for (const n of [...p.childNodes]) {
      const spec = n.nodeType === Node.TEXT_NODE ? vizSpec(n.nodeValue) : null;
      if (!spec) continue;
      if (n.previousSibling?.nodeName === "BR") n.previousSibling.remove();
      if (n.nextSibling?.nodeName === "BR") n.nextSibling.remove();
      n.replaceWith(vizFrame(key, spec));
    }
  }
}

function vizFrame(key, spec) {
  const page = htmlUrl(key, spec.path);
  const name = spec.title || spec.path.split("/").pop();
  const box = h("div", { class: `viz${spec.mode === "wide" ? " wide" : ""}` }, h("div", { class: "viz-loading" }, starsLoader()));
  // 先问一下能不能看：不能的话 iframe 里只会是一页报错
  void api(`${fileUrl(key, spec.path)}&stat=1`).then(
    () => {
      const frame = h("iframe", { class: "viz-frame", src: page, sandbox: "allow-scripts", referrerpolicy: "no-referrer", loading: "lazy", title: name });
      box.replaceChildren(
        frame,
        h(
          "div",
          { class: "viz-actions" },
          h("button", { class: "viz-btn", onclick: () => openReplyFile(key, spec.path) }, "放大"),
          h("a", { class: "viz-btn", href: page, target: "_blank", rel: "noopener" }, "新标签页打开"),
        ),
      );
    },
    (err) => box.replaceChildren(h("div", { class: "viz-error" }, `图表显示不了：${err.message}`, h("div", { class: "viz-path" }, spec.path))),
  );
  return box;
}

// 沙箱里的页面报自己的高度（core/visualize.ts 加的脚本），iframe 跟着变高
addEventListener("message", (e) => {
  if (e.data?.type !== "aloft-html-size" || !Number.isFinite(e.data.height)) return;
  for (const frame of document.querySelectorAll("iframe.viz-frame")) {
    if (frame.contentWindow !== e.source) continue;
    // 有的页面按视口高度排版，iframe 一变高它也跟着变高：设个上限，别无限长下去
    const height = Math.min(Math.max(Math.ceil(e.data.height), 60), 1600);
    if (Math.abs(frame.offsetHeight - height) > 2) frame.style.height = `${height}px`;
  }
});

// ---------- 预览 ----------

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const VIDEO = /\.(mp4|m4v|webm|mov)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const HTML = /\.html?$/i;
/** 网页超过这么大就不显示了（和服务端 core/visualize.ts 的 HTML_MAX 一致） */
const HTML_MAX = 2 * 1024 * 1024;
/** 明摆着不是文本的：不去读内容，直接给下载 */
const BINARY = /\.(zip|gz|tgz|bz2|xz|7z|rar|tar|docx?|xlsx?|pptx?|key|numbers|pages|exe|dmg|iso|bin|so|dylib|o|class|jar|wasm|sqlite|db|woff2?|ttf|otf|psd|ai|sketch)$/i;
/** 文本最多读这么多来预览 */
const TEXT_MAX = 1024 * 1024;

function fmtSize(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 文件预览弹层：先拿名字和大小，再按类型画内容。点外面、按 Esc 关闭 */
export async function openReplyFile(key, p) {
  const url = fileUrl(key, p);
  const body = h("div", { class: "fv-body" }, h("div", { class: "fv-loading" }, starsLoader("lg")));
  const title = h("div", { class: "fv-title" }, h("div", { class: "fv-name" }, p.split("/").pop() || p), h("div", { class: "fv-sub" }, p));
  const actions = h("div", { class: "fv-actions" });
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close();
  };
  const overlay = h(
    "div",
    { class: "file-viewer", onclick: (e) => e.target === overlay && close() },
    h(
      "div",
      { class: "fv-panel" },
      h("div", { class: "fv-head" }, title, actions, h("button", { class: "icon-btn", title: "关闭", onclick: close }, icon("x"))),
      body,
    ),
  );
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);

  let info;
  try {
    info = await api(`${url}&stat=1`);
  } catch (err) {
    close();
    toast(err.message);
    return;
  }
  if (!overlay.isConnected) return;
  title.lastChild.textContent = [info.path, fmtSize(info.size)].filter(Boolean).join(" · ");
  title.firstChild.textContent = info.name;
  const download = h("a", { class: "btn", href: `${url}&download=1`, download: info.name }, "下载");
  const newTab = h("a", { class: "btn ghost", href: url, target: "_blank", rel: "noopener" }, "新标签页打开");
  const name = info.name;
  const media = IMAGE.test(name) || VIDEO.test(name) || AUDIO.test(name) || /\.pdf$/i.test(name);
  actions.replaceChildren(...(media ? [newTab, download] : [download]));

  if (IMAGE.test(name)) {
    const img = h("img", { class: "fv-img", src: url, alt: name });
    img.onerror = () => body.replaceChildren(notPreviewable("图片打不开", download));
    return body.replaceChildren(img);
  }
  if (/\.pdf$/i.test(name)) return body.replaceChildren(h("iframe", { class: "fv-frame", src: url, title: name }));
  if (VIDEO.test(name)) return body.replaceChildren(h("video", { class: "fv-media", src: url, controls: true, playsinline: true, preload: "metadata" }));
  if (AUDIO.test(name)) return body.replaceChildren(h("audio", { class: "fv-audio", src: url, controls: true, preload: "metadata" }));
  if (BINARY.test(name)) return body.replaceChildren(notPreviewable("这种文件不能在网页里预览", download));
  if (info.size === 0) return body.replaceChildren(notPreviewable("空文件", null));

  const showText = async () => {
    const view = await textView(url, info, download);
    if (overlay.isConnected) body.replaceChildren(...view);
  };
  // 网页：放进沙箱里显示出来，也能切到源码
  if (HTML.test(name) && info.size <= HTML_MAX) {
    const page = htmlUrl(key, p);
    const frame = h("iframe", { class: "fv-frame fv-html", src: page, sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: name });
    const toggle = h(
      "button",
      {
        class: "btn ghost",
        onclick: () => {
          const toSource = toggle.textContent === "源码";
          toggle.textContent = toSource ? "预览" : "源码";
          if (toSource) void showText();
          else body.replaceChildren(frame);
        },
      },
      "源码",
    );
    actions.replaceChildren(toggle, h("a", { class: "btn ghost", href: page, target: "_blank", rel: "noopener" }, "新标签页打开"), download);
    return body.replaceChildren(frame);
  }
  await showText();
}

/** 当文本显示：太大只读开头，有 NUL 字节的是二进制。返回要放进 body 的节点 */
async function textView(url, info, download) {
  let buf;
  try {
    const res = await fetch(url, { credentials: "same-origin", headers: info.size > TEXT_MAX ? { Range: `bytes=0-${TEXT_MAX - 1}` } : {} });
    if (!res.ok) throw new Error(`读取失败（${res.status}）`);
    buf = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    return [notPreviewable(err.message, download)];
  }
  if (buf.subarray(0, 8192).includes(0)) return [notPreviewable("这个文件不是文本，不能在网页里预览", download)];
  const text = new TextDecoder("utf-8").decode(buf);
  const cut = info.size > buf.length ? h("div", { class: "fv-cut" }, `文件有 ${fmtSize(info.size)}，这里只显示前 ${fmtSize(buf.length)}，完整内容请下载`) : null;
  const view = MARKDOWN.test(info.name) ? h("div", { class: "fv-doc" }, renderMarkdown(text)) : codeView(text, info.name);
  return cut ? [cut, view] : [view];
}

function codeView(text, name) {
  const code = h("code", {});
  const ext = (/\.([\w+-]+)$/.exec(name)?.[1] ?? "").toLowerCase();
  const lang = hljs.getLanguage(ext) ? ext : null;
  // 高亮很慢：太大的就原样显示
  if (lang && text.length < 300_000) {
    try {
      code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      code.classList.add("hljs");
    } catch {
      code.textContent = text;
    }
  } else code.textContent = text;
  return h("pre", { class: "fv-code" }, code);
}

function notPreviewable(message, download) {
  return h("div", { class: "fv-empty" }, h("div", {}, message), download ? download.cloneNode(true) : null);
}
