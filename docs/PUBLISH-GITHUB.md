# 发布到 GitHub Pages(全程不用终端)

你的电脑已安装 GitHub Desktop(桌面有图标)。按下面点击即可发布,CI 会在 GitHub 云端自动完成"安装依赖 → 类型检查 → 14 个测试 → 构建 → 部署"。

## 第一步:用 GitHub Desktop 添加仓库(1 分钟)

1. 双击桌面 **GitHub Desktop**(先登录你的 GitHub 账号)
2. 菜单 `File → Add local repository…`
3. 选择文件夹:`C:\Users\axezt\Documents\GitHub\paper-parallel`
4. 它会提示"这不是 Git 仓库,是否创建?" → 点 **create a repository**
5. Name 填 `paper-parallel`,点 **Create repository**

## 第二步:发布到 GitHub(1 分钟)

1. 在 GitHub Desktop 点右上角 **Publish repository**
2. Name:`paper-parallel`;Description 随意
3. 取消勾选 **Keep this code private**(选 Public,免费 Pages 需要公开)
4. 点 **Publish repository**
5. 等待上传完成(纯文件,几十秒)

## 第三步:开启 Pages(网页上点,1 分钟)

1. 浏览器打开 `https://github.com/<你的用户名>/paper-parallel`
2. 点 **Actions** 标签,等第一次 workflow 变绿(它自动跑测试并推送 `gh-pages` 分支)
3. 点 **Settings → Pages**
4. **Source** 选 `Deploy from a branch`;Branch 选 `gh-pages`、文件夹 `/ (root)`;Save
5. 等 1–2 分钟,页面顶部会显示你的网址

## 你的网址(格式)

- 主页:`https://<你的用户名>.github.io/paper-parallel/`
- 端到端测试器:`https://<你的用户名>.github.io/paper-parallel/probes/P19-e2e-runner.html`

## 如果有红叉

打开 Actions 里失败的 job,把红色错误文本复制发我(或截图),我在本地修好后你只需在 GitHub Desktop 点一次 **Fetch origin**(无需终端)。

## 安全说明

- API Key 不在代码里;`probes/assets/local/` 与 `reports/` 已 gitignore,不会上传
- 论文 PDF 不上传,只在你自己浏览器里选择
