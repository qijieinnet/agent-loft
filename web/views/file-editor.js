// 文本编辑器：CodeMirror 6，第一次编辑文件时才加载（web/vendor-built/codemirror.js，打包见 scripts/build-editor.mjs）。
import { detectEol, restoreEol } from "../lib/eol.js";

let loading = null;
function loadCodeMirror() {
  loading ??= import("../vendor-built/codemirror.js").catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** 文件名（含后缀）对应的语言。对不上的就是纯文本 */
function languageFor(name, CM) {
  const lower = name.toLowerCase();
  const stream = (mode) => CM.StreamLanguage.define(mode);
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return stream(CM.dockerFile);
  if (lower === "makefile") return stream(CM.shell);
  const ext = /\.([a-z0-9]+)$/.exec(lower)?.[1];
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return CM.javascript();
    case "jsx":
      return CM.javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return CM.javascript({ typescript: true });
    case "tsx":
      return CM.javascript({ typescript: true, jsx: true });
    case "json":
    case "jsonc":
    case "webmanifest":
      return CM.json();
    case "py":
    case "pyi":
      return CM.python();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return CM.html();
    case "css":
    case "scss":
    case "less":
      return CM.css();
    case "md":
    case "markdown":
      return CM.markdown();
    case "yml":
    case "yaml":
      return CM.yaml();
    case "go":
      return CM.go();
    case "rs":
      return CM.rust();
    case "sql":
      return CM.sql();
    case "xml":
    case "svg":
      return CM.xml();
    case "java":
    case "kt":
      return CM.java();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return CM.cpp();
    case "sh":
    case "bash":
    case "zsh":
    case "env":
      return stream(CM.shell);
    case "toml":
    case "ini":
      return stream(CM.toml);
    default:
      return null;
  }
}

/**
 * 在 parent 里建一个编辑器。onChange：内容变了；onSave：按了 Ctrl / ⌘ + S。
 * 返回 { text, setText, focus, measure, destroy }；text() 给的是还原了换行符、可以直接存的内容
 */
export async function createEditor({ parent, text, name, onChange, onSave }) {
  const CM = await loadCodeMirror();
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const theme = new CM.Compartment();
  const themeOf = () => (dark.matches ? CM.oneDark : []);
  let eol = detectEol(text);
  const language = languageFor(name, CM);
  // 混用换行符的文件：只认 \n，\r 留在文字里（显示成特殊字符），存回去一字不差
  const separator = new CM.Compartment();
  const separatorOf = () => (eol === "mixed" ? CM.EditorState.lineSeparator.of("\n") : []);
  const view = new CM.EditorView({
    parent,
    state: CM.EditorState.create({
      doc: text,
      extensions: [
        CM.keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSave?.();
              return true;
            },
          },
          // Tab 缩进。键盘用户按 Esc 再按 Tab 可以离开编辑器（CodeMirror 自带）
          CM.indentWithTab,
        ]),
        CM.basicSetup,
        CM.EditorView.lineWrapping,
        theme.of(themeOf()),
        separator.of(separatorOf()),
        ...(language ? [language] : []),
        CM.EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.();
        }),
      ],
    }),
  });
  const onTheme = () => view.dispatch({ effects: theme.reconfigure(themeOf()) });
  dark.addEventListener("change", onTheme);
  return {
    text: () => restoreEol(view.state.doc.toString(), eol),
    setText(next) {
      eol = detectEol(next);
      view.dispatch({ effects: separator.reconfigure(separatorOf()) });
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
    focus: () => view.focus(),
    /** 编辑器被藏起来再放回来之后要重新量尺寸 */
    measure: () => view.requestMeasure(),
    destroy() {
      dark.removeEventListener("change", onTheme);
      view.destroy();
    },
  };
}
