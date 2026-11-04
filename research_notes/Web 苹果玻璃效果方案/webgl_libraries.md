# 可复用 Liquid Glass 库、WebGL/WebGPU 与 iPhone Safari

## 1. 哪些库真的能在 Safari 折射聊天 DOM？

### Takeaway
只有 Glass-HQ 的显式 live DOM scene 路线值得进一步做 iPhone 原型；它规避的是 backdrop-filter 的采样限制，代价是需要接管背景内容层的绘制。liquidglass.dev 的跨浏览器承诺主要适用于可复制的图片背景；rdev 明确承认 Safari 没有位移。

### Cited Findings
- **Glass-HQ/liquid-glass，@glass-sdk/liquid-glass 0.0.2，MIT**：文档提供 `createGlassScene`、`setContent`、`addSurface` 的无 React 用法。要求 HTTPS/localhost 和可用 WebGPU adapter。采用显式、限定大小的 scene，Safari 背景应不透明；任意页面 backdrop 采样、原生视频合成、旋转/变换祖先均不在支持范围。作者说明 WebGPU/WGSL 生成材质贴图，SVG filter 作用于 live DOM，没有 DOM 截图。— [包文档](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/README.md)
- **源码核对**：`createGlassScene` 接受真实内容元素，`setContent` 保留其 `filter` 样式，再在该元素上设置 `filter: url(...)`。滤镜用 `SourceGraphic` 和 `feDisplacementMap`；WebKit 分支没有 DOM 克隆或截图采集。— [DOM controller 源码](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/src/dom/index.ts)
- **源码核对**：`composeSparseLayers` 保留透镜区域以外的 SourceGraphic，再把局部材质结果合并进去；这是同一 DOM 内容的滤镜合成，不是将整个聊天以 canvas 替代。— [合成源码](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/src/dom/compose-layers.ts)
- **liquidglass.dev / gentpan/liquidglass，MIT**：首页的“every browser”必须连同兼容表阅读：已知图片背景在 Safari 可折射，任意页面 DOM 在 Safari/Firefox 降级成磨砂 blur。首页称两个零依赖 ES module 合计约 30 KB gzip，这是作者数据，不是本次测量。— [官网兼容表、体积说明](https://liquidglass.dev/)
- 其组件真实路径是在玻璃里放一个与原图对齐的副本；没有已知背景时用 backdrop-filter fallback。源码头注释与 CSS `.lg-surface__glass--fallback` 均证实这一点。— [components.js](https://raw.githubusercontent.com/gentpan/liquidglass/main/lib/components.js)
- 文档允许自托管两个 JS 文件，适配 vanilla DOM；`data-lg-backdrop` 指向图片或 CSS 背景，副本跟随滚动/resize。任意 DOM 的 Safari 路径依旧是 blur。— [组件文档](https://liquidglass.dev/docs/)
- **rdev/liquid-glass-react，MIT**：README 明示 Safari 和 Firefox 只有部分效果，displacement 不可见；因此不适合解决本项目的 iPhone 折射问题。— [仓库 README](https://github.com/rdev/liquid-glass-react)
- rdev 的 `mode="shader"` 是生成位移图后仍交给 SVG/CSS 的流程，不能把 shader 一词理解为完整 WebGL 背景渲染器。— [源码](https://raw.githubusercontent.com/rdev/liquid-glass-react/master/src/index.tsx)

### Inferences
- 两个顶部控件若需要折射背后真实滚动文字，Glass-HQ 是三个候选中机制最匹配者；没有必要为了它迁移整个项目到 React。
- Glass-HQ 在 Safari 不要求复制整个聊天 DOM，但需要将应被折射的真实聊天内容纳入显式 content 层；不能给现有两个按钮加一行 class 就完成。
- liquidglass.dev 更适合图片卡片/固定背景的玻璃原型；它能改进材质与触感，但直接换库不会让聊天顶部的 Safari 磨砂变为真实文字折射。

### Gaps
- 本次仅做文档与源码审核，未在 iPhone Safari/PWA 实机验证三者。
- 未核对发布到 npm 的构建是否与当前 main 完全一致，实际原型应锁定版本/commit。

## 2. WebGL/WebGPU 会如何获得背景；动态聊天和无障碍是否保留？

### Takeaway
GPU 本身不会自动获得任意 HTML 页面像素。可用来源是已知图片/视频/canvas，或像 Glass-HQ 一样把 GPU 仅用于生成光学图，再让浏览器对 live DOM 做普通 filter。

### Cited Findings
- liquidglass 的独立 WebGL renderer 接收 `canvas, source`，每次 render 使用 `texImage2D(..., source)` 上传背景。注释用途为 Safari 视频、canvas 和图片；跨域资源需要 CORS。`start()` 用 requestAnimationFrame 连续重绘，默认像素比上限为 2。这段 renderer 没有 HTML DOM 截图流程。— [glass-webgl.js](https://raw.githubusercontent.com/gentpan/liquidglass/main/lib/glass-webgl.js)
- Glass-HQ 的 GPU renderer 是首次使用时动态 import，源码说明避免将 vgpu 塞进首包。— [renderer.ts](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/src/dom/renderer.ts)
- 包导出包括 `/dom`、`/gpu`、`/core`；依赖为 `@base-ui/react`、`@lisse/core`、`vgpu`，React/ReactDOM >=19 是 peer dependency。无 React API 存在，但安装依赖和最终浏览器 bundle 必须分开评估，不能声称零依赖或零 React 安装成本。— [package.json](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/package.json)
- Safari 滚动有专门处理：React `GlassContent layout="scroll"` 将实际 DOM scrollport 放到 SVG foreignObject 内；源码注释原因是 Safari 异步 overflow scroll 会移动缓存的整张 filter 结果，使本应固定的玻璃 mask 一起移动。该包装没有复制 children，作者注释称输入、选择和滚动保留原生行为。— [scene.tsx](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/src/react/scene.tsx)
- ticker 监听 scroll、resize、pointer、DOM childList/attributes 等信号，空闲时停下 RAF，另有默认每秒 heartbeat；MutationObserver 的 characterData 为 false。— [ticker.ts](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/src/dom/ticker.ts)
- Safari 26.0 已加入 WebGPU；这证明 API 基础可用，不证明某个库的材质、驱动或性能通过。— [Apple Safari 26 Release Notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes)
- rdev 包要求 React 与 ReactDOM >=18，没有其他运行时 dependencies 字段。— [package.json](https://raw.githubusercontent.com/rdev/liquid-glass-react/master/package.json)

### Inferences
- Glass-HQ 的流式文本可以保持真实 DOM、语义和可选中性；浏览器会重新绘制变化后的 SourceGraphic，无需周期性截图。字符节点变化未由 ticker 的 characterData 监听，不代表文字必然不更新，但若更新还改变几何而没有可观察 resize/childList，就需要实测。
- vanilla 集成必须复刻 Safari 的滚动包装/对应 CSS，不能只照最短 `/dom` 示例；还要验长按选择、链接、流式 Markdown、代码块横向滚动、键盘弹出、VisualViewport 与 PWA safe-area。
- 对我们的文字聊天，纯 WebGL 替代路线仍需自己实现 DOM 到纹理或维护一份视觉副本，增加同步与可访问性负担；不能从“WebGL 能运行”推导“任意聊天背景能原样折射”。

### Gaps
- 未找到作者给出的本项目同类 iPhone 滚动/流式文字性能、能耗、内存或完整 bundle 基准，因此不报 FPS/百分比/耗电结论。
- foreignObject 下 iPhone VoiceOver、文字选择、输入法与长代码块的实际兼容仍未验证。

## 3. 当前可实施的选择、性能和成熟度限制是什么？

### Takeaway
建议保留轻量 CSS 为可靠基线，单独做 Glass-HQ 的有边界实验，验证后再决定是否接入顶部两个控件；不建议立即把整个聊天视口改成复杂滤镜层。

### Cited Findings
- Glass-HQ 文档警告 Safari 对大内容层过滤明显比 Chromium 昂贵，即使材质图已缓存；建议限定 scene 并在目标设备验证动画。— [包文档](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/README.md)
- 作者的 engine 注释认为 WebKit/Gecko 的 HTML SVG filters 大多在软件里绘制，而 Chromium 在 GPU；这是实现者判断，不是 Apple 的跨设备性能承诺。— [engine.ts](https://raw.githubusercontent.com/Glass-HQ/liquid-glass/main/packages/liquid-glass/src/dom/engine.ts)
- 截至查阅时开着的 **issue #8（2026-10-30）**：报告 macOS Safari 26.5 中背景有越界后代时，玻璃错位或不显示，尽管 diagnostics 正常；临时办法是约束全部后代在内容框内。这是用户报告，并非本次实机复现。— [issue #8](https://github.com/Glass-HQ/liquid-glass/issues/8)
- 同日的 **issue #9**：报告 Safari 26.5 动态增加/移除 surface 后滤镜不重绘，出现缺失或残留；强制重新赋值 filter 可绕过。顶部两个常驻 surface 能避开一部分该触发条件，但不能据此宣称已修复。— [issue #9](https://github.com/Glass-HQ/liquid-glass/issues/9)

### Inferences
- 优先级：① CSS 细边缘、高光、合适透明度与按压动效，可靠主路径；② Glass-HQ `/dom` 独立实验，确认真 iPhone 折射与交互；③ liquidglass.dev 只作为已知图片背景/交互材质参考；不选 rdev 解决 Safari 核心差距。
- 具体原型应保留现有 `<button>`、aria-label 和点击处理，注册左侧侧栏按钮以及右侧“专家+更多”胶囊为两个 surfaces；只把必要背景层纳入 scene。先固定形状，避免菜单 morph 和连续几何动画，再测滚动/流式内容。
- 两个 surface 很小并不能保证总成本小：若整个长聊天 DOM 都是 filtered content，影响范围仍由该内容层决定。不要为了两块玻璃盲目克隆全聊天；真实内容 filter 也须限制 paint 边界。
- 必须按 `navigator.gpu` / adapter 失败 / filter 显示异常回退 CSS；PWA 也需单独测，不能用桌面 Chromium 截图作为 iPhone 证明。

### Gaps
- 没有证据支持“与原生像素一致”“稳定 60/120 FPS”“两按钮几乎零成本”；原型与真机对比完成前不作这些承诺。
- Glass-HQ 的下载体积、依赖 tree-shaking 后体积、本项目需要的布局改动规模尚未测量。
