# P1 探针报告 —— DeepSeek 浏览器 CORS 连通性

状态:**UI 与判定逻辑 ✅ 已验证;真实连通性 ⏳ 待用户在本机浏览器执行**

## 探针目标

决定主流程能否"浏览器直连 DeepSeek API"。若不能,启用可选代理地址 + Cloudflare Worker 代理模板。

## 已完成的 debug

- 页面结构、表单、判定逻辑、离线演示路径已通过 Chrome 截图回归。
- Key 处理:默认仅存内存;勾选"保存"才写 localStorage;提供清除按钮;页面无任何第三方网络去向。

## 待执行验证(需要你操作,1 分钟)

1. 浏览器打开 `probes/P1-cors-test.html`
2. 填 DeepSeek API Key(模型默认 `deepseek-chat`,可改)
3. 点"开始测试"
4. 把结果区两张卡片的状态(OK/失败 + 响应头)发我

判定:
- 两步都 OK 且有 `Access-Control-Allow-Origin` → 直连可行,主流程不动
- CORS 错误 → 我在设置页加"可选代理地址",并附 Worker 模板
