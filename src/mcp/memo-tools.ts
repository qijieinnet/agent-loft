const writeIntent = "只有用户表达了留存或更新笔记的意图时才写入备忘录。";
export const MEMO_WRITING_GUIDE = writeIntent +
  "「这个留着下次用」「加到清单里」都算。普通聊天、问答或任务自然结束时，无需主动归档。" +
  "用 agent_loft_memos 自行选择合适的已授权读写库，搜索相关笔记，先读取再更新。已有相同内容就跳过，没有合适的笔记就沿用目录和命名习惯新建 Markdown。" +
  "根据对话拟标题、提炼正文，保存成功后告诉用户库名和文件路径。";

const fields = {
  source: "笔记库 ID，从 list_memo_sources 获取", path: "库内相对文件路径", folder: "库内目录，默认根目录",
  cursor: "上一页返回的分页标记", query: "文件名、路径或正文关键词", version: "read_memo 返回的最新版本",
  text: "要新建、追加或替换成的文本", original: "要替换的唯一原文（精确匹配）",
};
type Field = keyof typeof fields;
function tool(name: string, description: string, required: Field[], optional: Field[] = [], write = false) {
  const properties = Object.fromEntries([...required, ...optional].map(f => [f, { type: "string", description: fields[f] }]));
  return { name, description: write ? writeIntent + description : description, inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: !write, openWorldHint: true } };
}
export const MEMO_TOOLS = [
  tool("list_memo_sources", "用户想留下笔记、清单或排障经验时，用此工具找到合适的读写库，再搜索、更新或新建笔记。库名、文件名和正文可以由你根据对话确定。", []),
  tool("list_memo_files", "浏览笔记库中的一层目录。", ["source"], ["folder", "cursor"]),
  tool("search_memos", "在授权笔记库的全文索引里搜索文件名和正文，返回路径和片段。success 为零表示首次索引未完成。", ["query"], ["source", "folder"]),
  tool("read_memo", "从远端读取备忘录的最新正文和版本号。", ["source", "path"]),
  tool("create_memo", "在已有目录中新建文本备忘录，同名文件会返回冲突。", ["source", "path", "text"], [], true),
  tool("append_memo", "追加文本（自行包含所需换行）。先读取最新版本。", ["source", "path", "version", "text"], [], true),
  tool("edit_memo", "精确替换一处唯一原文，先读取笔记。遇到版本冲突请重新读取并核对修改。", ["source", "path", "version", "original", "text"], [], true),
];
