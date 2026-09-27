#requires -Version 5.1
<#
.SYNOPSIS
  重置 demo 狀態：清 AI 診斷快取與去重鎖。
.DESCRIPTION
  刻意、單獨執行的資料重置（與 dev-up.ps1 的「起服務」職責分開）。
  清除 Redis 內：
    - ai-cache:*  診斷結果快取（清掉後「首次診斷」會真的走 LLM 串流，看得到 token）
    - ai-lock:*   去重鎖（避免殘留鎖擋住重算）
  透過 `docker compose exec -T redis`（非互動，避免 TTY 卡住）執行；
  不碰 BullMQ 佇列、不碰 Mongo 資料。

  何時用：錄影 / demo 前，想確保能看到「串流 -> 完成 -> 再點同台顯示 Cached」的完整流程。
  平常開發不需執行——保留快取才能展示 Cached 與去重、也省 Gemini 額度。
.EXAMPLE
  ./scripts/demo-reset.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $root

# infra 檢查：Redis 需在線（demo-reset 只針對 Redis）
try {
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect("127.0.0.1", 6379)
  $client.Close()
} catch {
  Write-Host "Redis(6379) 未就緒，請先： docker compose up -d" -ForegroundColor Yellow
  exit 1
}

Write-Host "清除 AI 快取（ai-cache:*）與去重鎖（ai-lock:*）..." -ForegroundColor Cyan

# 送進容器的命令保持純 ASCII（避免 Windows 主控台 code page 弄壞中文）。
# --scan 非阻塞逐鍵刪；-T 關 TTY 確保非互動、不卡；> /dev/null 吞掉 DEL 回覆。
# set -e + pipefail：任一 scan/del（含管線左側）失敗即讓 sh 以非零退出、"cleared"
# 不會印出——否則尾端無條件 echo 會讓「清快取失敗」被誤判為成功（見下方守衛）。
# REDIS_PASSWORD 有值時（compose 以 --requirepass 啟用認證）改走 REDISCLI_AUTH——redis-cli 原生讀取、
# 不像 -a 會出現在行程列表與 stderr 警告；未設時不匯出，避免對無密碼的 redis 送 AUTH "" 而失敗。
# 送進容器 sh 的字串 MUST 不含雙引號：PowerShell 5.1 把參數交給外部程式（docker）時不跳脫內嵌
# 雙引號，sh 會收到 [ -n $REDIS_PASSWORD ]——空值時退化成 [ -n ] 恆為真 → 匯出空 REDISCLI_AUTH →
# 預設（未設密碼）的 demo 每次重置都失敗。故用 ${#VAR} 長度判斷（無引號也安全），賦值右側不做
# word splitting，含空白的密碼亦不需引號。外層用單引號字串，避免 PowerShell 先展開 $REDIS_PASSWORD。
$auth  = 'if [ ${#REDIS_PASSWORD} -gt 0 ]; then REDISCLI_AUTH=$REDIS_PASSWORD; export REDISCLI_AUTH; fi; '
$flush = $auth + "set -e; set -o pipefail; " +
         "redis-cli --scan --pattern 'ai-cache:*' | xargs -r redis-cli del > /dev/null; " +
         "redis-cli --scan --pattern 'ai-lock:*' | xargs -r redis-cli del > /dev/null; echo cleared"

try {
  $out = docker compose exec -T redis sh -c $flush
  if ($LASTEXITCODE -ne 0 -or $out -notmatch "cleared") { throw "docker compose exec 回傳 $LASTEXITCODE（out=$out）" }
  Write-Host "demo 狀態已重置（ai-cache / ai-lock 已清空）。" -ForegroundColor Green
} catch {
  Write-Host "重置失敗：$_" -ForegroundColor Red
  Write-Host "請確認 docker compose 服務名為 'redis' 且容器在線。" -ForegroundColor Yellow
  exit 1
}
