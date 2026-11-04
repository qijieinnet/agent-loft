// 把 CodeMirror 打成一个文件：web/vendor-built/codemirror.js。
//
// 项目没有构建步骤，前端依赖都是按单个文件直接发给浏览器；CodeMirror 是几十个互相 import 的小包，只能先打包。
// 产物提交进仓库，发布和运行都不需要构建。升级 CodeMirror 或改了 codemirror-entry.js 后跑 npm run build:editor。
import { build } from "esbuild";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./codemirror-entry.js", import.meta.url))],
  outfile: fileURLToPath(new URL("../web/vendor-built/codemirror.js", import.meta.url)),
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  legalComments: "none",
  banner: { js: "/* CodeMirror 6 和 Lezer，MIT 许可，见同目录的 LICENSE.codemirror */" },
  logLevel: "info",
});
fs.copyFileSync(new URL("../node_modules/codemirror/LICENSE", import.meta.url), new URL("../web/vendor-built/LICENSE.codemirror", import.meta.url));
