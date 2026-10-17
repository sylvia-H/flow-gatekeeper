# Data Model: UI 全面改版（013）

全部為**前端衍生狀態**（`apps/web`），以 `@flow-gatekeeper/contracts` 的型別為來源，不新增任何契約欄位。013 新增兩個 localStorage key（`fg.theme`、`fg.copilot-panel`）；既有的兩個尺寸 key（`flow-gatekeeper:sidebar-width`、`flow-gatekeeper:event-strip-height`）沿用、不改名（見 contracts/ui-contract.md §2）。

## 1. ThemePreference

| 欄位 | 型別 | 說明 |
|---|---|---|
| `theme` | `"light" \| "dark"` | 目前主題；預設 `light`，不讀系統偏好 |

- 儲存：localStorage `fg.theme`；讀寫皆 try/catch，失敗回預設且不顯示錯誤。
- 轉移：`toggle()` 切換並寫入；切換期間 `<html data-theme-switching>` 存在一幀。

## 2. PanelPreference

| 欄位 | 型別 | 說明 |
|---|---|---|
| `manuallyCollapsed` | `boolean` | 使用者是否手動收合 Copilot 面板；跨重新載入保留 |
| `open` | `boolean`（衍生） | 實際展開狀態 |

- 儲存：localStorage `fg.copilot-panel`（只存 `manuallyCollapsed`）。
- 轉移：
  - 載入：`open = false`（預設收合，無論偏好為何）。
  - `selectMachine(id)`：`manuallyCollapsed === false` → `open = true`；`manuallyCollapsed === true` → `open` 不變（不自動展開）。
  - 觸發診斷（按鈕、卡片圖示或 `d`）或點展開把手 → `open = true`、`manuallyCollapsed = false`。
  - 手動收合（只限面板上的收合鈕）→ `open = false`、`manuallyCollapsed = true`。
  - Escape 收合 → 只設當次 `open = false`，`manuallyCollapsed` 不變（不算手動收合）。
  - 取消選取 → `open = false`（`manuallyCollapsed` 不變）。
  - 形態：視窗寬 ≥ 1366px（自訂 screen `desk`）為主區右側寬 348px 的推擠式面板；< 1366px 一律為 bottom-sheet。
  - < 1366px：`open === false` 且仍有選取機台時（不論由收合鈕或 Escape 收合），bottom-sheet 退為 32px peek 條（`data-fg="copilot-peek"`，顯示選取機台名稱與診斷狀態 chip）；點擊 peek 條等同點展開把手 → `open = true`、`manuallyCollapsed = false`；無選取機台時完全隱藏。Escape 收合仍不寫 `manuallyCollapsed`。
  - < 1366px 的 engaged 轉移（`sheetEngaged`）：`open === true` 且該台診斷為 idle（未診斷）時 sheet 為閒置單列（約 51px）、**非 modal**（`aria-modal="false"`、無遮罩、焦點留在卡片），`sheetEngaged = false`；診斷進入 active／completed／failed（或未選機台的空狀態）→ `sheetEngaged = true`（`aria-modal="true"`、焦點陷阱、渲染遮罩、sheet 接手焦點）；收合 → `sheetEngaged = false`。主區與 rail 以 `--fg-bottom-reserve` 留白：收合時為 peek 條 32px（無 peek 為 0），閒置單列且未接手焦點時為 sheet 實際高度；其餘展開情形（含 `sheetEngaged === true`）凍結於前值，避免串流讓 sheet 長高時把底下版面一起推動；≥ 1366px 恆為 0。

## 3. RateSeries（背壓速率序列）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `samples` | `RateSample[60]`（環狀） | 每秒一筆 |
| `RateSample.t` | `number` | epoch ms |
| `RateSample.msgsPerSec` | `number` | `receivedMessages` 差分 |
| `RateSample.batchesPerSec` | `number` | `renderedBatches` 差分 |
| `RateSample.droppedPerSec` | `number` | `droppedMessages` 差分 |
| `RateSample.invalid` | `true?` | 暫停期間與恢復後 2 筆樣本為 `true`（樣本照存、丟棄數照計，但排除於合併比相關計算） |
| `invalidPushes` | `number` | 接下來還要標 `invalid` 的推入筆數；`invalidateNext(series, n)` 設定、每推入一筆減一（暫停中每 tick 設 1，恢復時設 2） |
| `stale` | `boolean` | 斷線時為 true，停止推入 |

