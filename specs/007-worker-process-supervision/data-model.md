# Data Model: Worker Process Supervision（Phase 1）

本 feature 不新增任何 MongoDB collection 或 `packages/contracts` payload；實體皆為**運維層狀態**（容器、Redis 暫態 key、env 設定、log 記錄）。欄位契約細節見 [contracts/supervision-runtime.md](./contracts/supervision-runtime.md)。

## E1：受監督執行形態（compose worker service）

worker 的可部署服務定義（spec Key Entity 1）。

| 欄位 | 值 | 對應需求 |
|------|-----|---------|
| `build.context` / `build.dockerfile` | repo root / `apps/worker/Dockerfile`（多階段，見 research D2） | FR-001 |
| `profiles` | `["supervised"]`——未帶 profile 的既有指令不受影響 | FR-010、SC-008 |
| `restart` | `on-failure:5`（退避為 Docker 內建） | FR-004、FR-006 |
| `init` | `true`——tini 為 PID 1、node 為子行程；同 namespace 對 PID 1 送 SIGSTOP 會被核心忽略，US5 活鎖演練需凍結 node 子行程（見 research D5） | SC-005 驗收方法 |
| `depends_on` | `redis`、`mongo` | FR-001 |
| `env_file` | `apps/worker/.env`（祕密與調參，執行時注入、不進 image） | 憲章 VI |
| `environment` | 覆蓋容器網路位址：`REDIS_HOST=redis`、`MONGO_URL=mongodb://mongo:27017/flow-gatekeeper` | FR-002 |
| `stop_grace_period` | `45s`（涵蓋 `worker.close()` 最長收尾，見 research D7） | FR-009、SC-007 |
| `healthcheck` | `node dist/healthcheck.js`；`interval: 30s` / `timeout: 5s` / `retries: 3` / `start_period: 30s` | FR-007 |

## E2：存活訊號（heartbeat）

| 屬性 | 值 |
|------|-----|
| Key | `worker:heartbeat`（單實例假設，見 research D5） |
| Value | 寫入當下 ISO timestamp（值僅供人工判讀，判定只看 key 存活） |
| TTL | 30 秒（`SET ... EX 30`） |
| 寫入週期 | 10 秒（`setInterval`，掛在既有 `cache` 連線） |
| 生命週期 | worker ready 後開始；優雅關閉時清除 timer；致命退出時隨行程消失、key 於 TTL 內自然過期 |

**判定規則**：healthcheck 讀 `PTTL worker:heartbeat` > 0 → 健康（exit 0）；key 不存在或已過期 → 不健康（exit 1）。連續 3 次不健康才轉容器 unhealthy（誤判容忍，Edge case「存活訊號的誤判」）。

## E3：故障注入旗標（chaos config）

解析函式 `parseChaosConfig(env)` 為純函式（vitest 標的）。

| 變數 | 合法值 | 預設 | 語意 |
|------|--------|------|------|
| `WORKER_CHAOS` | `uncaught` \| `rejection` | 未設定＝關閉 | 注入的致命錯誤型態（FR-008） |
| `WORKER_CHAOS_AT` | `startup` \| `job` | `startup` | 注入時點：bootstrap 後約 2s ／ 下一筆 job active 時（clarify Q1） |

**驗證規則**：`WORKER_CHAOS` 非法值 → 記 warn、視為關閉（零影響原則）；`WORKER_CHAOS_AT` 僅在 `WORKER_CHAOS` 生效時有意義。

## E4：致命事件記錄（fatal log entry）

`formatFatal(kind, value)` 為純函式（vitest 標的）。

| 組成 | 規則 |
|------|------|
| 格式 | `[worker] <kind>（致命，worker 將結束交由監督者重啟）：<detail>` |
| `kind` | `uncaughtException` \| `unhandledRejection` |
| `detail` | `value instanceof Error ? (stack ?? message) : String(value)`——非 Error 值一致處理（FR-003） |
| 用途 | 與 Docker 重啟事件對照即可判讀「致命 → 重啟」先後（FR-004） |

## 狀態轉移

### 容器生命週期（監督者視角）

```text
running ──exit(0)（優雅關閉）──▶ exited(0)          【不重啟；on-failure 語意】
running ──exit(1)（致命）──▶ exited(1) ──退避後自動重啟──▶ running
   └─ 連續快速失敗：退避間隔逐次遞增（100ms 起翻倍）
      └─ 第 5 次重啟後仍失敗 ──▶ exited(1) 停止【RestartCount=5，可從 docker ps -a / inspect 判讀】
```

### 健康狀態（與生命週期正交，僅示警）

```text
starting（start_period 30s 內）──首次 healthcheck 通過──▶ healthy
healthy ──連續 3 次失敗（heartbeat 停 ≳60–90s）──▶ unhealthy   【不觸發自動重啟】
unhealthy ──heartbeat 恢復、healthcheck 通過──▶ healthy
```

**兩種故障情境的判別**（US5 場景 3）：行程死亡 → 容器 `exited`/`restarting`（監督者已處理）；活著但卡住 → 容器 `running` 且 `unhealthy`（需人工介入）。
