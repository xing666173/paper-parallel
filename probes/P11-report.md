# P11 探针报告 —— 提示词组装 + 断点续跑会话(Sprint 3 收尾)

状态:**✅ 浏览器实测 ALL-PASS**

## 探针目标

- 提示词组装:用户翻译提示词原文完整保留在最前;系统提示词 = 角色 + 任务 + Markdown/LaTeX 包装;工程上下文(章节/术语表/前文/当前块)作为数据附加
- 断点续跑:每个块成功后立即持久化;重跑时已完成块永不重跑、术语表跨轮复用、失败点之后继续

## Debug 记录(本轮发现并修复 4 个 bug)

1. **两个经典脚本顶层 `const __root` 同名冲突** → 第二个脚本整体解析失败(globalThis 上无挂载)。改为每文件唯一变量名 `__rootPipeline/__rootSession/__rootPaginator`。
2. **stats 声明在 pass1 之后** → TDZ `Cannot access 'stats' before initialization`。上移声明。
3. **pass1Chapters 统计恒为 0** → 改为在第 1 遍循环内递增。
4. 断点断言口径错误(第 1 轮实际完成 3 块,断言写成 2)→ 修正断言。

## 浏览器实测(ext-p11-session-test.html)

```
ALL-PASS
✅ run1 b03 failed,others done
✅ run1 持久化 b01/b02
✅ run2 复用已完成块(resumed=3)
✅ run2 不重跑已完成块(call不含b01/b02)
✅ run2 续跑 b03..b04 全 done
✅ 术语表首轮抽取并跨轮复用
✅ 用户提示词原文前缀完整
✅ pass2 术语注入
r1={pass1Chapters:1, pass2Blocks:4, done:3, failed:1}
r2={pass1Chapters:0, pass2Blocks:1, done:4, failed:0, resumed:3}
```

## TS 落地

- `src/core/translate/session.core.js` —— 共享核心
- `src/core/translate/index.ts` —— buildSystemPrompt / buildUserPrompt / runResumableTranslation 类型化导出
- `tests/unit/session.spec.ts` —— 提示词组装 + 断点续跑用例

## Sprint 3 完成

管线编排(P10)+ 提示词组装/断点续跑(P11)+ DeepSeek 客户端 + 6 个测试文件全部落地。
下一步 Sprint 4:对齐引擎(场景 A 块内句/词精对齐;场景 B 文档→段→句 + 人工锚点)。