- 不變量：`samples.length ≤ 60`；推入只在 1 Hz tick，不在 rAF 幀。
- 衍生：
  - `validSamples(samples)`：排除 `invalid` 的有效樣本；下列合併比相關衍生一律只用有效樣本，`droppedInWindow` 例外（計入全部樣本）。
  - `windowRatio`（主顯示，FR-009）= 視窗內有效樣本 `Σ msgsPerSec ÷ Σ batchesPerSec`；批次總和為 0 時為 `null`（顯示「—」）。`averageOf` 的每秒訊息、每秒批次兩個平均取同一組有效樣本，三者相除對得上。
  - 單秒合併比（走勢線，FR-010）= 每筆有效樣本的 `msgsPerSec ÷ batchesPerSec`；批次為 0 或 `invalid` 的秒斷線；y 軸自 0 起、上限取穩健值，離群值釘頂（由 `Sparkline.vue` 衍生）。
  - `peakRatio`（最高水位短線）= 有效樣本單秒合併比的最大值，且不低於 `windowRatio`；無批次時為 `null`（不畫）。
  - `cumulativeRatio`（tooltip）= 既有 `backpressure.ts` 的累計比值。
  - `maxMsgs`（60 秒內最大值；T073 第三輪走勢線改畫合併比後僅供 tooltip／測試，不再作正規化）、`droppedInWindow`（`Σ droppedPerSec`，FR-011）。
- 呈現對應（FR-009a）：液位線位置 = `min(windowRatio, 60) / 60`（比值刻度 0–60，線性），0 到液位為實心液柱，刻度另有 1:1 錨點與 `peakRatio` 最高水位短線；`windowRatio > 60` 時釘右端並標「>60」。走勢線不共用比值刻度。

## 4. Stage 與 FlowLink

| 實體 | 欄位 | 說明 |
|---|---|---|
| `Stage` | `name: MachineGroupName`、`key: "prep"\|"forming"\|"fulfilment"`、`label: string`（中文）、`machineIds: readonly string[]`、`order: 0\|1\|2` | 來源為既有 `MACHINE_GROUPS`（Phase 2 實作：`name` 保留英文作穩定 key，`key` 對應 ui-contract §3 的 `data-stage`，`label` 為中文 stage 名）（`machine-groups.ts`，前端單一來源），不另寫名冊；由純函式 `assignToStages(visibleIds, groups)`（`stage-layout.ts`）產出，空欄保留；不在任何分組的 id 歸入最後一欄並 `console.warn` 一次 |
| `FlowLink` | `from: Stage`、`to: Stage`、`throughputSum: number`、`widthPx: 2–8`、`speed: "slow"\|"mid"\|"fast"\|"none"` | `throughputSum` = 下游 stage 各機台最新 throughput 總和（stale 機台計 0；**以完整分組 `MACHINE_GROUPS[i].machineIds` 計，不用搜尋過濾後的 `Stage.machineIds`**，R5「搜尋清空某欄時連線不變」）；`widthPx` 與 `speed` 由 `flow-link.ts` 分段映射（`widthPx` 可為小數） |

- 更新節奏：由 `machines` 的 computed 衍生，每幀至多一次；`speed` 為等級，避免連續值重啟動畫。
- reduced-motion 或堆疊垂直模式（拓樸容器寬 < 708px，ResizeObserver 量測；量測前退回視窗寬判斷）：`speed` 一律 `"none"`，`widthPx` 照常。

## 5. AnomalyLatch（每台一份）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `machineId` | `string` | |
| `level` | `"warning" \| "critical"` | 目前這次異常的等級 |
| `enteredAt` | `number` | 進入這次異常的時間（客端收到該批遙測的 `receivedAt`） |
| `recoveredAt` | `number \| null` | 回到 healthy 的時間（`receivedAt`）；仍異常時為 null |
| `clearedBy` | `"user" \| null` | 操作者確認後設為 `"user"`（劃線） |

- 時間基準：一律用客端收到批次的時間（`receivedAt`），不用 payload 時戳，避免時鐘偏差吃掉 SC-009 的 ±1 秒。`receivedAt` 是 store 收到 **flush 批次**的時刻：Pause 期間資料留在 buffer、恢復時整段一次沖入，所以 Pause 期間才回復的機台其 `recoveredAt` 為恢復那一刻、恢復後仍顯示 30 秒（Phase 7 審查裁決：維持此語意，不在 ws 入口另記每筆實際到達時間；FR-026「Pause 期間計入、已滿 30 秒者可能立即消失」只對 Pause 之前就回復的機台成立）。
- 轉移（於 `applyTelemetryBatch` 既有的 prev→next 判斷處；純函式 `applyTransition(latch, prev, next, receivedAt, machineId)`——第 5 參數 `machineId` 供無 latch 時建立新物件，Phase 2 實作時補上；有變化回新物件、無變化回原物件）：
  - 無 latch 或 latch 已回復（`recoveredAt !== null`）時進入 warning／critical：以新異常重建——`level` = 新狀態、`enteredAt = receivedAt`、`recoveredAt = null`、`clearedBy = null`（最新異常為準：critical 回復後 30 秒內再進 warning → `level = "warning"`）。
  - 仍在異常中：`warning → critical` 升級 `level` 並重置 `clearedBy = null`（已劃線者恢復未確認）；`critical → warning` 維持 `critical`（`clearedBy` 不變）。
  - `warning/critical → healthy`：`recoveredAt = receivedAt`。
