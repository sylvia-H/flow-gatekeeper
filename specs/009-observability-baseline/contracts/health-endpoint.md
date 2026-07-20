# Contract: `GET /healthz`（api 健康端點）

**Feature**: 009-Observability-Baseline | **Owner**: `apps/api`
**滿足**: FR-005、FR-006、FR-007｜**取代**: 008 的 `/ws` 握手式容器探活（research R4a）

---

## 1. 端點

| 項目 | 值 |
| --- | --- |
| 方法／路徑 | `GET /healthz` |
| 認證 | **無**。MUST NOT 要求 token——探測端點若需 secret，compose healthcheck 與人工排查皆無法使用。 |
| Content-Type | `application/json; charset=utf-8` |
| 快取 | 無。每次請求即時探測（`Cache-Control: no-store`）。 |

## 2. 回應狀態碼（二態）

| HTTP | `status` | 條件 |
| --- | --- | --- |
| `200` | `"healthy"` | Redis **且** Mongo 皆 `up` |
| `503` | `"unhealthy"` | Redis **或** Mongo 任一 `down` |

不設 `degraded` 中間態（spec Clarifications）。理由：Redis 與 Mongo 皆為關鍵依賴，
任一失聯即無法正常服務，中間態只會讓編排器的就緒判定變含糊。

## 3. 回應 body

```jsonc
// 200 OK
{
  "status": "healthy",
  "checkedAt": "2026-07-20T09:14:22.481Z",
  "dependencies": {
    "redis": { "status": "up", "latencyMs": 3,  "error": null },
    "mongo": { "status": "up", "latencyMs": 11, "error": null }
  }
}
```

```jsonc
// 503 Service Unavailable
{
  "status": "unhealthy",
  "checkedAt": "2026-07-20T09:15:02.117Z",
  "dependencies": {
    "redis": { "status": "down", "latencyMs": null, "error": "timeout" },
    "mongo": { "status": "up",   "latencyMs": 9,    "error": null }
  }
}
```

欄位定義見 [data-model.md](../data-model.md) E2。

## 4. 探測行為

| 依賴 | 探測方式 | 連線 |
| --- | --- | --- |
| Redis | `PING` | **專屬** ioredis 連線（憲章 IV 連線分離）。MUST NOT 借用 relay 的 subscriber 連線。 |
| Mongo | `db.command({ ping: 1 })` | 複用 `HistoryService` 既有 `Db`（不另開連線）。`db` 未就緒時直接回 `down`。 |

- 兩項探測 **併行**（`Promise.all`），總耗時 ≈ 單一逾時而非相加。
- 每項獨立逾時 `HEALTH_PROBE_TIMEOUT_MS`（預設 `2000`），以 `Promise.race` 實作。
- 逾時或任何例外一律轉為 `{ status: "down", error: <原因> }`，**MUST NOT 向上拋錯**——
  端點本身不得因依賴故障而回 500 或掛住（FR-007）。
- 端點最壞回應時間 ≈ `HEALTH_PROBE_TIMEOUT_MS` + HTTP 往返，遠低於 008 compose 的 `timeout: 5s`。

## 5. 不涵蓋的範圍

- **worker 存活**：不納入。worker 由 007 的 `worker:heartbeat` 與其自身容器 healthcheck 承接
  （spec Clarifications：兩者各自獨立、不共用命名空間）。api 的 `/healthz` 不代 worker 發言。
- **LLM 供應商可達性**：不納入。外部 API 的短暫故障不應讓 api 容器被判定為不健康而重啟。

## 6. 容器 healthcheck 消費方式

`apps/api/src/healthcheck.ts` 改寫為：

```
GET http://127.0.0.1:${API_PORT}/healthz
  ├─ HTTP 200 → process.exit(0)   （healthy）
  └─ 其他/錯誤/逾時 → process.exit(1)（unhealthy）
```

**約束**：
- MUST 只用 node 內建 `http`（維持 008「healthcheck 去外部工具依賴」的收斂結論）。
- 自我逾時維持 `4000ms`（< compose `timeout: 5s`）。
- `docker-compose.yml` 的 api healthcheck `test` 指令**不需變更**
  （仍為 `["CMD", "node", "dist/healthcheck.js"]`），只有該檔內容改寫。

## 7. 相容性

- **新增端點**，不改動任何既有路由（`POST /diagnoses`）或 ws 行為 → 對 FR-012 零影響。
- 既有 `apps/api/src/lib/health-probe.ts`（`isConnectedMessage`）在切換後不再被
  `healthcheck.ts` 使用。**決定：保留該檔與其測試**（純函式、無副作用），
  但於檔頭註明「008 探活方式的歷史產物，009 起 healthcheck 改走 `/healthz`」。
  移除它會一併刪掉既有測試，收益為零。
