# 最终测试手册 —— 用 ZK-Tracer 完成端到端验收

## 目标

用真实论文完成闭环:
`ZK-Tracer 英文 PDF → 解析 → 翻译(DeepSeek)→ 双栏排版 → 对齐 → 规则审核 → AI 复审 → 人工门禁 → 项目包 JSON`

## 前置条件

1. Node.js 20+。**脚本已自动处理**:如果没装,会自动启动 `Downloads\node-v26.5.0-x64.msi` 安装包,装完重跑即可
2. 能联网的浏览器(加载 pdf.js CDN + 直连 api.deepseek.com)
3. DeepSeek API Key

## 第一步:代码全量检查(约 2–5 分钟,首次含 npm install)

```powershell
cd C:\Users\axezt\Documents\GitHub\paper-parallel
powershell -ExecutionPolicy Bypass -File .\scripts\final-test.ps1
```

检查内容:TypeScript 类型检查 → 14 个测试文件(vitest)→ 生产构建。
全绿后脚本会自动打开 P19 运行器。

## 第二步:无文件合成演示(确认链路)

P19 页点「无文件合成演示(mock)」,预期输出:

```
阶段1 翻译:9/9 完成
阶段2 分页:块序 OK
阶段4 规则审核:errors=0
阶段5 AI 复审:通过
阶段6 门禁:通过;项目包校验 OK
```

## 第三步:真实论文 mock 跑通

1. 选择 `C:\Users\axezt\Desktop\文献\导师文章\18：ZK-Tracer：A High-Performance Heterogeneous Accelerator for Zero-Knowledge VM Trace Generation.pdf`
2. 引擎保持 mock → 「开始端到端」
3. 观察「阶段输出」:解析页数/块数、翻译 100%、审核应为 `errors=0,warns=0`

## 第四步:真实 DeepSeek 翻译

1. 引擎选 real,填 API Key(勾选"Key 存本机"仅写 localStorage)
2. 「开始端到端」
3. 关注:阶段1 完成数、阶段4 的 error/warn、门禁与项目包校验

mock 与 real 使用不同的断点缓存,切换引擎不会复用另一引擎的译文。

## 验收标准

- [ ] check.ps1 全绿
- [ ] 合成演示通过
- [ ] ZK-Tracer mock 全流程通过(解析→打包)
- [ ] ZK-Tracer real 翻译完成率 ≥ 95%(个别块失败可重跑,断点续跑已实现)
- [ ] 规则审核 0 error(warn 允许)
- [ ] 门禁通过,下载项目包 JSON 且校验 OK

## 出问题时的排查

| 现象 | 排查 |
|---|---|
| P19 解析报 CDN 超时 | 网络未连上 jsdelivr;检查代理 |
| 翻译 HTTP 401 | Key 错误 |
| 浏览器 CORS 错误 | 先跑 `probes/P1-cors-test.html`,按 P1 预案启用代理 |
| 某块翻译失败 | 刷新页面重跑;session 会跳过已完成块续跑 |
| 阶段4 有 error | 把阶段输出里的 `[error]` 行发开发者 |
