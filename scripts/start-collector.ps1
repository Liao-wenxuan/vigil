# 启动采集服务
#
# 演示用的固定配置：
#   管理 token  vigil_admin_demo  ← 面板用它调管理 API
#   数据库      data/vigil.db
#   端口        4318
#
# 正式部署时管理 token 必须用环境变量注入，不能写死在代码里。

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:VIGIL_ADMIN_TOKEN = 'vigil_admin_demo'
$env:VIGIL_DB_PATH = Join-Path $root 'data\vigil.db'
$env:PORT = '4318'

Write-Host '[vigil] 采集服务启动中... http://localhost:4318' -ForegroundColor Cyan
npm --prefix packages/collector run dev
