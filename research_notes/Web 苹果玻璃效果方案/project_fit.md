# Agent Loft 移动端顶部玻璃按钮：项目适配与验证

## 当前为什么更像磨砂按钮，最先应解决什么？

### Takeaway
当前的主要限制不是阴影不够，而是按钮背后几乎没有可供折射、模糊的内容：顶部按钮行被不透明顶栏背景遮住，PWA 模式还将顶栏恢复为占据正常布局空间的实色 sticky 元素。只加大 blur 或高光不能解决这一点。

### Cited Findings
- 实际改动范围已经是用户要求的两个玻璃表面：左侧 `.menu-btn` 和右侧 `.top-actions`。右侧 group 内先专家、后更多，仍使用真实 HTML button；桌面 `.top-actions` 使用 `display: contents`。— [topbar.js:14](/home/ubuntu/project/agent-loft/web/views/topbar.js:14)、[topbar.css:158](/home/ubuntu/project/agent-loft/web/css/topbar.css:158)、[mobile.css:30](/home/ubuntu/project/agent-loft/web/css/mobile.css:30)
- 当前滤镜为 `blur(18px) saturate(160%)`，填充为 68% 的 `--bg-soft`，再叠半透明高光和内阴影；这是普通 backdrop blur，没有位移、边缘折射或环境采样计算。— [mobile.css:23](/home/ubuntu/project/agent-loft/web/css/mobile.css:23)
- 浏览器模式 `.topbar` 为 absolute，背景前大部分是完全不透明的 `var(--bg)`，只有底部 22px 过渡；按钮在这一大片实色之上。背景模糊伪元素 `.topbar::before` 位于按钮后方。— [topbar.css:52](/home/ubuntu/project/agent-loft/web/css/topbar.css:52)
- standalone + 窄屏把 topbar 变回 sticky、背景 `var(--bg)`、关闭 before，给消息的顶端 padding 变为 16px，因此消息不再穿过按钮所在区域。另有 fixed 的实色 `.edge-strip` 管理状态栏背景。— [topbar.css:32](/home/ubuntu/project/agent-loft/web/css/topbar.css:32)、[topbar.css:95](/home/ubuntu/project/agent-loft/web/css/topbar.css:95)
- WebKit 官方说明 backdrop-filter 处理元素背后的已绘制内容，最后再叠元素本身；它也明确指出这是额外的渲染 passes，应限于必要区域。— [WebKit: Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/)
- CSSWG Filter Effects 2 草案（非最终标准）说明非透明背景会遮盖 backdrop-filter，并列出 opacity、filter、mask、backdrop-filter 等 ancestor Backdrop Root 触发器；fixed、sticky、z-index 本身不是触发器。— [Filter Effects 2 §2–3](https://drafts.csswg.org/filter-effects-2/)
- 项目全局背景浅色纯白，深色 #212121；聊天为纵向 overflow auto 容器，topbar 和消息是同级。— [base.css:1](/home/ubuntu/project/agent-loft/web/css/base.css:1)、[messages.css:3](/home/ubuntu/project/agent-loft/web/css/messages.css:3)、[layout.js:288](/home/ubuntu/project/agent-loft/web/views/layout.js:288)

### Inferences
- 视觉弱的直接原因应优先归因为“实色遮挡 + 高填充 + 无光学位移”，而不是 Safari 根本不支持 blur。
- 不应误报这里存在父子嵌套的 backdrop-filter：topbar 的滤镜在伪元素上，它是按钮的绘制同级，不是按钮祖先。整行 blur 已将背景变平、实色背景又将其遮盖，是不同问题。
- 68% 灰白填充叠在平坦背景上，即使减小到 10% 也只是在改按钮颜色；无纹理的纯色经过折射仍是纯色。不能用纯色欢迎页截图证明折射已生效。

### Gaps
- 未在真实 iPhone 对当前效果录屏或采样 GPU；“弱磨砂”是根据代码结构得出的视觉解释，不是本次设备实测结论。
- topbar.css 中“宽度铺满、高于 10px”等对系统边缘模糊的注释是项目既有经验，不能当作稳定公开 Web API 规范。

## 本项目适合什么实现，如何控制改动范围？

### Takeaway
先做两个顶部玻璃表面的独立实验：CSS 透明材质与边缘光作为全平台基线；真正光学位移只有在 iPhone 上能稳定工作的实现才进入增强层。任何折射库都必须验证它采样的内容，而不是因为 demo 好看便接入整个聊天。

### Cited Findings
- 项目前端是原生 ES modules + CSS，通过 `h()` 创建元素，没有 React 或前端打包依赖；CSS 的 mobile.css 最后加载。— [package.json](/home/ubuntu/project/agent-loft/package.json)、[topbar.js:1](/home/ubuntu/project/agent-loft/web/views/topbar.js:1)、[index.html:17](/home/ubuntu/project/agent-loft/web/index.html:17)
- 专家按钮的 hover 仅对 mouse 生效，点击会固定或关闭专家卡；更多和侧栏已有独立交互。应保留这些按钮和 handlers，把材质放到装饰层。— [topbar.js:53](/home/ubuntu/project/agent-loft/web/views/topbar.js:53)
- 消息流会改变布局、重算留白、自动滚动；`fitSpacer()` 使用顶栏与消息区实际位置计算被遮挡高度。— [messages.js:235](/home/ubuntu/project/agent-loft/web/views/messages.js:235)
- 聊天含懒加载代码高亮、SVG 图表、Mermaid 图片、流式相册；多服务器还会把整页放在 iframe 内，并由宿主修正 iframe 内缺失的 safe-area。— [markdown.js:65](/home/ubuntu/project/agent-loft/web/lib/markdown.js:65)、[diagrams.js:3](/home/ubuntu/project/agent-loft/web/lib/diagrams.js:3)、[albums.js:22](/home/ubuntu/project/agent-loft/web/lib/albums.js:22)、[shell.js:293](/home/ubuntu/project/agent-loft/web/lib/shell.js:293)
- WebKit 工程师在 bug 301756 解释：靠近被浏览器 UI 遮挡的视口边缘的 fixed/sticky 元素会影响纯色延伸，这是 Safari 防止滚动时出现边缘缺口的逻辑。— [WebKit bug 301756 comment 2](https://bugs.webkit.org/show_bug.cgi?id=301756#c2)

### Inferences
- 推荐实验 A（适合先落地）：保留实际按钮、右侧 group 结构和现有业务，只重做两块表面的视觉；用低不透明度着色、较克制 blur、成对明暗边缘、局部高光和短按反馈。它能改善厚度和浮起感，但应称为玻璃外观，不承诺背景折射。
- 若实验 A 需要明显透出滚动内容，要另行调整移动 topbar 的背景/层级，让玻璃区域真正面对消息，不能只改 `--glass-fill`。标题可保留独立背景过渡。Safari 普通页与 standalone 布局分别处理；不要一刀切删除 `.edge-strip` 或 PWA workaround。
- PWA 可研究“仅状态栏安全区保留实色薄层，按钮行独立 overlay”的结构，但这会改变目前的 sticky 布局；必须重新验证 `fitSpacer()`、标题位置和状态栏，并明确它是待实测方案。
- 实验 B（有条件）：普通 `filter:url()` 作用于已登记的真实内容场景，与 backdrop-filter 是不同路线。另一分工已核验 Glass-HQ 的 DOM 实现是直接过滤真实 live scene，以 SourceGraphic + feDisplacementMap 保持透镜外原样，不依赖截图或克隆；Safari 滚动需要 SVG foreignObject 场景包装，具体证据见本目录 webgl_libraries 笔记。应先审查包装是否兼容当前 `.messages` 滚动、`fitSpacer()` 顶部定位、弹层与 iframe safe-area。整片场景被过滤并不等于只增加两个小按钮的渲染成本。— [Glass-HQ 实现](https://github.com/Glass-HQ/liquid-glass/blob/main/src/dom/index.ts)、[React scene 包装](https://github.com/Glass-HQ/liquid-glass/blob/main/src/react/scene.tsx)
- Glass-HQ 的当前场景适配限制包括 Safari 滚动/overflow 对齐与表面更新问题（本项由并行研究者核验，未在此分工独立复现），因此它适合隔离 POC 而不应直接承诺生产可用。— [issue 8](https://github.com/Glass-HQ/liquid-glass/issues/8)、[issue 9](https://github.com/Glass-HQ/liquid-glass/issues/9)
- 不建议把整个聊天持续截成纹理交给 WebGL：为了三个 action 引入另一套聊天绘制与同步系统，维护和滚动成本难以匹配收益。若没有稳定的 Safari 背景采样路径，保持 CSS 基线比展示与真实内容脱节的“折射”更合适。
- 限定选择器为移动端 `.topbar .menu-btn` 与 `.top-actions`，避免修改全局 `.icon-btn`。专家与更多共享一块材质，内容层保持清晰，避免把图标一起过滤。

### Gaps
- 本分工没有独立审查第三方折射库的完整代码；Glass-HQ 技术事实引用并行研究者已核验的 primary sources，详细限制以对应库研究笔记为准，不能将其列为本项目已验证方案。
- 状态栏实色薄层与按钮行透明 overlay 能否同时满足各版本 iOS，需真机验证，不可从 WebKit 对 Safari 工具栏的说明外推 PWA 具体行为。

## 最小原型与 iPhone 验收应覆盖什么？

### Takeaway
先用同一场景对比当前版、CSS 改善版、带折射实验版，并看滚动录像。现有 Chromium 手机 viewport 回归只能证明交互未损坏，不能证明 iPhone 的光学效果或 PWA 状态栏正确。

### Cited Findings
- 当前浏览器测试使用 Chromium，viewport 390×850，isMobile/hasTouch，serviceWorkers 禁用，测试 HTML 没有正式页面的 PWA meta。— [web-sidebar.browser.mjs:18](/home/ubuntu/project/agent-loft/test/web-sidebar.browser.mjs:18)、[web-sidebar.browser.mjs:86](/home/ubuntu/project/agent-loft/test/web-sidebar.browser.mjs:86)
- 左侧菜单已有 44×44 CSS px，右侧每个子按钮当前为 42×42；reduce-motion 只关闭 transition，但 active 状态仍会立即 scale(0.96)。reduce-transparency 当前将 fill 设实色并关闭滤镜。— [mobile.css:45](/home/ubuntu/project/agent-loft/web/css/mobile.css:45)、[mobile.css:57](/home/ubuntu/project/agent-loft/web/css/mobile.css:57)、[mobile.css:66](/home/ubuntu/project/agent-loft/web/css/mobile.css:66)
- Apple 按钮指南一般建议至少 44×44 pt 触摸区域，并要求自定义按钮有按压状态。这里是原生平台建议；Web 实施可参考 44×44 CSS px，再在实际设备确认尺寸与间距。— [Apple HIG: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
- Media Queries 5 草案定义减少透明效果和减少不必要运动的用户偏好；是否跟随具体 iOS 设置需要实际浏览器实现配合。— [Media Queries 5 §12](https://www.w3.org/TR/mediaqueries-5/#mf-user-preferences)

### Inferences
以下为建议的验收矩阵（未执行，不是测试结果）：

| 维度 | 最小场景 | 通过条件 |
| --- | --- | --- |
| 环境 | 用户真实 iPhone 当前 iOS Safari；同机添加到主屏幕 standalone；项目仍支持的旧 iOS Safari；一台较旧/60Hz iPhone | 每个环境记录 OS/build，CSS fallback 可用；不以桌面 WebKit/Chromium 冒充 iOS 真机 |
| 配色 | 浅色、深色各跑全部核心场景 | 黑白图标与标题可读；深色不变成发白塑料，浅色不靠大黑投影伪造轮廓 |
| 光学证据 | 黑白文字、窄色带、图片边缘从两块玻璃后滚过；另测空白欢迎页 | 若声称折射，边缘应有稳定可见位移/弯折且跟随真实内容；纯色时自然弱化，不加假纹理掩盖问题 |
| 滚动 | 顶部、往上翻历史、快速惯性滚动、底部、消息自动跟随 | 无漏色、闪白、重影、内容错位；无明显新增卡顿；与当前基线对比短录像与 Web Inspector 时间线 |
| 流式 | 长文本连续输出、代码块、SVG 图表、相册迟加载 | 玻璃与原背景同步，无旧帧/内容跳跃；离开页面或隐藏不持续无意义绘制 |
| PWA 安全区 | 冷启动、后台返回、旋转横竖屏、刘海/Dynamic Island、开关侧栏 3 次、键盘显隐 | 状态栏不被遮罩永久染暗，无系统双重模糊、顶部黑/白缝，按钮不跑入安全区 |
| 交互 | 分别点击左菜单、专家、更多；打开 popover 再滚动；快速连点 | 保留原 handlers 与定位；装饰不拦截触摸；右侧每个 action 建议至少 44×44 CSS px |
| 可访问性 | 系统减少透明/减少动态效果各开关；提高对比；VoiceOver、键盘 focus | 透明降低后为实色可读材质；reduce-motion 也取消 active 缩放，换非移动按压态；仅朗读真实按钮、焦点环清楚 |
| 布局 | 320/375/390/430 CSS px；无标题、短标题、50 汉字长标题；专家缺失/仅更多；文字放大 | 标题省略，按钮组不压缩/换行；左右 hit areas 不重叠；桌面样式保持已有行为 |
| 宿主 | 多服务器 iframe 嵌入 | 外壳注入 safe-area 后无重复顶端留白，玻璃不会采样到错误页面或丢背景 |

- 原型不用接生产服务：现有 fixture 可供回归交互，但真机展示应带正式 meta/manifest，并有可复现的静态消息场景。用功能开关切换 A/B；用性能对照决定是否值得接折射层。
- 验收应写清楚哪些效果在 Safari 是真正的背景位移，哪些只是装饰性高光；“支持 CSS 语法”与“光学效果真正渲染”是不同结论。

### Gaps
- 本次只做研究与代码阅读，没有修改产品、运行截图或新增测试，也没有给出任何性能提升、帧率或原生相似度百分比。
