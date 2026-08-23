# P13 探针报告 —— 场景 B:锚点 + 块级对齐 + 人工校准(Sprint 4 收尾)

状态:**✅ 浏览器实测 ALL-PASS**

## 探针目标

- 跨语言锚点归一化:`Figure 1` / `图 1` → `fig1`;`1 Introduction` / `1 引言` / `1.2 Motivation` → `sec1` / `sec1.2`
- 锚点抽取:章节、图题、表题;自动配对(重复 label 按序)
- **锚点锁大局 → 段内块级 DP**(1:0/0:1/1:1/2:1/1:2)
- 人工锚点校准:删除 / 重绑 / 新增,带 issue 反馈
- 覆盖守恒校验:中文块恰好覆盖一次;英文多余块产生 1:0

## Debug 记录(本轮发现并修复 1 个接口 bug)

- 块级 DP 最初把"段内下标"传给调用方 scoreFn,调用方无法知道段边界 → 改为**直接传块对象** `scoreFn(enBlock, zhBlock)`,接口稳定。

## 浏览器实测(ext-p13-anchors-test.html)

```
ALL-PASS(9/9)
✅ 标签归一化 Figure 1/图 1/1.2 节
✅ 锚点抽取 EN=3(s1/fig1/s2),ZH=3
✅ 跨语言自动配对 3 对
✅ 锚点单元 3 个且 confidence=1
✅ 中文所有块恰好被覆盖一次
✅ 英文多余段产生 1:0 未匹配
✅ 全局置信度不触发降级
✅ 人工删除 fig1 锚点 / 人工重绑 fig1 锚点
```

## TS 落地

- `src/core/align/alignBlocks.core.js` —— 共享核心
- `src/core/align/index.ts` —— 全部锚点/块级对齐 API 类型化导出
- `tests/unit/alignBlocks.spec.ts` —— 3 组用例

## Sprint 4 完成

句级/词级(P12)+ 场景 B 锚点/块级/人工校准(P13)全部落地。
下一板块 Sprint 5:对照阅读器(双向同步滚动、句级/词级高亮、术语面板)。
