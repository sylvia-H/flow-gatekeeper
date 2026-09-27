# 運維層契約：Worker Supervision Runtime（Phase 1）

**定位**：本 feature 對 `packages/contracts`／`asyncapi.yaml` **零變更**（無新跨端 event/payload）。本檔記錄的是 worker 行程與監督者（Docker/compose）、運維者之間的**運維層介面**——exit code、env 變數、Redis key、健康狀態與 log 格式。實作端（main.ts、Dockerfile、compose）MUST 與本檔一致。

## 1. Exit code 契約（行程 ↔ 監督者）

| Exit code | 觸發路徑 | 監督者（`restart: on-failure:5`）行為 |
|-----------|---------|--------------------------------------|
| `0` | 優雅關閉完成（SIGTERM/SIGINT → close → quit） | 不重啟（正常停止） |
| `1` | 致命：`uncaughtException`／`unhandledRejection`（含 chaos 注入）、bootstrap 失敗 | 依退避自動重啟；連續失敗 5 次後停止 |
| `137` 等（SIGKILL） | `stop_grace_period`（45s）內未收尾被強制終止 | 視為異常——SC-007 要求 0 次發生 |
| `143`（SIGTERM 預設處置） | stop 的 SIGTERM 落在行程啟動早期、handler 尚未掛上（如「致命觸發重啟中」與 stop 重疊的窗口） | 屬 stop 意圖——手動 stop 優先於 on-failure，不重啟；非異常（詳見 quickstart 場景 3b） |

## 2. 環境變數契約（新增項；既有項見 `apps/worker/.env.example`）

| 變數 | 合法值 | 預設 | 說明 |
|------|--------|------|------|
| `WORKER_CHAOS` | `uncaught` \| `rejection` | （未設定＝關閉） | 故障注入型態；非法值 warn 後視為關閉。**僅供演練，預設 MUST 關閉** |
| `WORKER_CHAOS_AT` | `startup` \| `job` | `startup` | 注入時點：bootstrap 後約 2s／下一筆 job active 期間 |
| `WORKER_CHAOS_ALLOW_IN_PRODUCTION` | `true` \| `false`（不分大小寫） | `false` | production 守衛的明確開關：`NODE_ENV=production`（容器 image 內建）時 chaos **預設拒絕武裝**（只記一則 error），設 `true` 才放行；非法值 warn 後視為 `false`。容器內演練時與上兩個變數同時設定，演練後三者一併清空 |

**容器內連線覆蓋**（compose `environment`，優先於 `env_file`）：`REDIS_HOST=redis`、`MONGO_URL=mongodb://mongo:27017/flow-gatekeeper`——host 直跑模式照舊用 `.env` 的 `127.0.0.1`，兩模式互不干擾。

## 3. Heartbeat 契約（worker ↔ healthcheck）

| 項目 | 值 |
|------|-----|
| Key | `worker:heartbeat` |
| 寫入 | worker ready 後每 10s `SET worker:heartbeat <ISO ts> EX 30`（`cache` 連線） |
| 讀取 | `dist/healthcheck.js`（獨立進入點，不 import main）：`PTTL > 0` → exit 0，否則 exit 1 |
| 停止 | 優雅關閉清 timer；致命退出後 key 於 ≤30s 內自然過期 |

## 4. Compose healthcheck 契約

```yaml
healthcheck:
  test: ["CMD", "node", "dist/healthcheck.js"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 30s
```

健康狀態語意：`healthy`＝存活訊號有效期內持續更新；`unhealthy`＝訊號停止逾判定門檻（典型約 60–90s；最壞約 120s——TTL 殘餘與檢查相位對齊時，量測自訊號停止時點）——**僅示警、不觸發自動重啟**（spec FR-007）。

## 5. 致命事件 log 契約

```text
[worker] <kind>（致命，worker 將結束交由監督者重啟）：<detail>
```

- `<kind>` ∈ `uncaughtException` | `unhandledRejection` | `invalidConfig` | `bootstrap`；`<detail>`＝Error 的 `stack ?? message`，非 Error 值一律 `String(value)`。一律同步寫 stderr 後 `exit(1)`。
  - `invalidConfig`：bootstrap 最前面的 env 驗證失敗（此時 logger 尚未建立）。
  - `bootstrap`：env 通過後的啟動流程失敗（Mongo 連不上、Redis 未於時限內就緒…），由 `bootstrap().catch` 送入；與 api 的 `fatalExit("bootstrap", err)` 同名，跨 process 可一併檢索。
- **bootstrap 失敗**（FR-003 的第三種致命來源）原先不套 `formatFatal`、沿用 `[worker] bootstrap failed: <detail>` 格式；已變更為上述 `bootstrap` kind，監督語意不變（exit code `1`、依退避重啟）。
- 判讀「致命 → 重啟」：上述 log 之後，容器重啟、worker 重新輸出 `worker ready, consuming queue ...`（既有 log），以 `docker logs --timestamps` 對照先後（FR-004）。

## 6. 運維指令契約（README「雙模式」章節 MUST 涵蓋）

| 情境 | 指令 |
|------|------|
| 開發模式（零變化） | `docker compose up -d`（只起 infra）→ `./scripts/dev-up.ps1` |
| 受監督模式啟動 | `docker compose --profile supervised up -d --build` |
| 受監督模式停止（優雅） | `docker compose --profile supervised stop worker`（SIGTERM，45s 寬限） |
| 健康／重啟狀態查詢 | `docker ps`（STATUS 欄含 health）；`docker inspect --format "{{.RestartCount}} {{.State.Status}} {{.State.Health.Status}}" <worker>` |
| 記錄判讀 | `docker logs --timestamps <worker>` |
