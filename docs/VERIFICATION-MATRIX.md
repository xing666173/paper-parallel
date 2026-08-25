# 需求验证矩阵(R1–R15)

| 需求 | 实现模块 | 浏览器探针证据 | 自动化测试 |
|---|---|---|---|
| R1 纯静态 GitHub Pages,无账号 | vite base './' + hash router + CI 工作流 | P19 以 file:// 直接运行 | build 脚本 |
| R2 用户自配 DeepSeek Key | SetupView / P19 / client.ts | P1 自动测试页 | client.spec |
| R3 左侧英文原件/右侧中文 PDF | ReaderView 双栏渲染 | P15 | reader.spec |
| R4 版式继承(单/双/混合,页数延伸) | PDF.js 区域 + Vision Exp 协调 + Typst | 真实论文逐页截图 | parser / visionReconcile / typstProject / browser |
| R5 块级保序 + 图表钉在相邻正文间 | paginator 左栏关闭规则 | P3 块序校验 | paginator.spec |
| R6 用户提示词原文 + 最小包装 | prompts/translation.json + session buildUserPrompt | P11 前缀完整性 | session.spec |
| R7 按块翻译(图/表/公式不过模型) | session/pipeline | P10/P18 | pipeline.spec / e2e |
| R8 图/表/公式原样保留 | Vision Exp 候选 + 本地几何门 + 原始裁图 | 最终逐页 Vision/人工复核 | assetGeometryGate / visionReconcile / assets |
| R9 场景A直出对齐 + 场景B锚点/人工校准 | alignBlocks.core.js | P13 / P19 场景B | alignBlocks.spec |
| R10 锚点反查同步 + 同步锁 + 词级 span 校验 | reader.core.js + align.core.js | P12/P14/P15 | reader.spec / align.spec |
| R11 二次审核三关 + 门禁 | 翻译保护校验 + PDF 内容门 + 对齐门 + Vision Exp 逐页复核 | 失败不持久化/不跳转 | finalPersistence / pdfContentGate / visionFinalReview |
| R12 中文 PDF 下载 + 项目包 | 浏览器 Typst TTF 编译 + Reader 下载 | 浏览器下载后 PDF.js 再检查 | typst-smoke / full-workflow / final-pdf-quality |
| R13 本地优先(IndexedDB/localStorage) | dexie 依赖 + localStorage Key | P1/P19 Key 存储 | —(集成待接入) |
| R14 术语表自动抽取与注入 | pipeline extractTerms + session | P10/P11/P18 | pipeline.spec |
| R15 降级优先(句→段→章) | align level fallback + audit warn | P12 fallback | align.spec |

## 端到端证据

- `tests/browser/full-workflow.spec.ts`：mock DeepSeek 下上传、Vision 两阶段、翻译恢复、Typst、质量门、阅读器、PDF 下载闭环。
- `tests/browser/final-pdf-quality.spec.ts`：真实 ZK-Tracer + 真实 API 的 Flash/Exp 两条发布验收；证据写入忽略的 `reports/real-api/`。
- 发布前必须人工查看 `reports/real-api/<model>/page-*.png` 的每一页，不能只依赖模型结论。
