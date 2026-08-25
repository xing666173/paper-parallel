# 最终测试手册 —— 用 ZK-Tracer 完成端到端验收

## 目标

用真实论文完成闭环：
`ZK-Tracer 英文 PDF → Vision Exp 版式识别 → 翻译 → Typst 中文排版 → PDF 内容门 → 对齐 → Vision Exp 逐页复核 → 对照阅读/下载`

## 前置条件

1. Node.js 20+。**脚本已自动处理**:如果没装,会自动启动 `Downloads\node-v26.5.0-x64.msi` 安装包,装完重跑即可
2. 能直连 `api.deepseek.com` 的 Chromium 浏览器
3. DeepSeek API Key

## 第一步：确定性全量检查

```powershell
cd C:\Users\axezt\Desktop\网页\paper-parallel
npm run test:all
```

检查内容：TypeScript、单元/集成测试、生产构建、浏览器上传与下载回归。

## 第二步：真实 API 密钥仅注入当前进程

不要把 Key 写进仓库、命令历史或测试报告。推荐从当前 PowerShell 会话读取本机私密文件：

```
$env:PP_DEEPSEEK_API_KEY = (Get-Content -Raw 'C:\Users\axezt\.codex\secrets\deepseek-api-key.txt').Trim()
$env:PP_SOURCE_PDF = 'C:\Users\axezt\Desktop\文献\导师文章\18：ZK-Tracer：A High-Performance Heterogeneous Accelerator for Zero-Knowledge VM Trace Generation.pdf'
```

## 第三步：Flash 翻译 + Vision Exp 识别/质检

$env:PP_TRANSLATION_MODEL = 'deepseek-v4-flash'
npx playwright test tests/browser/final-pdf-quality.spec.ts --project=chromium

## 第四步：Vision Exp 翻译 + Vision Exp 识别/质检

$env:PP_TRANSLATION_MODEL = 'deepseek-v4-flash-vision-exp'
npx playwright test tests/browser/final-pdf-quality.spec.ts --project=chromium

## 验收标准

- [ ] `npm run test:all` 全绿
- [ ] Flash 路径和 Vision Exp 路径均完成 100% 已校验文本块
- [ ] 下载 PDF 有可提取中文文本，每页都有内容
- [ ] 所有最终页截图已逐页检查，无空白、裁切、重叠、乱码或源正文栅格碎片
- [ ] 图、表、公式、代码及其内部标注保持原样，仅图注/表注翻译
- [ ] 单栏→单栏、双栏→双栏、混合按区继承，允许页数自然延伸

## 出问题时的排查

| 现象 | 排查 |
|---|---|
| Vision 版式识别失败 | 查看 AI 日志中的页码；缓存只复用严格校验通过的 JSON |
| 翻译 HTTP 401 | Key 错误 |
| 浏览器 CORS 错误 | 先跑 `probes/P1-cors-test.html`,按 P1 预案启用代理 |
| 某块翻译失败 | 点“继续未完成任务”；已通过块会命中 IndexedDB 缓存 |
| PDF 内容门失败 | 不会覆盖旧 PDF；检查缺失译文、字体、空白页或异常页数 |
| Vision 成品质检失败 | 查看报告页码和缺陷类型，修复后重新编译，不允许强行进入阅读器 |
