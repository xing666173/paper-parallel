# 需求验证矩阵(R1–R15)

| 需求 | 实现模块 | 浏览器探针证据 | 自动化测试 |
|---|---|---|---|
| R1 纯静态 GitHub Pages,无账号 | vite base './' + hash router + CI 工作流 | P19 以 file:// 直接运行 | build 脚本 |
| R2 用户自配 DeepSeek Key | SetupView / P19 / client.ts | P1 自动测试页 | client.spec |
| R3 左侧英文原件/右侧中文 PDF | ReaderView 双栏渲染 | P15 | reader.spec |
| R4 版式继承(单/双/混合,页数延伸) | paginator.core.js | P3 三版式 + P8 共享模块 | paginator.spec |
| R5 块级保序 + 图表钉在相邻正文间 | paginator 左栏关闭规则 | P3 块序校验 | paginator.spec |
| R6 用户提示词原文 + 最小包装 | prompts/translation.json + session buildUserPrompt | P11 前缀完整性 | session.spec |
| R7 按块翻译(图/表/公式不过模型) | session/pipeline | P10/P18 | pipeline.spec / e2e |
| R8 公式裁图/表格重建降级 | P6 区域检测 + P9 占位渲染 | P6 断言 | regions.spec |
| R9 场景A直出对齐 + 场景B锚点/人工校准 | alignBlocks.core.js | P13 / P19 场景B | alignBlocks.spec |
| R10 锚点反查同步 + 同步锁 + 词级 span 校验 | reader.core.js + align.core.js | P12/P14/P15 | reader.spec / align.spec |
| R11 二次审核三关 + 门禁 | audit.core.js + review.core.js | P16/P17 | audit.spec / review.spec |
| R12 中文 PDF 打印导出 + 项目包 | P9 打印渲染 + review 项目包 | P2/P9/P17/P19 | layout.spec / review.spec |
| R13 本地优先(IndexedDB/localStorage) | dexie 依赖 + localStorage Key | P1/P19 Key 存储 | —(集成待接入) |
| R14 术语表自动抽取与注入 | pipeline extractTerms + session | P10/P11/P18 | pipeline.spec |
| R15 降级优先(句→段→章) | align level fallback + audit warn | P12 fallback | align.spec |

## 端到端证据

- P18 合成论文全链路 ALL-PASS(翻译→分页→对齐→审核→门禁→项目包)
- P19 场景 A / 场景 B 合成演示均通过
- 真实 ZK-Tracer 测试:待用户执行 `scripts/final-test.ps1`(结果自动写入 reports/)
