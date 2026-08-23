# Paper Parallel —— 论文双子
中英双语 PDF 对照阅读器(纯静态 GitHub Pages)。左栏英文原文,右栏中文译文;双向同步滚动、句级/词级联动高亮。

## 当前状态(构建中)

| 里程碑 | 状态 |
|---|---|
| 需求与架构冻结 | ✅ 已完成(见 `docs/` 与对话记录) |
| 仓库骨架 | ✅ 已建 |
| Sprint 0 · P3 块级分页器探针 | ✅ 已通过双栏/单栏/混合三种版式回归(见 `probes/P3-report.md`) |
| Sprint 0 · P1 CORS 探针 | ✅ UI/判定逻辑已建并通过截图 debug;真实连通性待你填 Key 点一次(见 `probes/P1-report.md`) |
| Sprint 0 · P2 打印文字层探针 | ✅ 预览已通过截图 debug;打印 PDF 文字层待与 P4 联测(见 `probes/P2-report.md`) |
| Sprint 0 · P4 PDF.js 文字层探针 | ✅ 核心算法已通过离线演示数据 debug(16 行,mixed);真实 PDF 待你本机运行(见 `probes/P4-report.md`) |
| Sprint 1 · 解析器核心 | ✅ P5 探针合成夹具断言通过;TS 模块 + Vitest 已落地,待你本机 `check.ps1` 复核(见 `probes/P5-report.md`) |
| Sprint 1 · 图/表区域 + charRects | ✅ P6 探针 6 项断言通过;TS 模块 + Vitest 已落地,待你本机 `check.ps1` 复核(见 `probes/P6-report.md`) |
| Sprint 1 · 跨页装配 DocBuilder | ✅ P7 探针 8 项断言通过;TS 模块 + Vitest 已落地,待你本机 `check.ps1` 复核(见 `probes/P7-report.md`) |
| Sprint 2 · 分页器核心 | ✅ 共享模块浏览器实测三种版式 PASS;Vitest 已落地,待你本机 `check.ps1`(见 `probes/P8-report.md`) |
| Sprint 2 · 打印导出渲染器 | ✅ P9 浏览器实测 AUDIT=PASS;TS layout + Vitest 已落地(见 `probes/P9-report.md`) |
| Sprint 3 · 翻译管线核心 | ✅ P10 mock LLM 全流程 ALL-PASS;TS 客户端 + Vitest 已落地(见 `probes/P10-report.md`) |
| Sprint 3 · 提示词组装 + 断点续跑 | ✅ P11 浏览器实测 ALL-PASS;TS + Vitest 已落地(见 `probes/P11-report.md`) |
| Sprint 4 · 对齐引擎核心(句级DP/span/降级) | ✅ P12 浏览器实测 ALL-PASS;TS + Vitest 已落地(见 `probes/P12-report.md`) |
| Sprint 4 · 场景B 锚点+块级对齐+人工校准 | ✅ P13 浏览器实测 ALL-PASS;TS + Vitest 已落地(见 `probes/P13-report.md`) |
| Sprint 5 · 对照阅读器核心(同步/锁/词定位) | ✅ P14 浏览器实测 ALL-PASS;TS + Vitest 已落地(见 `probes/P14-report.md`) |
| Sprint 5 · 双栏阅读器 UI | ✅ P15 自动演示通过;ReaderView.vue 已落地(见 `probes/P15-report.md`) |
| Sprint 6 · 规则自动审核 | ✅ P16 浏览器实测 ALL-PASS;TS + Vitest 已落地(见 `probes/P16-report.md`) |
| Sprint 6 · AI复审/人工门禁/项目包/部署 | ✅ P17 浏览器实测 ALL-PASS;TS + Vitest 已落地(见 `probes/P17-report.md`) |
| 全链路集成(合成论文) | ✅ P18 浏览器实测 ALL-PASS;Vitest 集成测试已落地(见 `probes/P18-report.md`) |
| 端到端运行器(合成演示) | ✅ P19 浏览器实测通过;真实 ZK-Tracer 测试待你执行(见 `probes/P19-report.md`) |
| Vue 应用五页面(首页/设置/工作台/阅读器/审核) | ✅ 已建成,待 `check.ps1` 类型检查 |
| ZK-Tracer 真实译文采样(术语/锚点/双版式) | ✅ P21 浏览器实测 ALL-PASS(见 `probes/P21-report.md`) |
| ZK-Tracer 真实端到端实测 | ⏳ 待你按 P19 步骤操作 |

## 探针(无需安装,浏览器直接打开)

- `probes/P1-cors-test.html` — DeepSeek 浏览器直连测试(填 Key 点一下)
- `probes/P2-print-text-layer.html` — 双栏中文打印导出 + 自检基准 JSON
- `probes/P3-block-paginator.html` — 块级分页器原型,三种版式 + 块序自检
- `probes/P4-pdf-text-layer.html` — PDF.js 文字层抽取、分栏判定、阅读顺序(P2 联测)
- `probes/P5-parser-core.html` — 解析器核心:行→栏→块切分 + 合成夹具断言
- `probes/P6-region-detector.html` — 图/表区域检测、题注关联、charRects + 断言
- `probes/P7-doc-builder.html` — 跨页装配:续接合并、prev/next 链、章节归属 + 断言
- `probes/P8-paginator-core.html` — 分页器共享核心(与 Vitest 同源码)三种版式可视化
- `probes/P9-print-renderer.html` — 打印导出渲染器:A4 页面预览 + 布局审计
- `probes/P10-translation-pipeline.html` — 翻译管线:两遍法/重试校验/术语表(mock LLM)
- `probes/ext-p11-session-test.html` — 提示词组装 + 断点续跑会话(自动断言)
- `probes/ext-p12-align-test.html` — 对齐引擎:句级DP/漏译/降级/span校验(自动断言)
- `probes/ext-p13-anchors-test.html` — 场景B:锚点/块级对齐/人工校准(自动断言)
- `probes/ext-p14-reader-test.html` — 阅读器核心:锚点反查同步/同步锁/词定位(自动断言)
- `probes/P15-reader-ui.html` — 双栏阅读器:双向同步滚动 + 句级高亮 + 词级联动

## 本地开发(PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1      # 安装依赖并启动
powershell -ExecutionPolicy Bypass -File .\scripts\check.ps1    # 类型检查+测试+构建
powershell -ExecutionPolicy Bypass -File .\scripts\final-test.ps1  # 全量检查 + 打开端到端运行器
```

最终测试步骤见 `docs/FINAL-TEST-RUNBOOK.md`;需求验证矩阵见 `docs/VERIFICATION-MATRIX.md`;端到端运行器 `probes/P19-e2e-runner.html`。

**发布到 GitHub Pages(全程 GUI,不用终端):`docs/PUBLISH-GITHUB.md`**

## 隐私

- 用户 API Key 仅存浏览器 localStorage,不上传、不入库
- 论文文件、译文、对齐表全部存浏览器 IndexedDB
