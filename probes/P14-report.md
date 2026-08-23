# P14 探针报告 —— 对照阅读器核心(Sprint 5)

状态:**✅ 浏览器实测 ALL-PASS**

## 探针目标

- 位置索引:块(pageIndex+rect)展开为绝对 Y,二分定位视口中心所在块
- **锚点反查同步(绝不百分比)**:视口块 → 对齐单元 → 对方块 → 目标滚动(块中心-视口半高,负值钳制为 0)
- 同步锁:同侧滚动在锁定期内只发一次命令,对侧永远放行,过期解锁(防循环抖动)
- 词级联动:子串 → 字符区间(原文精确优先,多空格场景归一化回退)

## Debug 记录(本轮发现并修复 2 个问题)

1. 探针漏写 IIFE 开头 `(async()=>{`,导致 `})().catch` 悬空、脚本整体解析失败。
2. 断言把 "We propose **a** hardware" 的 `hardware` 起始位算成 11,实际应为 13(漏数冠词 a)。修正断言,核心函数无 bug。

## 浏览器实测(ext-p14-reader-test.html)

```
ALL-PASS
✅ zh zp1 -> en ep1 目标滚动居中钳制为 0
✅ zh zp2 -> en ep2 scroll=1090
✅ en ep3 -> zh zp3 scroll=1500
✅ 同步锁:同侧抑制 / 对侧放行 / 过期解锁
✅ 原文精确子串定位(13..33 / 13..18)
✅ 多空格归一化回退定位(16..36)
```

## TS 落地

- `src/core/reader/reader.core.js` —— 共享核心
- `src/core/reader/index.ts` —— 类型化入口
- `tests/unit/reader.spec.ts` —— 3 组用例

## Sprint 5 剩余

Vue 组件层:双 PDF 渲染容器 + 滚动监听接线 + 高亮覆盖层(句级/词级矩形)+ 术语面板。
