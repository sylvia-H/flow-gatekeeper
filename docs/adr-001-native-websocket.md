# ADR-001：即時通道採用原生 WebSocket，而非 Socket.IO

| 項目 | 內容 |
| --- | --- |
| 狀態 | Accepted |
| 日期 | 2026-06-29 |
| 範圍 | 前端 telemetry/streaming 通道、後端 NestJS Gateway |
| 相關 | `useHighFrequencyWs`、`MonitoringGateway`、`AiStreamRelayService`、Redis Pub/Sub relay |

---

## 1. 背景（Context）

flow-gatekeeper 是一個即時流程監控與 AI 診斷面板，有三個與本決策直接相關的特性：

1. **高頻 telemetry**：mock producer 以 10–50ms 級產生機台資料，前端必須在不拖垮 UI 的前提下持續吃進這些訊息。
2. **跨進程 streaming**：AI 診斷在獨立的 worker process 跑，worker 沒有前端的連線，token 必須經 Redis Pub/Sub 回到 Gateway 再轉發。
3. **作品定位**：這是用來展示「中高階 WebSocket 效能優化」的 side project，核心賣點是 `useHighFrequencyWs` 的 **rAF 批次提交 + UI 背壓**，而不是「把即時通訊接起來」這件事本身。

因此「即時通道用什麼技術」不是純工程便利問題，而會直接影響這個專案想證明的能力。

---

## 2. 決策（Decision）

**前後端統一採用原生 WebSocket**：

- 前端：瀏覽器原生 `new WebSocket()`，自訂 reconnect、heartbeat、訂閱、背壓。
- 後端：`ws` 套件掛在 NestJS 的 HTTP server（path `/ws`），自管 client 識別、訂閱表、jobId 對應。
- 跨進程廣播：自行用 **Redis Pub/Sub**（`ai-stream:<jobId>`）做 worker → Gateway 的 relay。

**明確不採用 Socket.IO**（含 `socket.io-client`）。

---

## 3. Socket.IO 幫你藏了什麼（誠實盤點）

選擇前先承認 Socket.IO 在實務上是更常見、更省事的預設，它替你做掉了不少事：

- **自動重連 + 退避**、連線狀態管理。
- **Heartbeat**：Engine.IO 層的 ping/pong 與逾時偵測。
- **封包/多工**：Engine.IO 封包格式、namespace、二進位支援。
- **Rooms 與 ack callback**：廣播分組、請求/回應確認。
- **Transport fallback**：WebSocket 不可用時降級到 HTTP 長輪詢。
- **水平擴展**：搭配 `@socket.io/redis-adapter` 可跨多個 server 實例廣播。

這些都是真本事。**選原生 ws 等於要自己承擔上面這些**——這正是取捨的核心。

---

## 4. 為什麼這個專案刻意自己掌控

1. **高頻場景需要 wire format 的完全控制。**
   telemetry 直接以「裸 JSON 陣列」推送，前端 hook 直接展開進 buffer，不經 Engine.IO 的封包型別與編碼層。對 10–50ms 級的訊息，少一層抽象就少一份每筆開銷。

2. **避免函式庫的內部批次與我的 rAF 策略打架。**
   背壓策略的主體是前端「每幀 flush 一次 buffer」。若交給 Socket.IO，它自己的緩衝/合併行為會和 rAF 批次重疊，反而讓「背壓由誰負責」變得模糊，也讓效能量測難以歸因。

3. **跨進程廣播這題，專案已經用 Redis Pub/Sub 親手解了。**
   worker 與 Gateway 是不同 process，token 走 Redis Pub/Sub relay。這原本就是 Socket.IO Redis adapter 想解決的問題；既然這塊已自管，再引入 Socket.IO 的多實例機制只會疊床架屋，也會吃掉一個可展示的技能。

