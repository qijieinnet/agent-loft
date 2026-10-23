// agent-loft Web 前端。无构建步骤，原生 ES module。
//   lib/       不碰界面状态的基础件：DOM 小工具、请求、时间、markdown、WebSocket、弹层、推送订阅
//   state.js   全局状态 S、界面元素引用 ui、桌面端标记
//   views/     主界面各块：布局、侧栏、顶栏、消息、输入框、斜杠命令、定时发送、语音……
//   settings/  设置弹窗的各个标签页，第一次打开设置时才加载
import { $app, fill, h } from "./lib/dom.js";
import { boot } from "./views/layout.js";

boot().catch((err) => {
  fill($app, h("div", { class: "auth" }, h("div", { class: "auth-card" }, h("p", {}, `加载失败：${err.message}`))));
});
