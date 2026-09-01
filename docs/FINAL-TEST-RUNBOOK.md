# 最终测试手册 —— 中文单栏真实论文验收

## 目标

用真实论文完成闭环：
`英文 PDF → Vision Exp 版式识别 → 翻译 → Typst 中文单栏重排 → PDF 内容门 → 对齐 → Vision Exp 逐页复核 → 对照阅读/下载`

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

## 第三步：运行一篇真实论文

```powershell
$env:PP_TRANSLATION_MODEL = 'deepseek-v4-flash'
npx playwright test tests/browser/final-pdf-quality.spec.ts --project=chromium
```

测试报告写入 `reports/real-api/<model>/<paper>/`，包括最终 PDF、逐页 PNG、Typst、对齐清单和 Vision 报告。
需要复用旧任务缓存但保留旧报告时，可令 `PP_PROFILE_SLUG` 指向旧浏览器缓存目录，并为 `PP_REPORT_SLUG` 使用新的报告名。

## 第四步：本轮两篇开发门禁

按当前验收约束只跑两篇：cuZK 与 ZK-Tracer。两篇都通过后，必须清除网站任务、译文、视觉和公式缓存，从冷缓存重新完整跑第一篇，确认第二篇修复没有破坏第一篇。三次运行都必须从网页上传入口开始并使用真实 DeepSeek API，直接调用底层函数或只看已有缓存不算通过。

其余十篇保留为后续发布矩阵，不属于本轮完成门槛：PipeZK、Falic、Myosotis、MSMAC、Gypsophila、SZKP、ReZK、LegoZK、Hardware–Algorithm Co-Design、Need for zkSpeed。

## 验收标准

- [ ] `npm run test:all` 全绿
- [ ] cuZK、ZK-Tracer 和清缓存后的首篇回归均完成 100% 已校验文本块
- [ ] 下载 PDF 有可提取中文文本，每页都有内容
- [ ] 所有最终页截图已逐页检查，无空白、裁切、重叠、乱码或源正文栅格碎片
- [ ] 图、表、公式、代码及其内部标注保持原样，仅图注/表注翻译
- [ ] 单栏、双栏和混合英文均生成中文单栏，Typst 不含正文 `columns(2)` 或残留 `colbreak()`
- [ ] 内容门、对齐门和 Vision 终审全部通过；失败任务停在处理页并保存逐页报告
- [ ] 每篇记录初次问题、自动修复动作、尝试次数和最终状态

## 出问题时的排查

| 现象 | 排查 |
|---|---|
| Vision 版式识别失败 | 查看 AI 日志中的页码；缓存只复用严格校验通过的 JSON |
| Exp 纠错预算耗尽 | 导出源版式诊断，点击“重新分析失败页面”；只清除失败页、相关跨页组和下游产物 |
| 网络或渲染重试耗尽 | 任务应处于可恢复暂停，不得生成空视觉计划；恢复后继续复用已验证页面 |
| 重复 unit/marker | 导出结构诊断；这是本地结构错误，不应继续调用 Exp |
| 翻译 HTTP 401 | Key 错误 |
| 浏览器 CORS 错误 | 先跑 `probes/P1-cors-test.html`,按 P1 预案启用代理 |
| 某块翻译失败 | 点“继续未完成任务”；已通过块会命中 IndexedDB 缓存 |
| PDF 内容门失败 | 不会覆盖旧 PDF；检查缺失译文、字体、空白页或异常页数 |
| Vision 成品质检失败 | 查看逐页报告和最多两轮自动修复记录；仍失败则停止，不允许强行进入阅读器 |
