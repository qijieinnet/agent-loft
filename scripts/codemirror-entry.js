// 打进 web/vendor-built/codemirror.js 的内容。要加语言：在这里导出，再到 web/views/file-editor.js 里对上后缀，
// 然后 npm run build:editor。
export { EditorView, basicSetup } from "codemirror";
export { Compartment, EditorState } from "@codemirror/state";
export { keymap } from "@codemirror/view";
export { indentWithTab } from "@codemirror/commands";
export { StreamLanguage } from "@codemirror/language";
export { oneDark } from "@codemirror/theme-one-dark";
export { cpp } from "@codemirror/lang-cpp";
export { css } from "@codemirror/lang-css";
export { go } from "@codemirror/lang-go";
export { html } from "@codemirror/lang-html";
export { java } from "@codemirror/lang-java";
export { javascript } from "@codemirror/lang-javascript";
export { json } from "@codemirror/lang-json";
export { markdown } from "@codemirror/lang-markdown";
export { python } from "@codemirror/lang-python";
export { rust } from "@codemirror/lang-rust";
export { sql } from "@codemirror/lang-sql";
export { xml } from "@codemirror/lang-xml";
export { yaml } from "@codemirror/lang-yaml";
export { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
export { shell } from "@codemirror/legacy-modes/mode/shell";
export { toml } from "@codemirror/legacy-modes/mode/toml";
