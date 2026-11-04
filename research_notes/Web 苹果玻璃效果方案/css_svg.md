# CSS / SVG 苹果玻璃效果：iPhone Safari 与 PWA（研究日期 2026-11-02）

## 1. backdrop-filter 模糊与 SVG 位移折射在 Safari 是否真正可用？

### Takeaway
普通背景模糊可用，但不能把“支持 backdrop-filter”推导成“支持 backdrop-filter:url(#svgFilter) 折射任意实时页面”。截至本次查阅，WebKit 对 SVG backdrop 引用的缺陷仍是 NEW，修复 PR 尚未合并；iPhone 为主要目标时，应把这种折射路径当作不可依赖的增强功能，保留完整 CSS 基础外观。

### Cited Findings
- WebKit 官方 Safari 18.0 说明确认标准 backdrop-filter 无需前缀，并列举 blur、brightness、contrast、saturate 等函数；这是函数支持声明，不是 SVG URL 引用全部可用的声明。为覆盖旧 Safari 可同时保留 -webkit-backdrop-filter。— [WebKit Safari 18](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)
- WebKit bug 245510 于 2022 年报告，2026-09-05 最后更新，查阅时仍 NEW。问题正是 backdrop-filter:url(#...) 引用 feDisplacementMap 等滤镜不产生预期效果，已有 macOS/iOS 重现记录。— [WebKit 245510](https://bugs.webkit.org/show_bug.cgi?id=245510)
- 2026 年 Safari 26 测试追踪明确写道，WebKit 会静默丢弃包含 url() 引用的 backdrop-filter 链。— [WebKit 317059](https://bugs.webkit.org/show_bug.cgi?id=317059)
- 提议实现 PR #68614 查阅时仍 Open。说明解释 Core Animation 不能直接处理 reference filter，而此前没有软件回退；提议通过软件重绘捕获视图根再过滤。补丁列出的未解决条件包括子 frame 不捕获、旋转/缩放只采样轴对齐区域，以及加速动画背景只有在元素重绘时更新。此处是提议实现的限制，不能当作已经发布的浏览器特性。— [WebKit PR 68614](https://github.com/WebKit/WebKit/pull/68614)
- Filter Effects Level 2 草案定义的模型是复制 Backdrop Root Image、依序过滤、按含圆角的边框裁剪，然后绘制元素自身。它允许 filter reference 以上一步输出为 SourceGraphic；这只是规范目标，不意味着引擎已实现。— [Filter Effects 2](https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty)

### Inferences
- 高置信度：不能对用户说“装一个 SVG 玻璃库就能让 iPhone 的两个按钮折射实时聊天背景”；应先说明库到底操作 backdrop，还是自己拥有的 content。
- 高置信度：standalone PWA 没有理由绕过同一 WebKit 渲染能力缺口；本次未发现独立 PWA 可开启 SVG backdrop refraction 的平台接口。此处是由 WebKit 渲染路径得出的推断，非逐个 iOS 版本真机验证。
- 中高置信度：如果 CSS 的基础 blur 声明被后面的含 url() 的声明覆盖，而后者被静默丢弃，可能连原有磨砂效果也失去。因此不能只写 @supports 判断后无条件升级。

### Gaps
- 没有该用户 iPhone 的准确 iOS/Safari 版本，也没有真机渲染和滚动帧率数据。缺陷 NEW 和 PR Open 足以否定“已普遍可靠支持”，不足以断言所有未来/实验版本均不支持。
- 本次不把 PR 的 trunk GPU crash 讨论渲染成“发布版 Safari 必崩”；这需要特定版本验证。

## 2. filter:url() 对内容折射能否绕开 Safari？CSS.supports 测试够不够？

### Takeaway
有实用的新路线：把 SVG 位移滤镜加在受控内容本身，而不是按钮 backdrop；它可以在 Safari 工作。但它需要拥有、包装或复制被折射内容，不能自动捕获任意兄弟 DOM。CSS.supports 只能作为语法/声明支持门槛，不能代替对折射像素是否真正输出的验证。

### Cited Findings
- Aave Labs 自己的技术文章明确说，其方法不是采样玻璃下面的背景，而是移动内容自己的像素。PNG 位移图的 R/G 控制 X/Y，透镜外中性，保留文本与链接的 DOM 行为。文章称可跨桌面与移动浏览器，另指出 Safari 需更换 filter ID 处理缓存、限制源图尺寸，避免块状或丢失效果。— [Aave: Building Glass for the Web](https://aave.com/design/building-glass-for-the-web)
- 原作者实现 @samasante/liquid-glass 明确使用 filter:url() on wrapped element，而不是 backdrop-filter:url()；其测试说明为 Playwright Chromium/WebKit，且 Safari 不启用 2x 超采样，避免大源图使高成本色散/高光 pass 消失。作者的 WebKit 测试不是本项目真机 iPhone 验证。— [samasante BROWSERS.md](https://raw.githubusercontent.com/samasante/liquid-glass/main/BROWSERS.md)
- Vanilla 库 @liquidglassjs/core 的 README 对范围区分得很清楚：refract 指定的 live DOM 用 filter:url()；指定 behind 为 sibling main 时，Firefox 可用 -moz-element，Chromium 用 SVG backdrop，WebKit 仍为 frosted；CSS 背景可以用 viewport-locked clone 过滤。作者强调 Safari/Firefox 会解析 SVG backdrop 声明却不正确绘制。— [liquid-glass-js README](https://raw.githubusercontent.com/Amir-Abushanab/liquid-glass-js/main/README.md)
- CSS Conditional 3 的支持定义是接受声明而不把它当作 parse error；规范要求 usable support，但检测器并不捕捉一次实际场景的像素输出来判定。WebKit 317059 的静默丢弃即是这一场景的实际反例。— [CSS Conditional 3 §6.1](https://drafts.csswg.org/css-conditional-3/#support-definition); [WebKit 317059](https://bugs.webkit.org/show_bug.cgi?id=317059)

### Inferences
- 高置信度：CSS.supports('backdrop-filter','url(#glass)') 返回 true，甚至 getComputedStyle 保留该文本，都不能证明目标浏览器的 feDisplacementMap backdrop 在绘制。应通过真实渲染对照图测试（例如高对比条纹/文字在按钮边缘的位移），并在 Safari 真机中重复滚动、键盘弹出、浅深色和独立 PWA 模式。
- 中置信度：在当前顶栏上，可探索对顶栏后方一小片受控背景制作副本并精确同步滚动、主题、尺寸，再在副本上用 filter:url()，按钮图标叠在上方保持清晰。但聊天是动态流式 DOM，复制整份消息树会引入同步、选择、无障碍、尺寸和性能成本；不建议为了两个小按钮先过滤整份聊天内容。
- 中置信度：如果顶部原本是不透明纯色，位移的是几乎均匀颜色，折射视觉信息本来就很少；先让内容滚动到真实透明顶栏后方，才可能看见折射。这是光学/渲染推断，需要对当前布局核对。
- 高置信度：若将已有聊天容器整体 filter:url()，要把“改变容器绘制”与“在按钮后面局部采样”区分开；不能简单替换一个 CSS 属性就获得相同语义。

### Gaps
- 未在项目中安装或验证上述库，也不建议将其 README 的宣传当作生产质量保证。它们是技术路线证据，正式使用前仍需源码审查、生命周期/尺寸响应与真机耗时检查。
- 浏览器没有本次可确认的通用网页 API 允许脚本无条件截图任意 live DOM 为实时 GPU 纹理；相邻研究可能覆盖 HTML-in-Canvas 与 WebGL 路线。

## 3. 苹果玻璃的关键外观及本项目的实用建议？

### Takeaway
关键差别是有形状的透镜折射、随内容变化的明暗/颜色、高光和交互动作共同工作，不是单纯加大 blur。对当前两个顶部控件，应先用精细分层 CSS 建立可靠的轻透玻璃，再单独验证局部 SVG content-refraction 原型，避免把“Chrome 演示很像”当成“iPhone 已实现”。

### Cited Findings
- Apple 的 Meet Liquid Glass 将 lensing 定义为主要识别特征：实时弯折、塑形和集中光；交互会使材质弯曲并亮起，颜色、阴影和动态范围随着内容变化以保持可读性；更大形态会表现更厚、阴影更深、折射更多。— [Apple WWDC25: Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)
- feDisplacementMap 的规范计算是 P'(x,y)=P(x+scale*(XC-.5),y+scale*(YC-.5))；它本质是按映射移动已经绘制的像素，可在 buffer 上产生非局部效果，需要缓冲。它本身并非 Apple 的原生材质。— [Filter Effects 1 §9.11](https://drafts.csswg.org/filter-effects-1/#feDisplacementMapElement)
- 作者 kube 的基于形状/曲面模拟演示区分 refraction 与 specular rim，并明确整体 backdrop 演示仅 Chrome 支持；该文声明目标是近似、不是像素级重现 Apple。— [kube: Liquid Glass in the Browser](https://kube.io/blog/liquid-glass-css-svg/)

### Inferences
- 推荐路线（中高置信度）：1）维持本轮范围：左侧栏按钮，右侧专家+更多一个胶囊；2）可靠层用低不透明度 tint、适量 blur/saturate、窄且方向性的双层边缘高光、柔和外影/内沿，图标独立清晰层，触摸时短暂压缩/提亮；3）将 SVG 局部内容折射作为可关闭的实验，真正比较 iPhone Safari/PWA 对滚动聊天的表现；4）如果代价是全聊天树过滤/频繁快照，则在 iPhone 保留精细 CSS，不能宣称与原生相同。
- 推荐验收（高置信度）：至少同一 iPhone 上用静态和滚动视频对比，而不仅看一张截图；覆盖浅/深色、纯色与复杂消息在按钮后穿过、点击 hit target、流式回复、键盘升降和 reduced-motion。
- 不应承诺百分比“像原生 90%”或固定 FPS；本次没有这样的可量化证据。

### Gaps
- 没有 Apple 开放给普通网页 button 的 Liquid Glass 原生 API 的证据；本研究聚焦 CSS/SVG，原生壳与系统组件边界由协调者其他部分补充。
- 尚未审核现有 CSS 精确色值、顶栏是否遮住聊天背景；因此参数建议是方向，不是经设备验证的最终样式。
