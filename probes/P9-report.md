# P9 探针报告 —— 打印导出渲染器(Sprint 2 收尾)

状态:**✅ 浏览器实测:order=OK · dom=data · 无越界 · AUDIT=PASS**

## 探针目标

把共享分页器的结果渲染为 A4 页面 DOM:
- 屏幕预览 = 打印版面(内部 px 坐标,打印物理 210×297mm,@page 零边距)
- 单栏 / 双栏 / 混合三种版式;frontMatter 通栏、跨栏 span、图/表/公式块、题注、缩放标记
- 布局审计:块不越出页底、DOM 块数与分页数据一致
- 打印 / 另存为 PDF 入口(P2 已约定边距"无"、关页眉页脚)

## Debug 记录(本轮发现并修复)

1. 单栏渲染分支把字符串 `'single'` 误当栏对象传入 → TypeError → 修复为 `page.single`。
2. 最小审计测试只渲染第 1 页却统计全部页 → DOM 6 ≠ data 8(测试口径 bug)→ 修复为渲染全部页后审计 → dom=8 data=8 ✅。
3. draw() 把栏对象存进 dataset → 改为显式传栏名。
4. 打印样式缺 page-wrap 分页规则 → 补充 `.page-wrap{width:210mm;page-break-after:always}` + `.print-page{transform:none}`。

## 浏览器实测(ext-p9-render-test.html)

```
order=OK pages=2 dom=8 data=8 issues=0 AUDIT=PASS
```

## TS 落地

- `src/core/paginate/layout.ts` —— buildLayout(分页结果→布局描述,纯数据)+ auditLayout(越界与计数审计)
- `tests/unit/layout.spec.ts` —— 3 组用例(对应日志 / span 宽度与 scaled / 三种版式审计)

## 探针文件

- `probes/P9-print-renderer.html` —— 完整版:三种版式切换 + 页面预览 + 打印按钮(请正常浏览器打开)
- `probes/ext-p9-render-test.html` —— 最小审计页(截图环境验证用)

## Sprint 2 完成

分页核心(P8)+ 布局/打印渲染(P9)全部就绪;下一板块进入 **Sprint 3 翻译管线**。
