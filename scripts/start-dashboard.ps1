# 启动管理面板（dev server）
#
# 面板通过 Vite 代理把 /api 转发到本地采集服务（:4318），
# 所以采集服务要先起来。

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '[vigil] 管理面板启动中... http://localhost:5174' -ForegroundColor Cyan
npm --prefix packages/dashboard run dev
