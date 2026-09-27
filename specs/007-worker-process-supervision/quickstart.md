# Quickstart: Worker Process Supervision 驗收指南（Phase 1）

可重播的端到端驗收場景，對應 spec US1–US5 與 SC-001–SC-008。指令與狀態語意見 [contracts/supervision-runtime.md](./contracts/supervision-runtime.md)；參數依據見 [research.md](./research.md)。

## 前置

- Docker Desktop 運行中；`apps/worker/.env` 已就緒（`GEMINI_API_KEY` 有值；`WORKER_CHAOS` **未設定**）。
- infra：`docker compose up -d`（redis + mongo）。
- 觸發診斷的方式沿用既有 live 驗收做法（web 監控台觸發，或既有 seed/demo 流程）。
- 以下 `<worker>` 代表 worker 容器名（`docker ps` 可查）。
- compose 分組名：007 時為 `supervised`，Feature 008 起改為 `demo`（涵蓋 worker／api／web／seed）；以下指令已改用 `demo` 並指名 `worker`，只起受監督 worker。

## 場景 1：受監督形態端到端一致（US1 → SC-001）

```powershell
docker compose --profile demo up -d --build worker   # 指名 worker：demo 分組另含 api／web／seed，本場景只起 worker
docker ps   # worker 應為 Up；US5（T023）交付 healthcheck 後才會顯示 Up (healthy)（start_period 過後）
```

1. host 端**不要**啟動 dev worker（避免兩個 consumer 搶 job）；api/web 照 dev-up 起或既有方式。
2. 從監控台觸發一筆診斷 → 串流 token、診斷結果與直跑模式一致。
3. 同一機台同嚴重度再觸發 → cache 命中（`cached: true`、不重複打 LLM）。
4. **預期**：行為與本機直跑無差異；worker log 無致命訊息。

## 場景 2：優雅關閉（US1 場景 3 → SC-007）

```powershell
docker compose --profile demo stop worker
docker inspect --format "{{.State.ExitCode}}" <worker>   # 預期 0
```

**預期**：log 出現既有 `received SIGTERM, shutting down worker...`；45s 寬限內收尾；ExitCode 0（非 137）→ 0 次強制中斷；停止後**不**自動重啟（on-failure 語意）。

## 場景 3：致命 → 重啟 → 恢復（US2 + US3 → SC-002、SC-003、SC-006）

在 `apps/worker/.env` 設 `WORKER_CHAOS=uncaught`、`WORKER_CHAOS_AT=job`，**並同時設 `WORKER_CHAOS_ALLOW_IN_PRODUCTION=true`**，然後：

> **為什麼要 `WORKER_CHAOS_ALLOW_IN_PRODUCTION=true`**：worker 映像內建 `ENV NODE_ENV=production`，而 chaos 守衛在 production
> 預設拒絕武裝（只記一則「WORKER_CHAOS 於 production 預設忽略」的 error，不會崩潰）——不加這個開關，容器內演練不會生效。
> host 直跑（未設 `NODE_ENV`）不需要此開關。

```powershell
docker compose --profile demo up -d worker   # 重建容器吃新 env（不需 --build）
```

1. 觸發一筆診斷（避開 cache：換機台或先跑 `scripts/demo-reset.ps1`）。
2. job 進入處理 → worker 拋未捕捉例外 → log 出現 `uncaughtException（致命，worker 將結束交由監督者重啟）：...`。
3. Docker 自動重啟 worker（`docker logs --timestamps` 判讀「致命 → ready」先後）。
4. **量測 SC-002**：自致命 log 時點起算 60s 內恢復消化——判定事件為重啟後的 worker 可處理**新** job（`worker ready` 後觸發新診斷即被消化）。
5. **量測 SC-003**：崩潰當下 in-flight 那筆 job 在 lock 過期＋stalled 掃描（最壞約 60–90s）後被重新消化或走 `ai/error` 終態——不永久卡死。
6. 換 `WORKER_CHAOS=rejection` 重演 → 同樣走「致命 → 重啟 → 恢復」。
7. **量測 SC-006**：同一設定連續重演 3 次，結果一致；全程未改 code、未重新 build。
8. 演練畢：清空 `WORKER_CHAOS`、`WORKER_CHAOS_AT`、`WORKER_CHAOS_ALLOW_IN_PRODUCTION` 三個變數、`up -d worker` → 行為恢復完全正常（US3 場景 5）。

## 場景 3b：停止指令與致命事件重疊（US2 場景 4 → FR-009）

沿用場景 3 的設定（`WORKER_CHAOS=uncaught`、`WORKER_CHAOS_AT=job`、`WORKER_CHAOS_ALLOW_IN_PRODUCTION=true`）：