- 可見性（純函式 `isLatchVisible(latch, staleNow)`）：`recoveredAt === null` 或 `staleNow - recoveredAt < 30_000`。以 `staleNow` 判定：Pause 期間凍結顯示；恢復後 `staleNow` 回到實際時間，依實際經過時間判定（Pause 期間計入，已滿 30 秒者可能立即消失），不另記 Pause 偏移。
- 劃線：`isLatchStruck(latch) = clearedBy === "user"`；可見期內劃線呈現，期滿與未劃線者一同消失。
- 確認（原稱清除）：`x` 快捷鍵或異常摘要列（含手機覆蓋層）呼叫 `clearLatch(machineId)`；卡片 pill 不可互動（T073 第三輪） → `clearedBy = "user"`；所有入口讀寫同一 Map。
- 儲存：`shallowRef<Map<string, AnomalyLatch>>`，批次結束 `triggerRef` 一次。

## 6. AnomalySummaryItem（異常摘要列，衍生）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `machineId`、`label` | `string` | |
| `level` | `"warning" \| "critical"` | latch 等級 |
| `active` | `boolean` | 目前仍處於異常 |
| `struck` | `boolean` | 已由操作者確認（劃線） |
| `since` | `number` | 相對時間錨點：仍異常時為 `enteredAt`（顯示「進入 N 秒前」），已回復時為 `recoveredAt`（顯示「曾嚴重 · N 秒前回復」，warning 為「曾警告 · …」）；文案由 `latchText` 產生 |

- 來源：對 `AnomalyLatch` Map 過濾 `isLatchVisible`，依 `active` 優先、再依 `enteredAt` 降冪排序。
- 全部正常時為空陣列，UI 顯示空狀態。

## 7. DiagnosisBadge（卡片診斷狀態 chip，衍生）

| 值 | 來源 |
|---|---|
| `none` | `CopilotJobState.status === "idle"` 或無狀態 |
| `{ kind: "active", progress }` | `active` |
| `{ kind: "completed", severity, cached }` | `completed`（`severity` 取自 `result.severity`） |
| `{ kind: "failed" }` | `failed` |

- 由 `copilot.store` 的每台狀態 Map 以 computed 衍生，不另存。

## 8. DiagnosisTiming（每台一份，session 內）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `pending` | `{ jobId, startedAt }` \| null | `POST` 送出前記錄 `performance.now()`（jobId 由前端先產生） |
| `lastUncachedMs` | `number \| null` | 最近一次 `cached:false` 的耗時 |
| `lastCachedMs` | `number \| null` | 最近一次 `cached:true` 的耗時 |
| `lastKind` | `"cached" \| "uncached" \| null` | 最近一次完成的是哪種（Phase 2 實作補上，供 `compareLabel` 決定主字） |

- 轉移：`startTiming` → `pending`；`ai/done`（jobId 相符）→ 計算 `elapsed`，依 `cached` 寫入對應欄位、清 `pending`；`ai/error`／cancel → 清 `pending`。
- 存放：`copilot.store` 的 `timings: Map<machineId, DiagnosisTiming>`（不改 `copilot-reducer` 狀態機）。

## 9. PartialResult（串流漸進解析，衍生自 `streamText`）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `fields.summary` | `{ value: string, state }` | |
| `fields.severity` | `{ value: DiagnosisSeverity \| null, state }` | `missing`、或串流中尚拼不出合法等級時為 `null`（型別名 `DiagnosisSeverity` 以區別 `events.ts` 的 `Severity`） |
| `fields.likelyCauses` | `{ value: string[], state }` | |
| `fields.evidence` | `{ value: EvidenceItem[], state }` | |
| `fields.suggestedActions` | `{ value: SuggestedAction[], state }` | |
| `state` | `"missing" \| "streaming" \| "complete"` | 每欄位各自；最後一個被截斷的字串欄位為 `streaming` |
| `raw` | `string` | 原文（供「原始串流」展開） |

- 純函式 `parsePartialDiagnosis(text)`；五個欄位永遠存在，非 JSON 或無法補齊時所有欄位 `missing`（value 為空值）。陣列尾端的半截元素：`likelyCauses` 保留半截字串（逐字長出），`evidence`／`suggestedActions` 丟掉半截物件（避免顯示半截 excerpt 或指令）。
- PartialResult 僅用於 `active`：完成態一律改用 `ai/done` 經 `DiagnosisResultSchema` 驗證的 `result`；失敗態以 `raw`（原始串流）呈現中斷前推理，不顯示骨架。

