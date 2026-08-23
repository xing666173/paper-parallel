# P17 探针报告 —— AI 复审 + 人工终审门禁 + 项目包(Sprint 6 收尾)

状态:**✅ 浏览器实测 ALL-PASS**

## 探针目标

- AI 复审:逐对交给审校模型,LLM 输出 JSON 解析(容忍 ```json 围栏),收集 error/warn
- 人工终审门禁:合并规则审核 + AI 复审;存在未消解 error 即不通过;人工消解后通过
- 项目包:`schema/mode/双文档/对齐/spans/术语/审核记录/auditPassed` + FNV-1a 校验和
- 防篡改:改任意字段后 checksum 校验失败

## 浏览器实测(ext-p17-review-test.html)

```
ALL-PASS
✅ parseLlmJson 剥围栏
✅ AI 复审发现 1 error
✅ 合并后 2 个未消解 error
✅ 消解前门禁不通过
✅ 人工消解后门禁通过
✅ 项目包校验通过
✅ 篡改包校验失败
checksum=6b9743b4 · aiIssues=["error"]
```

## TS 落地

- `src/core/review/review.core.js` —— 共享核心
- `src/core/review/index.ts` —— 类型化入口
- `tests/unit/review.spec.ts` —— 2 组用例
- `prompts/audit.json` —— 审校角色提示词(与代码零耦合)

## Sprint 6 完成

规则审核(P16)+ AI 复审/人工门禁/项目包(P17)+ GitHub Actions 部署全部落地。

## 下一步:最终集成与端到端实测

1. 你本机跑 `scripts\check.ps1`(现在 13 个测试文件),修掉可能的 TS/测试问题
2. `npm run dev` 验收 Vue 骨架
3. 用 ZK-Tracer 跑端到端:解析 → 翻译(接真实 DeepSeek)→ 排版 → 对齐 → 审核 → 导出
