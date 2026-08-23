# P7 探针报告 —— 跨页装配(DocBuilder)

状态:**✅ 合成双页夹具 8 项断言全部通过**

## 探针目标(Sprint 1 最后一块)

把逐页解析结果装配成统一 `Doc`:
- 每页按"通栏→左→右"展开成全局块序列
- 跨页/跨栏段落续接合并(块携带多个 fragment)
- prev/next 双向链、章节归属(parentSectionId)
- widthMode(通栏=span / 栏内=column)、splitAllowed(图/表/公式/题注不可断)
- 整体与逐页 layoutMode 判定

## Debug 记录(本轮发现并修复 2 个 bug)

1. **续接合并误吞右栏段**:页末中断段先和同页右栏首段合并,真正的下一页续段反而没合并。
   修复:两遍法——第一遍只做"下一页同栏"合并,第二遍才做"同页左→右栏"合并。
2. **prev/next 链指向旧 id**:单遍循环里"先给当前块换新 id、再取下一块的 id",拿到的是下一块尚未替换的旧 id,导致 next 链断裂。
   修复:两遍赋值——第一遍统一换新 id,第二遍再建链与章节归属。

## 断言结果(8/8)

- ✅ 全局块序与期望一致(含续接合并):12 块
- ✅ 跨页段落已合并为 1 个块,带 2 个 fragment
- ✅ 合并块 pageIndex=首页
- ✅ prev/next 链连续
- ✅ 章节归属正确(s1/s2)
- ✅ widthMode:标题 span、正文 column
- ✅ splitAllowed:图/公式 false、段落 true
- ✅ 整体 layoutMode=mixed

## TS 落地

- `src/core/parser/docBuilder.ts` —— buildDoc(ParsedPage[] -> Doc)
- `src/types/models.ts` —— Block 增加 `fragments` 字段
- `tests/unit/docBuilder.spec.ts` —— 4 组用例
- `parser/index.ts` 已导出

## Sprint 1 至此全部算法板块完成

文字层 → 行 → 栏 → 块 → 图/表区域 → 题注关联 → charRects → 跨页装配,全部有探针 debug + TS + Vitest。
待你本机跑 `scripts\check.ps1` 做 TS 层最终验证。
