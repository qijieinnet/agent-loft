import { fill, h, icon } from "../lib/dom.js";
import { S, ui } from "../state.js";

// ---------- 任务清单（输入框上方的进度条） ----------
// agent 自己列的任务（Claude 的 TaskCreate / TodoWrite，Codex 的计划）：做到第几项、正在做哪一项。
// 清单是整份推过来的（见服务端的 todos 事件、历史里的 todos），这里只管画。

/** 展开看全部还是只看一行，记住上次的选择 */
let open = localStorage.getItem("aim.todosOpen") !== "0";
/** 当前这份清单点过 ×：清单再变才重新出来 */
let dismissed = false;

/** 换了一份清单（null = 清空：换会话、开新对话） */
export function setTodos(list) {
  S.todos = list?.length ? list : null;
  dismissed = false;
  renderTodos();
}

export function renderTodos() {
  if (!ui.todoBar) return;
  const list = S.todos;
  const done = list ? list.filter((t) => t.status === "completed").length : 0;
  // 全做完了：这一轮还在跑就留着（看得到最后一项打上勾），跑完就收起来
  const show = !!list && !dismissed && (done < list.length || S.busy);
  ui.todoBar.hidden = !show;
  if (!show) return fill(ui.todoBar);
  const doing = list.find((t) => t.status === "in_progress");
  const title = doing ? doing.activeForm || doing.content : done === list.length ? "全部完成" : "任务清单";
  fill(
    ui.todoBar,
    h(
      "div",
      { class: "todo-head" },
      h(
        "button",
        {
          class: "todo-toggle",
          title: open ? "收起" : "展开全部",
          onclick: () => {
            open = !open;
            localStorage.setItem("aim.todosOpen", open ? "1" : "0");
            renderTodos();
          },
        },
        h("span", { class: `todo-title${doing && S.busy ? " shimmer" : ""}` }, title),
        h("span", { class: "todo-count" }, `${done}/${list.length}`),
        h("span", { class: `chev${open ? " open" : ""}` }, "›"),
      ),
      h(
        "button",
        {
          class: "icon-btn todo-close",
          title: "先不看（清单有变化时再出来）",
          onclick: () => {
            dismissed = true;
            renderTodos();
          },
        },
        icon("x"),
      ),
    ),
    open
      ? h(
          "ol",
          { class: "todo-list" },
          list.map((t) => h("li", { class: `todo-item ${t.status}` }, h("span", { class: "todo-mark" }), h("span", { class: "todo-text" }, t.content))),
        )
      : null,
  );
}
