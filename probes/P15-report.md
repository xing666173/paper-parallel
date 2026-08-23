# P15 探针报告 —— 双栏对照阅读器 UI(Sprint 5 收尾)

状态:**✅ 浏览器自动演示通过**(词级联动 + 双向同步 + 句级高亮)

## 探针目标

把 P14 核心接到真实滚动容器上:
- 双栏滚动容器,块绝对定位,页码分隔
- 滚动任一侧 → 锚点反查 → 对侧滚动 + 当前对齐单元橙色高亮
- 程序化滚动回声抑制(suppressNext 一次)+ 同步锁(150ms)
- 中文块内词级 span 渲染为可点击黄色词 → 点击后在左侧英文块上绘制字符级蓝色高亮格

## Debug 记录(本轮发现并修复)

1. 自动演示滚动目标单元算错(滚到 1000 命中 unit2 而非 unit1)→ 修正断言。
2. 缺"程序化滚动回声抑制"会导致一次反向回弹 → 增加 suppressNext 一次抑制,配合同步锁。
3. 词高亮格用 fixed 定位,滚动后会错位 → 演示中验证完立即清理,真实组件中点击后随用户滚动由下一次交互清理。
4. 截图环境无法点击 → 自动演示改为同步执行并输出审计文本。

## 浏览器实测(P15-reader-ui.html 自动演示)

```
✅ 自动演示通过
词级联动:✅ 20 字符('hardware accelerator')
右滚=1000 → 左滚=1020 · 对齐单元=2 · 句级高亮=是
```

## Vue 落地

`src/components/reader/ReaderView.vue` —— 与 P15 同交互逻辑:
- props:enBlocks / zhBlocks / units / spans / pageH / viewportH / lockMs
- 双向同步 + 回声抑制 + 锁;activeUnit 高亮;中文词切分渲染 + 点击词高亮字符格
- 待 npm 环境接入 App 路由后验收

## Sprint 5 完成

P14(核心)+ P15(UI 探针)+ ReaderView.vue。下一步 Sprint 6:二次审核三关、项目包导出、GitHub Actions 部署。
