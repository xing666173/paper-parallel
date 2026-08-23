# 项目交接单(Paper Parallel)

> 最后更新:第 31 轮。此文件用于:任何人接手后 5 分钟内在用户机器上完成最终验收。

## 一句话状态

六个 Sprint 全部实现;所有可在当前会话验证的模块(P3–P19)均已浏览器实测 ALL-PASS;唯一未完成的是在用户机器上执行 `npm run test:ci` 与用 ZK-Tracer 论文跑 P19 真实端到端。

## 立即执行的验收命令

```powershell
cd C:\Users\axezt\Documents\GitHub\paper-parallel
powershell -ExecutionPolicy Bypass -File .\scripts\final-test.ps1
```

- 无 Node 时会自动启动 `Downloads\node-v26.5.0-x64.msi`
- 脚本启动即写 `reports\last-run.txt`(心跳),完成写 `reports\check-output.txt`(均已 gitignore)

## P19 端到端(浏览器,联网)

1. `probes\P19-e2e-runner.html`
2. 无文件合成演示(mock)/ 无文件场景B演示 → 确认链路
3. 英文 PDF:`Desktop\文献\导师文章\18：ZK-Tracer：...pdf`
4. 中文 PDF(可选场景B):`19：ZK-Tracer 中文翻译版.pdf`
5. mock 跑通 → real 填 DeepSeek Key(正式提示词已内嵌)→ "复制阶段输出"

## 证据索引

| 模块 | 探针证据 | 自动化测试 |
|---|---|---|
| 解析器 | P5/P6/P7 | tests/unit/parser/regions/docBuilder |
| 分页/打印 | P3/P8/P9 | tests/unit/paginator/layout |
| 翻译管线 | P10/P11/P19 | tests/unit/pipeline/session/client |
| 对齐 | P12/P13/P19-B | tests/unit/align/alignBlocks |
| 阅读器 | P14/P15 | tests/unit/reader |
| 审核/打包 | P16/P17/P19 | tests/unit/audit/review |
| 全链路 | P18/P19 | tests/integration/e2e-synthetic |
| 真实论文内容 | P20(截图OCR)/P21(章节采样)/P22(全篇48块:16节+11图+3表) | — |
| 需求映射 | docs/VERIFICATION-MATRIX.md | — |

## 已知待办(按优先级)

1. 用户执行上述两条(阻塞中)
2. 若 `check.ps1` 有红项:贴出 `reports\check-output.txt`
3. 若 P19 real 阶段输出有 error:按阶段输出逐条修
4. 全部通过 → 目标完成
