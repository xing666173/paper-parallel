# P21 探针报告 —— ZK-Tracer 完整译文采样测试

状态:**✅ ALL-PASS**

## 来源

读取本机 `Desktop\文献\导师文章\ZK-Tracer_中文翻译.html`(真实完整中文译文,双栏 HTML,含图 1–8 与公式),手工抽取 25 个真实内容块(标题/作者/摘要/关键词/章节 1–3.3/正文/图 1,2,3,5/公式 1)构造夹具。

## 实测结果

```
✅ 术语抽取 >= 6:zkVM, ZKP, MTU, PTUs, Hardware Acceleration, ZKPs…
✅ 含 zkVM 与 PTUs
✅ 章节锚点完整:sec1,2,2.1,2.2,2.3,3,3.1,3.2,3.3
✅ 图题锚点:fig1,fig2,fig3,fig5(不重不漏)
✅ single 分页:块序保持,页数 >=2
✅ double 分页:块序保持,页数 >=2
```

## 本轮修复

- `alignBlocks.core.js` 的 `extractAnchors` 增加 **caption 兜底**(此前只读 text,图块锚点会漏抽)。已同步加 Vitest 用例。

## 意义

这是目前**最接近真实论文的离线验证**:真实译文内容 + 真实章节/图编号 + 真实术语格式(全角括号),覆盖解析后流水线的术语、锚点、双版式分页三个环节。完整 PDF 端到端仍待 P19(需你浏览器选择 PDF)。