4. **與專案整體論述一致。**
   rAF batching、Redis 削峰、BullMQ limiter、cache-aside、dedupe lock——整個專案的主軸是「親手做了即時/分散式系統裡較難的部分」。即時通道交給 Socket.IO 會在這條敘事線中間破一個洞。

---

## 5. 我們接受的代價（Trade-offs）

| 放棄的東西 | 如何承擔 |
| --- | --- |
| 自動 reconnect / 退避 | 在 `useHighFrequencyWs` 手刻指數退避 + 抖動 |
| Heartbeat | 應用層 `ping`/`pong` + 逾時主動 `close` 觸發重連 |
| Rooms / 廣播分組 | Gateway 自管 `clientId -> Set<machineId>` 訂閱表 |
| jobId → client 對應 | relay 自管 `Map<jobId, clientId>`，終態清理 |
| Transport fallback | 不支援；目標環境（現代瀏覽器 + 直連）不需要 |
| 多實例水平擴展 | 目前單實例；要擴展時用既有的 Redis Pub/Sub 自己廣播 |
| ack callback | 不需要；telemetry 是單向高頻推送，診斷結果走 job 狀態 |

**風險自覺**：原生 ws 的價值是有條件的——只有在這些手刻部分**做得正確**（涵蓋重連、心跳逾時、清理、背壓上限）時才成立。做得草率反而會傳達「重造輪子又造壞」的反訊號。因此這些細節在 `useHighFrequencyWs` 與 Gateway 都有明確處理，並列入 feature 驗收。

---

## 6. 什麼情況下這個決策會被推翻

如果專案性質改變，應改用 Socket.IO（或 `ws` + 自建協定的成熟方案）：

- 從作品集 side project 變成**需要長期團隊維護的正式產品**——此時便利性與生態系價值會壓過「親手做」的展示價值。
- 需要**跨多個 server 實例**水平擴展，且不想自管廣播 → Socket.IO + Redis adapter。
- 客戶端網路環境不可控、需要 **transport fallback**。
- 需要 **namespace 多工 / ack 確認** 等較重的通訊語意。

換句話說：**這不是「Socket.IO 不好」，而是「此專案此目標下，自己掌控的展示價值 > 便利價值」。**

---

## 7. demo 時可直接講的取捨說明（60–90 秒）

> 即時通道我刻意用原生 WebSocket，而不是大家預設的 Socket.IO。
>
> 我很清楚 Socket.IO 幫你做了什麼：自動重連、心跳、rooms、transport fallback、還有配 Redis adapter 的多實例廣播。一般產品我會直接用它。
>
> 但這個專案的重點是高頻 telemetry 的前端背壓——我不是每筆 WebSocket 都寫 reactive state，而是先進 buffer，再用 requestAnimationFrame 每幀批次提交。這件事如果交給 Socket.IO，它內部的緩衝行為會跟我的 rAF 批次重疊，背壓由誰負責就說不清楚，效能也難歸因。所以我選擇自己掌控 wire format，直接推裸陣列，少一層封包開銷。
>
> 另外 worker 是獨立 process、沒有前端連線，AI token 我本來就用 Redis Pub/Sub 從 worker relay 回 Gateway——這正是 Socket.IO Redis adapter 在解的問題，既然我已經自管了，再引入 Socket.IO 反而疊床架屋。
>
> 代價是 reconnect、heartbeat、訂閱表、jobId 對應都得自己寫，也沒有 transport fallback。對這個目標環境我覺得划算；但如果哪天要做成多實例、要團隊維護的正式產品，我會改回 Socket.IO + Redis adapter。

---

## 8. 可量化的佐證（建議在 demo 呈現）

前端 store 維護 `receivedMessages` 與 `renderedBatches` 兩個計數：把 mock frequency 拉到 10ms，demo 時秀出「收進 N 筆訊息、只觸發 M 次渲染批次」（例如 41:1）。把「背壓」從抽象說法變成一個畫面上看得見的比值，是這個決策最直接的證據。
