# Paper Parallel 本地开发辅助脚本(在项目根目录用 PowerShell 运行)
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
#   或右键 -> 使用 PowerShell 运行

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "==> 检查环境" -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[提示] 未找到 node。" -ForegroundColor Yellow
  $candidates = @(
    "$env:USERPROFILE\Downloads\node-v26.5.0-x64.msi",
    "$env:USERPROFILE\Downloads\node-v20*.msi",
    "$env:USERPROFILE\Downloads\node-v22*.msi"
  )
  $installer = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($installer) {
    Write-Host "发现安装包: $installer" -ForegroundColor Green
    Write-Host "即将启动安装。请完成安装(默认选项即可,会加入 PATH),安装完成后重新运行本脚本。" -ForegroundColor Cyan
    Start-Process $installer
    exit 1
  }
  Write-Host "[错误] 未找到 node 安装包。请访问 https://nodejs.org 安装 Node.js 20+ 后重试。" -ForegroundColor Red
  exit 1
}
Write-Host "node: $(& node --version)"
Write-Host "npm:  $(& npm --version)"

if (-not (Test-Path "$Root\node_modules")) {
  Write-Host "==> 首次运行,安装依赖(npm install)" -ForegroundColor Cyan
  & npm install
  if ($LASTEXITCODE -ne 0) { Write-Host "[错误] npm install 失败" -ForegroundColor Red; exit 1 }
} else {
  Write-Host "==> node_modules 已存在,跳过安装(如需重装请删除该目录)" -ForegroundColor Cyan
}

Write-Host "==> 启动开发服务器 (http://localhost:5173)" -ForegroundColor Cyan
& npm run dev
