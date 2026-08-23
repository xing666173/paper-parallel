# P5 探针报告 —— 解析器核心(文字层 → 行 → 栏 → 块)

状态:**✅ 合成夹具断言全部通过**(期望块类型序列与实际完全一致)

## 探针目标(Sprint 1 核心算法基准)

把 P4 的行提取升级为完整块切分,为 TS 模块提供已 debug 的参考实现:

- items → lines(y 容差聚组 + x 间隙拆栏行)
- lines → 栏分类(full/left/right)+ 阅读顺序(通栏→左→右)
- lines → blocks(段落/章节/题注/公式/参考文献识别 + 垂直间隙断块)
- 合成夹具断言:12 个块的类型序列必须与期望一致

## Debug 记录(本轮发现并修复)

1. **段间隙阈值错误**:用"基线差"与阈值比较时,未扣除行高,导致两个独立段落被合并成一个段落 → 断言失败(期望 12 块,实际 11 块)。修复:阈值改为
   `实际空白 = 当前行顶 - 上一行底`,断块阈值 `max(中位行距×1.4, 行高中位数×1.5, 18px)`。修复后 ✅ 通过。
2. 清理了通栏区判断中的死代码分支。

## 夹具断言结果

```
期望: title, authors, abstract, section, paragraph, paragraph,
       caption, paragraph, paragraph, equation, section, paragraph
实际: 与期望完全一致(12 块)✅
```

## TS 落地

- `src/core/parser/lines.ts` / `columns.ts` / `blocks.ts` / `index.ts` —— 与本探针同算法、纯函数、零依赖
- `src/core/parser/pdfjsAdapter.ts` —— pdf.js 坐标换算(仿射矩阵),使解析器与 pdfjs 解耦
- `tests/unit/parser.spec.ts` —— 同一合成夹具 + 4 组单测(行拆分 / 分栏 / 块序列 / 坐标换算)

## 待你执行(本机 PowerShell)

```powershell
cd C:\Users\axezt\Documents\GitHub\paper-parallel
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1     # 首次会 npm install
# 另开一个终端:
powershell -ExecutionPolicy Bypass -File .\scripts\check.ps1   # typecheck + vitest + build
```

若 `check.ps1` 全部绿色,即证明 TS 版本与本探针行为一致。
