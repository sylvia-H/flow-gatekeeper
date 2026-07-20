# Contract: 指標摘要（日誌形狀 + `system/metrics` ws 訊息）

**Feature**: 009-Observability-Baseline
**滿足**: FR-008、FR-008a、FR-009｜**契約來源**: `packages/contracts/src/events.ts` + `asyncapi.yaml`

---

## 1. 型別定義（`packages/contracts/src/events.ts` 新增）

依憲章 III「型別來源分層」——這是做 `switch(type)` 分派、由本系統自身產生的傳輸訊息，
**以 TS 型別定義**，與既有 `system/connected`／`job/status`／`machine/data` 一致，不引入 Zod。

```ts
/** worker 回報的指標（來自 Redis 快照）；worker 缺席時整體為 null。 */
export type WorkerMetrics = {
  snapshotAt: string;
  llmLatency: {
    count: number;
    avgMs: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  cache: {
    hits: number;
    misses: number;
    /** hits / (hits + misses)；分母為 0 時為 null（**不是 0**）。 */
    hitRate: number | null;
  };
};

/** system/metrics：伺服器週期廣播的營運指標摘要（009）。 */
export type SystemMetrics = {
  type: "system/metrics";
  windowMs: number;
  collectedAt: string;
  queue: { waiting: number; active: number; failed: number };
  wsConnections: number;
  worker: WorkerMetrics | null;
};
```

並納入既有聯集：

```ts
export type ServerControlMessage =
  | SystemConnected
  | MachineSubscribed
  | Pong
  | SystemUnauthorized
  | SystemMetrics;   // ← 新增
```

`asyncapi.yaml` MUST 同步新增此訊息定義（憲章 II：契約與 AsyncAPI 為單一來源）。

## 2. 傳輸語意

| 項目 | 值 |
| --- | --- |
| 方向 | server → client |
| 觸發 | 每 `METRICS_INTERVAL_MS`（預設 60000，下限 5000）一次 |
| 對象 | **廣播給所有已連線 client**，與 `machine/subscribe` 訂閱狀態無關 |
| 授權 | 不需訂閱授權（與 `system/connected` 同級的系統訊息） |
| 保證 | at-most-once。漏送一則即等下一週期，**不重送、不補發** |

**為何廣播而非只送訂閱者**：指標是系統級資訊，不隸屬任何機台；用機台訂閱過濾它在語意上不成立。

### 2.1 前端新鮮度判定（FR-008a）

| 項目 | 值 |
| --- | --- |
| 新鮮度來源 | payload 的 `collectedAt`（api 結算時間，非前端收訊時間） |
| 過期門檻 | **2 × `METRICS_INTERVAL_MS`**（預設 120 秒）未收到新快照即視為過期 |
| 過期呈現 | 面板 MUST 以過期樣態呈現（數值仍可顯示，但 MUST NOT 看起來像即時值） |

**為何是 2×**：本訊息的保證是 at-most-once、不重送不補發（見上表），漏收單一則屬正常運作範圍，
連續漏兩則才代表真的停更。1.5× 會讓一次抖動就誤報過期；3× 要三分鐘才看得出停更（research R11）。

**MUST NOT 與 `metrics:worker` 的 TTL（3 × 間隔）對齊**：那是後端快照的存活期（決定
`worker` 是否降級為 `null`），與前端「多久沒收到廣播」是不同層的問題。

## 3. ⚠️ 前端處理紀律（憲章 IV 的邊界說明）

`system/metrics` 是 **60 秒一則的低頻控制訊息**，**MUST NOT** 進入 `machine/data` 的
rAF buffer 批次提交路徑。

- **正確**：於 ws 訊息分派收到後**直接寫入** metrics store（低頻，直接 reactive 寫入無虞）。
- **錯誤**：塞進 telemetry buffer → 會延遲到下一批遙測才顯示，且**污染背壓比值的量測**
  （賣點一的核心證據）。

憲章 IV 的「高頻事件先進 buffer、rAF 批次提交」針對的是每 50ms 的 `machine/data`。
此段須在程式註解中複述，避免後續 review 誤判為違反硬規則。

## 4. 日誌形狀

api 每週期以**專屬 child logger**（`context: "metrics"`）輸出一則，欄位與上述 payload 同構
（去掉 `type`，加上 E1 的共通欄位）：

```jsonc
{
  "level": 30,
  "time": 1784286862481,
  "service": "api",
  "context": "metrics",
  "msg": "metrics summary",
  "windowMs": 60000,
  "queue": { "waiting": 0, "active": 1, "failed": 2 },
  "wsConnections": 3,
  "worker": {
    "snapshotAt": "2026-07-20T09:14:20.004Z",
    "llmLatency": { "count": 4, "avgMs": 2184, "p95Ms": 3902, "maxMs": 4011 },
    "cache": { "hits": 3, "misses": 1, "hitRate": 0.75 }
  }
}
```

worker 另於同週期輸出**自身那半**（`service: "worker"`、`context: "metrics"`），
使 worker 日誌可獨立判讀（research R5）。

**等級獨立**：此 child logger 的 level 由 `METRICS_LOG_LEVEL`（預設 `info`）釘定，
**不受 `LOG_LEVEL` 影響**——滿足 spec Edge Case「觀測能力不隨一般過濾失效」與 SC-005 後半段。

## 5. 跨行程快照（內部，非對外契約）

| 項目 | 值 |
| --- | --- |
| Key | `metrics:worker` |
| 值 | `WorkerMetrics` 的 JSON |
| 寫入 | worker，`SET metrics:worker <json> EX <3 × 間隔秒數>` |
| 讀取 | api，`GET`（非破壞性；不 `DEL`） |

**降級規則**：api 端對 key 不存在、`JSON.parse` 失敗、欄位缺漏或型別不符，
一律降級為 `worker: null` 並照常輸出摘要，**MUST NOT 拋錯中斷**。

**與 007 `worker:heartbeat` 的關係**：各自獨立、不同命名空間、不同 TTL、不同消費者，
MUST NOT 互相取代（spec Clarifications、data-model E4）。

## 6. 指標語意約定

| 指標 | 型態 | 歸零 |
| --- | --- | --- |
| `queue.waiting` / `active` / `failed` | gauge（BullMQ `getJobCounts()` 瞬時值） | 不歸零 |
| `wsConnections` | gauge（瞬時） | 不歸零 |
| `llmLatency.*` | 窗內樣本統計 | **每週期歸零** |
| `cache.hits` / `misses` / `hitRate` | 窗內計數 | **每週期歸零** |

「窗內」而非「累計」的理由：累計值在長跑後會被歷史稀釋，讀者無法判斷「**此刻**行為是否正常」
——那正是 US3 的目的。

## 7. FR-009 遵循：高頻 telemetry 不得逐筆入日誌

指標蒐集**MUST NOT** 在 `publishTelemetry()`（每 50ms）或 `persistBatch` 中寫任何日誌。
所有指標以記憶體累加器累積，**只在週期結算時輸出一則**——這是 FR-009 的實作保證。
