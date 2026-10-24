# 一键启动演示环境
#
#   npm run demo
#
# 做三件事：
#   1. 写演示数据（数据库不存在时）
#   2. 起采集服务（:4318，独立窗口）
#   3. 起管理面板（:5174，独立窗口）
#
# 采集服务要先起来 —— 面板的 /api 代理指向它。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$dbPath = Join-Path $root 'data\vigil.db'

if (-not (Test-Path $dbPath)) {
    Write-Host '[vigil] 写入演示数据...' -ForegroundColor Cyan
    npm run seed:demo
} else {
    Write-Host "[vigil] 数据库已存在，跳过播种：$dbPath" -ForegroundColor DarkGray
}

Write-Host '[vigil] 启动采集服务（:4318）' -ForegroundColor Cyan
Start-Process powershell -ArgumentList '-NoExit', '-File', (Join-Path $PSScriptRoot 'start-collector.ps1')

Start-Sleep -Seconds 6

Write-Host '[vigil] 启动管理面板（:5174）' -ForegroundColor Cyan
Start-Process powershell -ArgumentList '-NoExit', '-File', (Join-Path $PSScriptRoot 'start-dashboard.ps1')

Write-Host ''
Write-Host '面板地址  http://localhost:5174' -ForegroundColor Green
Write-Host '采集接口  http://localhost:4318' -ForegroundColor Green
Write-Host ''
