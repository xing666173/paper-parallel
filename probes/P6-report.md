# P6 探针报告 —— 图/表区域检测 + 题注关联 + charRects

状态:**✅ 合成夹具断言全部通过**

## 探针目标(Sprint 1 剩余核心)

- 位图矩形合并:同图多个 paintImage 块 → 1 个图区域
- 横竖线网格 → 表格区域
- 题注关联:图题(下方)/ 表题(上方)自动绑定到区域,题注文本块从正文序列移除
- 统一块序列:文字块 + 图/表区域按"通栏→左→右"阅读顺序保序输出
- charRects:按字符等分 TextItem 宽度,生成词级高亮所需的字符坐标

## Debug 记录(本轮发现并修复 3 个 bug)

1. **表格检测字段 bug**:线段对象是 `{x1,y1,x2,y2}`,分组和取坐标时误用不存在的 `y/x` 字段 → 全部候选坐标 NaN,tabs 恒为空。修复为 `y1/x1`。
2. **表题方向 bug**:题注关联只接受"题注在区域下方",而学术论文表题在表上方 → 图题 38px 距离被判超限。修复:上下两个方向都接受,阈值放宽到 `行高×3`。
3. **表格 bbox 断言口径**:bbox 应以"水平线网格"的 y 范围为界(340..380),而不是竖线端点外延(280..380)。统一口径后通过。

## 夹具断言结果(6/6)

- ✅ 位图矩形合并为 1 张图(60,270,240,80)
- ✅ 表格线网格检测出 1 个表(340,340,220,40)
- ✅ 图题关联到图区域(below,gap=38)
- ✅ 表题关联到表区域(above,gap=17)
- ✅ 统一块序列与期望一致(11 块:title…figure…table…equation)
- ✅ charRects 数量 = 字符数

## TS 落地

- `src/core/parser/regions.ts` —— mergeBitmapRegions / detectTableRegions / unifyBlocks
- `src/core/parser/charRects.ts` —— itemsToCharRects / rectsForRange(词级联动跨行矩形)
- `tests/unit/regions.spec.ts` —— 5 个用例(位图合并 / 表格检测 / 题注关联保序 / 孤儿题注保留 / charRects)
- `parser/index.ts` 已导出全部新模块

## 待你本机执行

```powershell
cd C:\Users\axezt\Documents\GitHub\paper-parallel
powershell -ExecutionPolicy Bypass -File .\scripts\check.ps1
```

全部绿色即表示 TS 版本与探针行为一致(Sprint 1 可定案)。
