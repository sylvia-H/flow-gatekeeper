#requires -Version 5.1
<#
.SYNOPSIS
  一鍵起本機開發全棧：seed -> api -> worker -> web。
.DESCRIPTION
  前置：Redis + MongoDB 需先自行起好（docker compose up -d）。
  本腳本只負責「把服務起起來」，不動任何資料：
    1) 檢查 infra（Redis 6379 / Mongo 27017）可連，未就緒即中止並提示。
    2) 同步跑一次 `pnpm --filter api seed`（等它跑完；失敗即中止）。
    3) 各開一個新 PowerShell 視窗，分別啟動 api / worker / web 三個長駐服務
       （分開看 log、可各自 Ctrl-C；貼合實作指南 §16.1 的 4-terminal 模型）。

  註：demo 前若要「清 AI 快取讓首次診斷可見串流」，那是刻意的資料重置，
  請單獨執行 `./scripts/demo-reset.ps1`（與啟動分開，職責清楚）。
.PARAMETER SkipSeed
  已 seed 過可跳過 seed 步驟。
.EXAMPLE
  ./scripts/dev-up.ps1
.EXAMPLE
  ./scripts/dev-up.ps1 -SkipSeed
#>
[CmdletBinding()]
param(
  [switch]$SkipSeed
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $root

function Test-Port {
  param([string]$TargetHost, [int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect($TargetHost, $Port)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

Write-Host "== flow-gatekeeper dev-up ==" -ForegroundColor Cyan
Write-Host "repo: $root"

# 1) infra 檢查（Redis + Mongo 需先 docker compose up -d）
$redisUp = Test-Port -TargetHost "127.0.0.1" -Port 6379
$mongoUp = Test-Port -TargetHost "127.0.0.1" -Port 27017
if (-not ($redisUp -and $mongoUp)) {
  Write-Host ("infra 未就緒 -> Redis(6379)={0}  Mongo(27017)={1}" -f $redisUp, $mongoUp) -ForegroundColor Yellow
  Write-Host "請先啟動 infra： docker compose up -d" -ForegroundColor Yellow
  exit 1
}
Write-Host "infra OK：Redis 6379 / Mongo 27017" -ForegroundColor Green

# 2) seed（同步等待完成——維護紀錄需先寫入 Mongo，供診斷 context 使用）
if (-not $SkipSeed) {
  Write-Host "seeding（pnpm --filter api seed）..." -ForegroundColor Cyan
  pnpm --filter api seed
  if ($LASTEXITCODE -ne 0) {
    Write-Host "seed 失敗，中止。" -ForegroundColor Red
    exit 1
  }
  Write-Host "seed 完成。" -ForegroundColor Green
} else {
  Write-Host "略過 seed（-SkipSeed）。" -ForegroundColor DarkGray
}

# 3) 起三個長駐服務，各開新視窗（標題便於辨識；關閉即停該服務）
# 注意：函式名不可用 Start-Service —— 會覆蓋 PowerShell 內建的服務管理 cmdlet。
function Start-DevService {
  param([string]$Title, [string]$Filter, [string]$Script)
  $inner = "`$host.UI.RawUI.WindowTitle='$Title'; Set-Location '$root'; pnpm --filter $Filter $Script"
  Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-NoProfile", "-Command", $inner | Out-Null
  Write-Host ("started {0}  (pnpm --filter {1} {2})" -f $Title, $Filter, $Script) -ForegroundColor Green
}

Start-DevService -Title "fg-api"    -Filter "api"    -Script "start:dev"
Start-DevService -Title "fg-worker" -Filter "worker" -Script "start:dev"
Start-DevService -Title "fg-web"    -Filter "web"    -Script "dev"

Write-Host ""
Write-Host "全部啟動中：api -> http://localhost:3000（ws /ws）、web -> http://localhost:5173" -ForegroundColor Cyan
Write-Host "首次啟動需數十秒編譯；web 就緒後開瀏覽器即可。" -ForegroundColor DarkGray
Write-Host "停止：分別在 fg-api / fg-worker / fg-web 視窗按 Ctrl-C（或關閉視窗）。" -ForegroundColor DarkGray
