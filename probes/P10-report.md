# P10 探针报告 —— 翻译管线核心(Sprint 3)

状态:**✅ 浏览器 mock LLM 全流程 ALL-PASS**

## 探针目标

实现并验证两遍法翻译管线的编排逻辑(LLM 调用注入,核心零依赖):

- 第 1 遍:章级粗译 → 抽取全局术语表(中文名称（English Full Name, ABBR）格式)
- 第 2 遍:按块串行精译,注入全局术语表 + 前文上下文
- 失败重试(默认 2 次)、译文校验(空译/说明性前缀/近全英文拒收)
- 块序保序、永久失败块标记后不中断队列、进度回调与统计

## Debug 记录(本轮发现并修复 3 个 bug)

1. **缩写正则漏掉小写字母**:`zkVM` 的小写 z/k 不在字符集 → 带缩写术语整体失配,术语表只剩 2 条。修复字符集 `[A-Za-z0-9-]`。
2. **术语中文名粘连连接词**:`和证明（Proof）` 会把"和"一起抽进去 → 抽取后剥离前导 `和/与/及/、/,`。
3. **attempts 计数逻辑错误**:写成恒等于 1 → 改为按尝试轮次记录(重试后=2)。

## 浏览器实测(ext-p10-pipeline-test.html)

```
ALL-PASS
✅ pass1>=1        ✅ terms3(zkVM/Trace/Accelerator)
✅ order           ✅ transient-retry(attempts=2)
✅ validation-retry(attempts=2)  ✅ forever-fail-then-continue
✅ terms-injected  ✅ assembled-ok
stats={pass1Chapters:1, pass2Blocks:6, done:5, failed:1, retries:4}
```

## TS 落地

- `src/core/translate/pipeline.core.js` —— 共享编排核心(浏览器/Node 同一份)
- `src/core/translate/index.ts` —— 类型化入口
- `src/core/translate/client.ts` —— DeepSeek OpenAI 兼容客户端(fetch 注入、超时、usage 解析)
- `tests/unit/pipeline.spec.ts` + `tests/unit/client.spec.ts`

## 探针文件

- `probes/P10-translation-pipeline.html` —— 完整版(逐块结果表,请正常浏览器打开)
- `probes/ext-p10-pipeline-test.html` —— 最小断言页(截图环境验证用)

## 下一步(Sprint 3 剩余)

设置页 + 真实 DeepSeek 接入 + 提示词挂载(你的提示词已在 `prompts/translation.json`)+ IndexedDB 任务持久化与断点续跑。
