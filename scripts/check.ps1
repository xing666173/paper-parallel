# Paper Parallel 一键自检:typecheck -> unit test -> build
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path "$Root\node_modules")) {
  Write-Host "==> 依赖未安装,先执行 scripts\dev.ps1 或 npm install" -ForegroundColor Red
  exit 1
}

Write-Host "==> [1/3] TypeScript 类型检查" -ForegroundColor Cyan
& npm run typecheck
if ($LASTEXITCODE -ne 0) { Write-Host "[失败] 类型检查未通过" -ForegroundColor Red; exit 1 }

Write-Host "==> [2/3] 单元测试" -ForegroundColor Cyan
& npm test
if ($LASTEXITCODE -ne 0) { Write-Host "[失败] 测试未通过" -ForegroundColor Red; exit 1 }

Write-Host "==> [3/3] 生产构建" -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "[失败] 构建未通过" -ForegroundColor Red; exit 1 }

Write-Host "`n全部通过 ✅" -ForegroundColor Green
