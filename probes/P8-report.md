# P8 探针报告 —— 分页器核心共享模块(Sprint 2)

状态:**✅ 浏览器实测三种版式全部 PASS**(共享核心 `src/core/paginate/paginator.core.js`)

## 关键决策:单一源码,双环境加载

本板块没有"探针 JS 一份、TS 一份"的分叉风险:

- `src/core/paginate/paginator.core.js` —— 经典脚本,执行后挂 `globalThis.PaperParallelPaginator`
- 浏览器探针:`<script src="../src/core/paginate/paginator.core.js">` 直接加载同一文件
- Vitest:`await import('.../paginator.core.js')` 后从 `globalThis` 取同一对象
- 应用:`src/core/paginate/index.ts` 只做类型包装与 DOM 测量适配器,不复制逻辑

## Debug 记录(本轮发现并解决 2 个环境/集成问题)

1. **ESM 经 file:// 导入被 Chrome 拦截** → 核心改为经典脚本 + globalThis 暴露,浏览器/Node 通用。
2. **截图环境对 `file:///` 绝对路径外部脚本不加载**(相对路径正常)→ 探针统一用相对路径引用。

## 浏览器实测输出(ext-p8-core-test.html)

```
double pages=3 order=OK issues=1 spanPages=2 => PASS
single pages=3 order=OK issues=1 spanPages=2 => PASS
mixed  pages=3 order=OK issues=1 spanPages=2 => PASS
frontMatterInFull=4
ALL=PASS
```

覆盖:P3 已 debug 的全部规则(块序保序、超高块降级、跨栏 span、frontMatter 通栏、三种版式)。

## Vitest 落地

`tests/unit/paginator.spec.ts` —— 6 组用例:
三种版式块序 / 超高块降级 / frontMatter 通栏 / 单栏栏位集合 / 原子块不劈开 / chunkText 高度约束与无损拼接

`src/core/paginate/index.ts` —— 类型化入口 + `createDomMeasure()` 测量适配器。

## 探针文件

- `probes/P8-paginator-core.html` —— 完整可视化(三种版式页面预览),请在正常浏览器打开
- `probes/ext-p8-core-test.html` —— 最小断言页(截图环境验证用)

## 待你本机执行

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check.ps1
```

通过后 Sprint 2 分页核心定案;下一板块:打印导出渲染器(HTML/CSS 落版 + 打印样式),随后即可用 ZK-Tracer 做端到端。
