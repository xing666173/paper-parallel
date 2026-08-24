# Paper Parallel

Paper Parallel 是一个面向学术论文的浏览器端翻译、排版与双语对照阅读项目。目标是在不依赖自有服务器、也不要求用户安装 XeLaTeX 或 Typst 的条件下，将英文 PDF 转换为继承原论文栏型与技术资产的中文 PDF，并提供真实双 PDF 对照阅读。

## 当前实现状态

新的产品流程已经替换旧探针入口，包含三个路由：

1. 上传与设置：选择英文 PDF、测试 DeepSeek 连接并创建本地任务。
2. 翻译与排版：显示八阶段进度、预计剩余时间、AI 任务日志、论文预览与安全停止。
3. 对照阅读：目前是受完成门禁保护的占位页。

阶段一已经完成任务状态、IndexedDB 缓存、DeepSeek V4 客户端、通用翻译协议、连续语义组对齐数据、术语表、批处理、重试、停止与恢复基础。

以下能力仍在后续实施阶段，当前网页不会假装已经完成：

- 原 PDF 的单栏、双栏和混合区域识别与不可变资产提取；
- 浏览器 Typst WASM 中文排版与真实中文 PDF 编译；
- 英文/中文真实 PDF 的句子候选、连续语义组对齐与同步阅读；
- 使用真实论文完成端到端回归并替换 GitHub Pages 线上版本。

只有翻译块、受保护内容、中文 PDF、不可变资产、对齐映射与本地持久化全部通过检查后，应用才允许显示“处理完成”并进入阅读器。

## DeepSeek 设置

- 连接测试先调用 `/models` 获取账户实际可用模型。
- 当前项目的 V4 回退列表为 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
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
npm test
npm run build
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
- Paper Parallel 不上传原始 PDF；调用翻译接口时只应发送需要翻译的文本和必要上下文。
- “安全停止”会取消活动请求，但保留已经通过校验的翻译缓存。
- “清除翻译缓存”只删除当前论文译文，不删除原始 PDF，也不影响其他任务。

## 设计与实施文档

- [浏览器排版与阅读器设计](docs/superpowers/specs/2026-08-24-paper-parallel-browser-typesetting-reader-design.md)
- [应用与翻译工作流计划](docs/superpowers/plans/2026-08-24-app-and-translation-workflow.md)
- [版式、资产与浏览器 Typst 计划](docs/superpowers/plans/2026-08-24-layout-assets-and-browser-typst.md)
- [对齐、阅读器与部署计划](docs/superpowers/plans/2026-08-24-alignment-reader-and-deployment.md)

旧 `probes/` 文件仍作为历史回归夹具保留，但不再作为产品页面或生产路由。
