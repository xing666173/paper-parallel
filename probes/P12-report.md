# P12 探针报告 —— 对齐引擎核心(Sprint 4 第一块)

状态:**✅ 浏览器实测 ALL-PASS**

## 探针目标

- 中英文分句(小数点/缩写点保护)
- 句级对齐 DP:允许 1:0 / 0:1 / 1:1 / 1:2 / 2:1,全局最优
- 三级降级:低置信度句对 → 整段(paragraph level)
- 词级 span:LLM 直出 + 双端子串校验,非法项丢弃
- 语义打分 judge 注入(真实场景用 DeepSeek,测试用关键词打分)

## Debug 记录(本轮发现并修复 3 个 bug)

1. **分句正则漏了英文句号 `.`** → 英文整段切不开(首个断言就失败)。补上 `.` 与 `．`。
2. **DP 合并代价公式错误**:2:1/1:2 写成"加惩罚",应为"两个相似度之和 − 惩罚"。修正。
3. **平局偏好错误**:分数相同时 DP 倾向于把漏译强行合并成 2:1 → 给合并操作加 1e-6 微惩罚,平局时保守解释(漏译优先)。

## 浏览器实测(ext-p12-align-detail.html)

```
split ens=[2句] zhs=[2句]            => PASS
1:1  units=[(0,0,c.37),(1,1,c.75)]   => PASS
2:1  units=[([0,1],[0])]             => PASS
miss units=[(0,0),(1,-)]             => PASS
fallback level=paragraph fb=true     => PASS
pair  level=sentence 2句,spans=2合法 => PASS
```

## TS 落地

- `src/core/align/align.core.js` —— 共享核心(浏览器/Node 同一份)
- `src/core/align/index.ts` —— 类型化入口
- `tests/unit/align.spec.ts` —— 3 组 6 用例

## 下一步(Sprint 4 第二块)

场景 B 的文档级锚点 + 块级对齐 + 人工锚点校准(P13),以及场景 A 的"管线直出块对齐 + alignBlockPair"装配。
