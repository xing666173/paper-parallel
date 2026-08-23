# P16 探针报告 —— 二次审核第一关:规则自动审核(Sprint 6)

状态:**✅ 浏览器实测 ALL-PASS**

## 探针目标

实现冻结计划的 8 条自动规则与门禁语义:
- R1 编号对象序列守恒(fig/tab/eq 顺序一致)
- R2 章节编号守恒
- R3 图/表/公式/参考文献数量守恒
- R4 每个英文文字块都有非空译文配对
- R5 行内公式标记数量偏差(>$2 告警)
- R6 术语缩写必须在译文中出现(否则首次格式丢失)
- R7 译文无"翻译说明/总结"污染
- R8 英文数字抽样一致性(缺失告警)
- **门禁:存在 error 即不通过;warn 列出不阻塞**

## 浏览器实测(ext-p16-audit-test.html)

```
ALL-PASS
✅ 正常论文:pass=true 且 0 error
✅ 埋错:不通过
✅ 埋错:R1/R2/R3/R4/R7 至少各一条 error
✅ 埋错:R6/R8 至少各一条 warn
✅ 门禁语义:存在 error 即不通过
issues=[R1:error, R2:error, R3:error, R4:error, R6:warn, R7:error, R8:warn]
```

## TS 落地

- `src/core/audit/audit.core.js` —— 共享核心
- `src/core/audit/index.ts` —— 类型化入口
- `tests/unit/audit.spec.ts` —— 正常/埋错两组用例

## Sprint 6 剩余

AI 复审(审校角色)、人工终审界面(问题标红/bbox 微调)、项目包 zip 导出、GitHub Actions 部署。