## 10. EventGroup（事件列項合併，衍生自既有 `DerivedEvent`）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `DerivedEvent` 既有欄位 | | `id`、`ts`、`machineId`、`severity`、`message` |
| `severity` | 擴充為 `"warning" \| "critical" \| "recovered"` | 新增回復事件 |
| `count` | `number` | 合併次數（≥ 1） |

- 合併規則（`mergeEvent(list, event, windowMs = EVENT_MERGE_WINDOW_MS /* 60_000 */, max = 50)`，T073 裁決 2026-10-17 由 10 秒滑動窗改為自首筆起算的固定 60 秒窗）：事件帶純前端欄位 `firstTs`（由 `deriveTransitionEvent` 帶出，契約不動）；在清單中找**同機台、同嚴重度的最近一筆**（不限頂端）；若合併後起訖跨度 `max(該筆.ts, event.ts) - min(該筆.firstTs, event.ts) ≤ 60_000`（閉區間）→ 該筆 `count + 1`、`ts = max(該筆.ts, event.ts)`（亂序時訖點不倒退）、`firstTs = min(該筆.firstTs, event.ts)`（亂序時起點往前擴），並移到頂端；否則（滿窗）新事件放頂端另起一列。事件列顯示起訖「`HH:mm:ss–HH:mm:ss · ×N`」，單筆或起訖同秒只顯示一個時間，`< 640px` 時起點與分隔符改 `sr-only`、`title` 恆為全文。
- 不變量：清單上限 50（超過裁掉最舊）；`recovered` 事件同樣計入上限，且不阻斷前後同類異常事件的合併（例如 warning、recovered、warning 交錯時，兩筆 warning 仍合併）。
- 訊息文案繁中：`壓製機 02 進入嚴重`、`烤爐 04 回復正常`。
- 時鐘來源：事件 `ts` 沿用既有做法用 payload 時戳（解析失敗才退回批次 `receivedAt`），合併視窗以此計；異常標記（§5）則一律用客端 `receivedAt`。兩者的相對時間可能有些微差異，屬預期。

## 11. ShortcutMap（靜態）

| key | 動作 | 條件 |
|---|---|---|
| `/` | 聚焦搜尋 | 焦點不在輸入欄 |
| `Enter`（搜尋框內） | 選取唯一結果，並把焦點移到該台卡片（手機覆蓋式搜尋同時收回） | 結果恰 1 台且非 IME 組字 |
| `ArrowUp/Down/Left/Right`（卡片） | 依視覺位置移焦 | 焦點在卡片 |
| `Enter`（卡片） | 選取 | |
| `d` | 診斷**選取**機台（不作用於僅聚焦的卡片；卡片診斷圖示的鍵盤替代為 Enter 選取後按 `d`） | 同診斷按鈕前置條件（由 `useDiagnoseTrigger` 提供） |
| `x` | 確認聚焦卡片的異常標記（劃線保留至回復後 30 秒） | 焦點在卡片且標記可見 |
| `Escape` | 每次只關閉最上層一項：說明層 → 搜尋覆蓋 → 手機異常覆蓋層 → Copilot 面板（< 1366px 即 bottom-sheet；只設當次 `open = false`，不寫手動收合偏好）→ 取消選取 | 依序 |
| `?` | 開關說明層 | 焦點不在輸入欄 |
| `ArrowRight`／`ArrowLeft`（側欄把手） | 側欄寬度 +16px／−16px（200–420px） | 焦點在側欄把手 |
| `ArrowUp`／`ArrowDown`（事件流把手） | 事件流高度 +16px／−16px（100–360px） | 焦點在事件流把手 |

- 字母與符號快捷鍵（`/`、`d`、`x`、`?`）在焦點位於輸入欄或 IME 組字中時不觸發。

## 12. EvidenceGroup（證據合併列，衍生自 `DiagnosisResult.evidence`）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `source` | `"telemetry" \| "errorlog" \| "maintenance"` | 契約既有欄位 |
| `excerpt` | `string` | 第一筆的原文（顯示用） |
| `key` | `string` | `source` + `"|"` + 正規化後的 `excerpt`；正規化後為空者用 `source|#EMPTY-<序號>` 保唯一（大寫標記不可能與小寫的正規化 key 相撞） |
| `count` | `number` | 合併筆數（≥ 1），顯示為 `×N` |

- 正規化：去除首尾與連續空白、轉小寫、去除 `[…]` 形式的時間戳樣式。正規化後為空字串者不合併（各自成列）。
- 不帶時間：evidence 契約沒有時間欄位，不顯示「最近時間」。
- 呈現：依首次出現順序；預設展開前 2 列，其餘以「還有 N 筆」展開（`splitPreview(groups, 2)`）。
