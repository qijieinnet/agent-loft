// 悬停名称气泡：主进程把服务器名称和状态发过来
const $tip = document.getElementById("tip");
window.loft.onLabel(({ name, detail, tone }) => {
  document.getElementById("name").textContent = name;
  document.getElementById("text").textContent = detail;
  document.getElementById("dot").className = `dot ${tone}`;
  document.getElementById("detail").classList.toggle("hidden", !detail);
  $tip.classList.remove("on");
  requestAnimationFrame(() => $tip.classList.add("on"));
});
