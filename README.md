# Paper Parallel

Paper Parallel 是一个面向学术论文的浏览器端翻译、排版与双语对照阅读项目。英文 PDF 始终保持原样；中文 PDF 按 `zh-single-column-v1` 固定重排为适合连续阅读的单栏，同时原样复用论文中的图、表、公式和代码，并提供真实双 PDF 对照阅读。

## 当前实现状态

新的产品流程已经替换旧探针入口，包含三个路由：

1. 上传与设置：选择英文 PDF、测试 DeepSeek 连接并创建本地任务。
2. 翻译与排版：显示八阶段进度、预计剩余时间、AI 任务日志、论文预览与安全停止。
3. 对照阅读：加载真实英文/中文 PDF，支持独立页码与缩放、同步滚动、语义组高亮、结果与项目包下载。

当前生产流程已接通 PDF.js 解析、带版本的 Vision 页面计划、PDF.js 本地几何验证、最多两轮受限视觉补丁、DeepSeek 批量翻译与校验、不可变图形/公式裁切、浏览器本地 Typst WASM 单栏编译、连续语义组对齐、内容门禁、Vision Exp 逐页终审和 IndexedDB 恢复。源页面补丁只能修改验证器明确放行的失败字段，已通过区域会锁定；视觉终审发现可安全修复的排版问题时，系统最多自动修复并重新编译两轮；内容丢失、公式/表格变化等问题会立即停止。

源版式缓存分为原始响应、纠错补丁、恢复计划和最终采用计划四层。网络/渲染重试、源版式纠错、确定性结构错误和最终 PDF 排版修复分别记录；失败页重分析会按依赖图失效对应页面及跨页组，不删除身份未变化的译文缓存。任务页可以导出源版式诊断和结构门禁诊断。

旧任务缺少当前排版版本时会显示“旧版排版”。“按新版重新排版”只重建中文 PDF、Typst、预览、对齐、质检报告和项目包，保留英文 PDF、已校验译文以及 Vision/公式缓存。

当前仍需持续扩充的边界能力：

- 扫描件/OCR（当前要求 PDF 具有可用文字层）；
- 极端跨页表格、嵌套浮动体和非常规页眉页脚（普通跨页资产已建立文档级关系与一致性门禁）；
- 更多公开论文版式的回归夹具。

只有翻译块、受保护内容、中文 PDF、不可变资产、对齐映射与逐页视觉终审全部通过检查后，应用才允许显示“处理完成”并进入阅读器。失败任务保留逐页 `quality-report`，不会带严重问题自动进入阅读器。

## DeepSeek 设置

- 连接测试先调用 `/models` 获取账户实际可用模型。
- “正文翻译模型”由用户从账户可用模型中选择；它只负责自然语言翻译。
- 源版式分析、受限纠错和最终逐页质检固定使用 `deepseek-v4-flash-vision-exp`，不会随正文模型选择而改变；账户缺少该模型时连接测试明确失败。
- 当前项目的 V4 回退列表包含 `deepseek-v4-flash`、`deepseek-v4-pro` 和 Vision Exp。
- 思考模式是独立开关，不通过更换模型 ID 实现。
- 不支持旧的 `deepseek-chat` 或 `deepseek-reasoner` ID。
- 自动测试使用注入的模拟响应，不使用真实 API Key，也不会产生真实调用费用。

## 本地开发

需要 Node.js 和 npm。PowerShell 中运行：

```powershell
npm install
npm run dev
```

完整检查：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:browser
```

也可以使用仓库内脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\check.ps1
```

## 本地数据与隐私

- PDF、任务快照、已校验译文和对齐数据保存在当前浏览器的 IndexedDB。
- API Key 只有在用户明确勾选后才写入当前浏览器的 localStorage。
- API Key 不写入 IndexedDB 项目记录、下载项目包、URL、AI 日志或 GitHub 仓库。
- Paper Parallel 不上传或集中保存原始 PDF；翻译请求发送所需文本，版式识别和逐页终审会按页面发送临时渲染图给 DeepSeek Vision Exp。
- “安全停止”会取消活动请求，但保留已经通过校验的翻译缓存。
- “清除翻译缓存”只删除当前论文译文，不删除原始 PDF，也不影响其他任务。

## 设计与实施文档

- [浏览器排版与阅读器设计](docs/superpowers/specs/2026-08-24-paper-parallel-browser-typesetting-reader-design.md)
- [应用与翻译工作流计划](docs/superpowers/plans/2026-08-24-app-and-translation-workflow.md)
- [版式、资产与浏览器 Typst 计划](docs/superpowers/plans/2026-08-24-layout-assets-and-browser-typst.md)
- [对齐、阅读器与部署计划](docs/superpowers/plans/2026-08-24-alignment-reader-and-deployment.md)
- [中文单栏正式工作流](docs/SINGLE-COLUMN-LAYOUT-WORKFLOW.md)
- [最终验收手册](docs/FINAL-TEST-RUNBOOK.md)

旧 `probes/` 文件仅作为仓库内历史回归夹具保留，不会复制到生产构建或 GitHub Pages。