1. 觸發一筆診斷，待 job 進入處理後**立即**下 `docker compose --profile demo stop worker`，使優雅關閉與致命注入在同一窗口重疊。
2. **預期**：行程仍在 45s 寬限期內終止（**不得為 137**＝寬限不足被 SIGKILL）；容器不卡住、不遺留半開連線；停止為明確指令，Docker 不重啟（stop 意圖優先於 on-failure）。ExitCode 依重疊時序有三種合法結局：`0`（stop 先完成優雅關閉）、`1`（致命搶先結束）、`143`（致命已觸發重啟，SIGTERM 落在**重啟中新行程**尚未掛好 handler 的啟動早期窗口——實測 `job` 時點注入在 job active 後毫秒級觸發，而 `compose stop` 下達有秒級延遲，此結局最常見）。
3. 若時序未重疊（job 先拋致命才收到 stop），重跑一次即可——本場景驗的是「兩路徑互不干擾」（即刻終止、非 137、stop 後維持停止），不要求每次精準重疊、也不要求特定 ExitCode。

## 場景 4：崩潰迴圈防護（US4 → SC-004）

設 `WORKER_CHAOS=uncaught`、`WORKER_CHAOS_AT=startup`，並同時設 `WORKER_CHAOS_ALLOW_IN_PRODUCTION=true`（理由同場景 3；演練後三個變數一併清空）→ `docker compose --profile demo up -d worker`：

```powershell
# 另開視窗觀察：restart policy 的自動重啟只發 die/start 事件（不發 restart 事件），die 時戳間距即退避間隔
docker events --filter "container=<worker>" --filter "event=die"
docker inspect --format "{{.RestartCount}} {{.State.Status}}" <worker>
```

**預期**：worker 啟動約 2s 即致命退出；重啟間隔逐次遞增（timestamps 可觀察）；`RestartCount` 達 5 後容器停在 `exited`；**之後 10 分鐘無新重啟**；期間 LLM/DB 消耗受退避節制（log 無密集連打）。

## 場景 5：活著但卡住（US5 → SC-005）

正常運行（chaos 關閉）下：

```powershell
docker inspect --format "{{.State.Health.Status}}" <worker>   # healthy
# 凍結 node 子行程模擬活鎖。不可 kill -STOP 1：同 PID namespace 對 PID 1 送 SIGSTOP 會被核心忽略
#（pid_namespaces(7)）；worker service 已設 init: true（tini 為 PID 1、node 為子行程）
docker exec <worker> sh -c 'kill -STOP $(pgrep -f dist/main.js)'
# 以「訊號停止」（kill -STOP）時點起算：典型 ~90s、最壞 ~120s（TTL 殘餘＋檢查相位對齊時）
docker inspect --format "{{.State.Status}} {{.State.Health.Status}}" <worker>   # running unhealthy
docker exec <worker> sh -c 'kill -CONT $(pgrep -f dist/main.js)'   # 恢復 → 回 healthy
```

**預期**：容器 `running` 但 `unhealthy`（與「行程死亡→exited/restarting」可判別，US5 場景 3）；全程**不**自動重啟（示警定位）。

## 場景 6：開發模式零影響（US1 場景 4 → SC-008）

```powershell
docker compose --profile demo rm -sf worker   # 只收掉受監督 worker（勿用 down——會連 redis/mongo 一起移除）
docker compose up -d                        # 既有指令：只起 infra，無 worker 容器
./scripts/dev-up.ps1                        # 照常開三視窗、熱重載照常
```

**預期**：既有流程與腳本零差異；README 已寫明雙模式切換與「dev 模式致命錯誤後停在等待檔案變更、不自動重啟」的已知差異（FR-010）。

**選做（US2 場景 5 實測）**：dev 模式下於 `apps/worker/.env` 暫設 `WORKER_CHAOS=uncaught`（時點預設 `startup`）再啟動 worker——行程記錄致命訊息後結束，`tsx watch` 停在等待檔案變更、不自動重啟，與文件描述一致；驗畢移除旗標。

## 單元測試（憲章測試門檻）

```powershell
pnpm --filter worker test        # chaos 解析、fatal 訊息格式化、heartbeat 新鮮度
pnpm check                       # contract lint + typecheck + lint + test 全綠
```

## SC 對照

| SC | 場景 | SC | 場景 |
|----|------|----|------|
| SC-001 | 1 | SC-005 | 5 |
| SC-002 | 3 | SC-006 | 3 |
| SC-003 | 3 | SC-007 | 2 |
| SC-004 | 4 | SC-008 | 6 |
