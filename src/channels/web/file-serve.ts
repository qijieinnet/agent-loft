// 把工作目录里的文件发给浏览器：预览（支持 Range）、下载，以及放进沙箱显示的网页。
// 谁能看哪个文件由调用方判断（回复里的文件见 api.ts，工作区面板见 workspace-api.ts），这里只管怎么发、响应头怎么带。
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../core/config.js";
import { replyFileType } from "../../core/reply-files.js";
import { ownFrameAncestors } from "../../core/servers.js";
import { HTML_CSP, HTML_MAX, htmlDocument } from "../../core/visualize.js";
import { HttpError, SECURITY_HEADERS, sendJson } from "./http.js";

export function serveReplyFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { stat: boolean; download: boolean }): void {
  const st = fs.statSync(file);
  const name = path.basename(file);
  if (opts.stat) {
    sendJson(res, 200, { name, path: file, size: st.size, mtime: st.mtimeMs });
    return;
  }
  const type = replyFileType(file);
  const inline = !opts.download && !!type;
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    "Content-Type": inline ? type! : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
  };
  if (type === "application/pdf") {
    // 预览窗里用 iframe 嵌 PDF：要允许本站嵌入。Chrome 带 sandbox 的文档不显示 PDF，这里不加
    // （所有接口的响应事先都带上了 SECURITY_HEADERS，见 server.ts，这里得把那个也去掉）
    delete headers["X-Frame-Options"];
    res.removeHeader("X-Frame-Options");
    headers["Content-Security-Policy"] = `default-src 'none'; frame-ancestors ${ownFrameAncestors(config().servers)}`;
  } else {
    headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    start = Math.max(0, start);
    end = Math.max(start, end);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  fs.createReadStream(file).pipe(res);
}

/** 网页（Codex visualize 画的图表、agent 写的网页）：套好外壳放进沙箱显示 */
export function serveHtmlFile(res: ServerResponse, file: string): void {
  if (fs.statSync(file).size > HTML_MAX) throw new HttpError(413, "文件太大，下载下来看吧");
  const doc = Buffer.from(htmlDocument(fs.readFileSync(file, "utf8"), path.basename(file)));
  // 要能嵌进对话里：去掉所有响应默认带的 X-Frame-Options（见 server.ts）
  res.removeHeader("X-Frame-Options");
  res.writeHead(200, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": HTML_CSP.replace("frame-ancestors 'self'", `frame-ancestors ${ownFrameAncestors(config().servers)}`),
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": doc.length,
    "Cache-Control": "private, no-cache",
  });
  res.end(doc);
}
