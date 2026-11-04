# 让移动端顶部玻璃更接近苹果原生

**Web 能模拟 Liquid Glass 的透镜效果，但 iPhone Safari 不能直接依赖常见的 SVG 背景折射方案。** 对 Agent Loft，建议保留精细 CSS 作为可靠基础，另做 Glass-HQ 的隔离原型，验证真实聊天内容能否在两块玻璃后稳定折射。范围保持左上侧栏按钮，以及右上「专家＋更多」共享胶囊。无需迁移 React，也不应为了按钮重建聊天渲染系统。本次结论来自官方资料、库文档和源码，查阅日期为 **2026-11-02**；未修改产品，未在真实 iPhone 测量效果、帧率或能耗。

## 差距来自透镜与背景，继续加模糊解决不了

Apple 将随背景变化的透镜弯折、边缘光与交互形变视为材质的重要特征，因此普通 blur 加高光只能提供磨砂外观。当前项目按钮行后方是大面积不透明顶栏，PWA 又采用实色 sticky 顶栏，消息不会穿过按钮区域；即使增加折射，均匀背景也缺少可见变化。需要先验证按钮后真正能看见聊天内容，同时保护现有 PWA 状态栏实色修复，不能直接删除安全区遮挡层。（[Apple 材质说明](https://developer.apple.com/videos/play/wwdc2025/219/)、[顶栏实现](/home/ubuntu/project/agent-loft/web/css/topbar.css:32)、[移动端材质](/home/ubuntu/project/agent-loft/web/css/mobile.css:23)）

## Safari 的关键边界是背景采样

Safari 支持普通 `backdrop-filter: blur()`，不代表支持 `backdrop-filter: url(#svg)`。后者的 WebKit 缺陷截至查阅仍为 **NEW**，实现 PR #68614 仍为 **Open**；不能据此承诺 iPhone 已能折射任意实时页面。`CSS.supports()` 通过也不能代替观察实际像素。普通 `filter:url()` 处理自己拥有的内容，是另一条路线，不能与背景采样混同。（[Safari 18 说明](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/)、[缺陷 245510](https://bugs.webkit.org/show_bug.cgi?id=245510)、[实现 PR](https://github.com/WebKit/WebKit/pull/68614)、[Safari 静默丢弃记录](https://bugs.webkit.org/show_bug.cgi?id=317059)）

| 路线 | 接近原生的能力 | iPhone 边界与成本 |
| --- | --- | --- |
| 分层 CSS | 透明、模糊、窄边高光、按压反馈；没有真实折射 | 接入最低；适合默认效果和降级 |
| SVG 背景位移 | 可弯折背后文字与图片 | Safari 的 backdrop URL 路径不可依赖 |
| SVG 过滤真实内容 | 能对登记内容做局部透镜位移 | 需调整内容场景与滚动包装，过滤大内容层有成本 |
| WebGL 图片／视频／canvas | 可计算更丰富的光学效果 | 已知纹理适合；不能直接获得任意聊天 DOM 像素 |
| WebGPU 材质图＋SVG | GPU 生成位移／高光贴图，SVG 过滤真实 DOM | Safari 26 有 WebGPU，仍须处理 adapter 失败与实机性能 |

GPU 不是自动截图网页的接口。已有 WebGL 实现通过 `texImage2D` 上传图片、视频或 canvas；把动态聊天转换成纹理会增加同步与可访问性工作。Safari 26 的 WebGPU 支持只证明 API 基础存在，不证明具体玻璃库已通过设备验证。（[WebGL 源码](https://github.com/gentpan/liquidglass/blob/main/lib/glass-webgl.js)、[Safari 26 发布说明](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes)）

## 三个候选中，Glass-HQ 最值得做原型

**Glass-HQ / `@glass-sdk/liquid-glass`：机制最匹配，但尚不能直接选为生产方案。** 它提供 vanilla DOM API，以 WebGPU 生成材质图，再把 SVG filter 加在登记的真实 DOM 内容上；不是截图或克隆整份聊天。Safari 滚动需要额外的 `foreignObject` 场景包装，大内容层过滤成本也有明确警告。包仍有依赖与 React peer dependency，需单独核对最终构建。2026-10-30 提交的 issue #8、#9 截至查阅仍开放，分别报告 Safari 越界内容错位和动态 surface 不重绘；均为用户报告，本次未复现。（[包说明](https://github.com/Glass-HQ/liquid-glass/blob/main/packages/liquid-glass/README.md)、[真实 DOM 实现](https://github.com/Glass-HQ/liquid-glass/blob/main/packages/liquid-glass/src/dom/index.ts)、[滚动包装](https://github.com/Glass-HQ/liquid-glass/blob/main/packages/liquid-glass/src/react/scene.tsx)、[依赖](https://github.com/Glass-HQ/liquid-glass/blob/main/packages/liquid-glass/package.json)、[issue #8](https://github.com/Glass-HQ/liquid-glass/issues/8)、[issue #9](https://github.com/Glass-HQ/liquid-glass/issues/9)）

**liquidglass.dev：适合已知图片背景，不解决本项目 Safari 聊天折射。** 官方兼容表明确：图片背景可折射，任意 DOM 在 Safari 降级为磨砂。**rdev/liquid-glass-react：本项目不推荐。** README 明示 Safari/Firefox 看不到 displacement，接入 React 也不能补上这项能力。（[liquidglass.dev 兼容表](https://liquidglass.dev/)、[rdev README](https://github.com/rdev/liquid-glass-react)）

## 下一步用真机决定折射是否值得接入

建议做可切换的 CSS 基础版与 Glass-HQ 实验版：保留实际按钮、标签和点击处理，将左按钮与右胶囊注册为两个固定 surface，图标保持清晰；限定背景场景，避免无边界过滤长聊天。若必须过滤整片消息区，两个按钮很小也不代表总成本很小。实验先验证 Safari/PWA 的背景层、滚动与现有 `fitSpacer()`，再考虑材质细调；失败时自动回到 CSS。（[场景限制](https://github.com/Glass-HQ/liquid-glass/blob/main/packages/liquid-glass/README.md)、[消息定位](/home/ubuntu/project/agent-loft/web/views/messages.js:235)）

以下是**待执行验收**，不是已有测试结果：

| 真机维度 | 接受条件 |
| --- | --- |
| 同一 iPhone 的 Safari 与主屏幕 PWA，另含较旧设备 | 记录 iOS 版本；不支持 GPU 时 CSS 正常 |
| 浅／深色，文字、窄色带、图片从玻璃后滚过 | 折射跟随真实内容；以滚动录像确认位移，纯色截图不算证据 |
| 惯性滚动、流式回复、代码块与图片迟加载 | 无错位、旧帧、闪白；与基线比较录屏及性能时间线 |
| 键盘显隐、旋转、后台返回、iframe 与安全区 | 状态栏无染暗或缝隙，按钮与弹层定位正常 |
| 三个操作、文字选择、VoiceOver、减少透明／动态效果 | 点击与阅读正常，降级可读，无多余动画 |

只有真实 iPhone 上的动态背景与交互都通过，才值得把折射层接到项目。若成本或稳定性不合适，精细 CSS 是可交付的玻璃外观，但应明确它与原生透镜材质仍有差距。
