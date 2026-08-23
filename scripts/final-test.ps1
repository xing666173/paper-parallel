# Paper Parallel 最终测试入口
# 1) 全量检查(typecheck + 14 个测试文件 + build)
# 2) 通过后自动在浏览器打开 P19 端到端运行器
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 心跳文件:脚本一启动就记录,便于开发者判断执行进度
$ReportDir = Join-Path $Root "reports"
if (-not (Test-Path $ReportDir)) { New-Item -ItemType Directory -Path $ReportDir | Out-Null }
"run start: $(Get-Date -Format o)" | Out-File (Join-Path $ReportDir "last-run.txt") -Encoding utf8

# 环境自检:没有 Node 则尝试启动本机安装包
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[提示] 未找到 node。正在检查常见安装包..." -ForegroundColor Yellow
  $installer = @("$env:USERPROFILE\Downloads\node-v26.5.0-x64.msi") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($installer) {
    Write-Host "发现: $installer" -ForegroundColor Green
    Write-Host "正在启动安装。请完成安装(默认选项,加入 PATH)后重新运行本脚本。" -ForegroundColor Cyan
    Start-Process $installer
    exit 1
  }
  Write-Host "[错误] 未找到 node 且无安装包。请到 https://nodejs.org 安装 Node.js 20+ 后重试。" -ForegroundColor Red
  exit 1
}

Write-Host "==> [1/3] 依赖安装(首次运行)" -ForegroundColor Cyan
if (-not (Test-Path "$Root\node_modules")) {
  & npm install
  if ($LASTEXITCODE -ne 0) { Write-Host "npm install 失败,请检查网络后重试。" -ForegroundColor Red; exit 1 }
} else {
  Write-Host "node_modules 已存在,跳过安装"
}

Write-Host "==> [2/3] 全量检查(结果自动保存到 reports\check-output.txt)" -ForegroundColor Cyan
$ReportDir = Join-Path $Root "reports"
if (-not (Test-Path $ReportDir)) { New-Item -ItemType Directory -Path $ReportDir | Out-Null }
$ReportFile = Join-Path $ReportDir "check-output.txt"
"check start: $(Get-Date -Format o)" | Out-File $ReportFile -Encoding utf8
& powershell -ExecutionPolicy Bypass -File "$Root\scripts\check.ps1" *>&1 | Tee-Object -FilePath $ReportFile -Append
$checkExit = $LASTEXITCODE
"check exit code: $checkExit at $(Get-Date -Format o)" | Out-File $ReportFile -Append -Encoding utf8
if ($checkExit -ne 0) {
  Write-Host "检查未通过。输出已保存到 reports\check-output.txt,请告诉开发者。" -ForegroundColor Red
  exit 1
}

Write-Host "==> [3/3] 打开 P19 端到端运行器" -ForegroundColor Cyan
$runner = "$Root\probes\P19-e2e-runner.html"
if (-not (Test-Path $runner)) { Write-Host "找不到 $runner" -ForegroundColor Red; exit 1 }
Start-Process $runner

Write-Host ""
Write-Host "P19 操作步骤:" -ForegroundColor Yellow
Write-Host "  1. 先点 '无文件合成演示(mock)' 确认链路通过"
Write-Host "  2. 选择英文 PDF: Desktop\文献\导师文章\18:ZK-Tracer...pdf"
Write-Host "  3. 引擎选 mock 跑通全流程"
Write-Host "  4. 再选 real,填 DeepSeek API Key,跑真实翻译"
Write-Host "  5. 把阶段输出发给开发者,并下载项目包 JSON"
