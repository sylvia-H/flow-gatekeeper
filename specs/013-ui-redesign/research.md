# Research: UI 全面改版（013）

**Date**: 2026-10-15 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

每條以「Decision / Rationale / Alternatives considered」記錄。所有決策皆在「純前端、契約與後端不動」的前提下。

---

## R1 主題機制：CSS custom properties + `data-theme`，light 預設、localStorage 保存

**Decision**：
- `src/styles/theme.css` 定義 `:root[data-theme="light"]` 與 `:root[data-theme="dark"]` 兩組同名變數（`--c-canvas`、`--c-surface`、`--c-ink`、`--c-accent`、`--c-ok`… 以 `R G B` 三元組存放），這是**全站唯一允許出現 hex／rgb 數值的檔案**。
- `tailwind.config.ts` 的 `theme.extend.colors` 一律寫成 `"rgb(var(--c-surface) / <alpha-value>)"`，元件只用 `bg-surface`、`text-ink` 等語意 class；磨砂玻璃的半透明用 `bg-surface/72` 這類 alpha 修飾。
- `main.ts` 在 `createApp` 之前讀 localStorage `fg.theme`（try/catch），立即設定 `document.documentElement.dataset.theme`，無值則 `light`；**不讀 `prefers-color-scheme`**（spec Assumptions）。
- `useTheme()` composable 提供 `theme`／`toggle()`；切換時先在 `<html>` 加 `data-theme-switching` 一幀以停用所有 transition（避免各元件以不同時序漸變造成閃爍），下一幀移除。
- 兩套主題共用同一組語意名稱；dark 的玻璃為「煙燻」：`--c-surface` 色值較深，對比以 quickstart 的抽測驗證。兩套主題玻璃 alpha 皆為 72%，dark 的煙燻感由 `--c-surface` 色值達成。

**Rationale**：Tailwind 3 無原生多主題；變數法讓 token 名稱唯一、兩套值並存、切換零 re-render（只改一個屬性）；hex 集中一檔符合憲章 II 的「不散落 hex」且便於 `impeccable detect` 的 design-system 檢查。

**Alternatives considered**：Tailwind `dark:` variant（每個元件要寫兩份 class，違反單一 token 原則）；升級 Tailwind 4（`@theme` 原生變數，但升級屬技術棧變更，超出本 feature 範圍）；CSS `color-scheme`／`light-dark()`（Safari 支援較晚，且仍需變數）。

## R2 磨砂玻璃的落地：rgba 底色 + 1px 內側高光，不用 backdrop-filter

**Decision**：面板 = `bg-surface/72 border border-edge shadow-[inset_0_1px_0_rgb(var(--c-highlight)/0.9)]`；底下的桌面格線以 `repeating-linear-gradient` 畫在主區容器（唯一的「漸層」用途是 1px 格線，不是色彩漸層）。嚴格禁止 `backdrop-filter`、`filter: blur`、外發光陰影。

**Rationale**：direction contract 明文拒絕 glassmorphism；`backdrop-filter` 在高頻重繪的卡片網格上是 GPU 合成成本最高的屬性之一，與 SC-005 衝突；1px 高光與半透明已足以在骨架草圖中讀出「玻璃片」。

**Alternatives considered**：`backdrop-filter: blur(8px)`（否決：效能與 costume）；純不透明面板加陰影（否決：失去「格線透出」的材質感）。

## R3 字型：Source Sans 3 + Noto Sans TC（UI）、JetBrains Mono（機器值），Google Fonts + 系統退路

**Decision**：`index.html` 的 Google Fonts link 改為 `Source+Sans+3:wght@400;600;700`、`Noto+Sans+TC:wght@400;500;700`、`JetBrains+Mono:wght@400;500`，`display=swap`。字型堆疊：`"Source Sans 3", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif` 與 `"JetBrains Mono", "Noto Sans TC", ui-monospace, monospace`（等寬堆疊加 CJK 退路，解決中文在 mono 區塊基線不齊）。`font-variant-numeric: tabular-nums` 全站套在 mono。

**Rationale**：Operate 面適合工作用 sans；Source Sans 3 不在 impeccable 的「訓練預設」清單（Inter、IBM Plex、Space Grotesk…）；Noto Sans TC 是繁中最穩的螢幕字；沿用既有「載到用、失敗退系統字」策略，離線 demo 不壞。

**Alternatives considered**：自行託管字型檔（體積與授權管理，對 side project 不划算；code-led 不受 hero gate 的自託管要求）；只用系統字（中英混排品質不穩）。

## R4 背壓速率序列與走勢線：1 Hz 差分環狀緩衝，SVG polyline

**Decision**：
- `rate-series.ts`：`RateSeries`（固定 60 格環狀緩衝）每 1 秒取 `receivedMessages`、`renderedBatches`、`droppedMessages` 的差分，推入 `{ msgsPerSec, batchesPerSec, droppedPerSec }`。tick 掛在 store 既有的 1 秒 `now` 計時器上，**不在 rAF 路徑**。
- 比值口徑改為 **60 秒視窗**（FR-009）：`windowRatio` = 序列內 `Σ msgsPerSec ÷ Σ batchesPerSec`，由 `rate-series.ts` 衍生，是 strip 的主顯示；既有 `backpressure.ts` 的累計比值只放 tooltip。理由：累計值在頻率變動後會長時間落後兩條瞬時速率線，與 US2 AS2「比值與兩線關係一致」矛盾。
- `Sparkline.vue`：單一 `<svg viewBox="0 0 60 24" preserveAspectRatio="none">` 兩條 `<polyline>`，points 由 computed 產生字串；每秒更新一次、60 個點，成本可忽略。y 軸以 60 秒內最大值正規化（避免兩條線因量級差異擠在底部，批次線另以虛線區分）。走勢線不共用比值刻度，旁標「近 60 秒」小字；reduced-motion 時無 transition（瞬間更新）。
- `Graduation.vue`：靜態 SVG **比值刻度**（FR-009a：0–60、線性、1 格 = 1:1、每 10 格大格並標數字），只渲染一次；液位線是一條 `position:absolute` 的 2px 直線，left = `min(windowRatio, 60) / 60`（比值超過刻度上限時釘在右端並顯示 `>60`）。
- 斷線時 series 停止推入並以 `stale` 標示；Pause 期間照常計數（計數不是畫面內容，與既有 onDrop 註解一致）。

**Rationale**：憲章 IV 禁止逐筆 reactive；1 Hz 差分不增加每幀工作；SVG polyline 無相依、可用 token 上色、reduced-motion 下天然靜態。

**Alternatives considered**：canvas 繪圖（多一套繪圖碼且 token 上色不便）；每幀推點（違反 IV 且 60 fps × 60 s = 3600 點無必要）；第三方圖表庫（相依與 bundle）。

## R5 stage 拓樸：CSS grid 三欄 + SVG 連線層，throughput → 粗細與流速等級

**Decision**：
- `StageTopology.vue`：`grid-template-columns: repeat(3, minmax(220px, 1fr))`，每欄 `StageColumn.vue`（中文標題、計數、卡片 `flex-col`；`role="region"` 加區域名稱）；欄間 24px 溝槽放 `FlowLink.vue`。機台分欄由純函式 `assignToStages(visibleIds, groups)`（`stage-layout.ts`）負責：空欄保留，未分組 id 歸入最後一欄並 `console.warn` 一次。
- `FlowLink.vue`：一個絕對定位的 `<svg>` 畫一條水平線加箭頭；`stroke-width` 由 `flow-link.ts` 把**下游 stage 各機台 throughput 的總和**映射到 2–8px（五段）；流動以 `stroke-dasharray` + CSS `@keyframes` 位移，動畫時長由流速等級（慢／中／快三檔）決定，等級由 computed 每幀至多更新一次；`prefers-reduced-motion` 時 `animation: none`，只保留粗細；SVG 加 `aria-hidden="true"`（裝飾性，流向以 stage 標題順序傳達）。
- 手機（< 768px）：grid 退為單欄、三段上下堆疊，FlowLink 改為垂直短箭頭，speed 強制 `none`（FR-016 無流動）。
- 搜尋過濾使某欄為空：欄保留、顯示空狀態文案，連線不變。

**Rationale**：specify 階段裁決 FR-014 選定 C（粗細加流動）；用 CSS 動畫而非 JS 逐幀改屬性，符合 IV；等級化（而非連續值）避免每批次都改動畫時長造成重啟閃動。

**Alternatives considered**：整個拓樸用一張 canvas（卡片是互動元件，不適合）；連續值驅動 `animation-duration`（每次變更會重啟動畫）。

## R6 串流漸進解析：自寫容錯 partial-JSON 純函式

**Decision**：`partial-json.ts` 提供 `parsePartialDiagnosis(text): PartialResult`：
1. 從第一個 `{` 起取子字串；
2. 掃描追蹤字串／跳脫／括號堆疊，於字串尾端補齊未閉合的引號、括號；
3. `JSON.parse` 成功則以 `DiagnosisResultSchema.partial()`-等價的寬鬆讀取（只取已存在且型別正確的欄位：`summary`、`severity`、`likelyCauses[]`、`evidence[]`、`suggestedActions[]`），並標記每個欄位 `complete | streaming | missing`（最後一個被截斷的字串欄位為 `streaming`）；
4. 任一步失敗回 `{ fields: {}, raw: text }`，UI 顯示骨架佔位，不顯示錯誤。
呼叫時機：`CopilotDrawer` 以 computed 對 `streamText` 計算；token 事件頻率（每秒數十）遠低於遙測，且解析成本 O(n) 於幾 KB 文字，不需額外節流。完成態一律以 `ai/done` 的已驗證 `result` 取代 partial；失敗態不顯示骨架，以原始串流呈現中斷前推理（FR-024）。

**附：證據合併（FR-021）**：evidence 契約只有 `source`、`id?`、`excerpt`，沒有時間與結構化的狀態轉換欄位，故 `evidence-merge.ts` 以 `source` + 正規化 `excerpt`（去首尾與連續空白、小寫、去 `[…]` 時間戳樣式）為合併鍵，只顯示 `×N`、不顯示時間；正規化後為空者不合併（data-model §12）。

**Rationale**：契約不動（後端仍逐 token 送文字）；純函式可測（合法／截斷／非 JSON 三類）；避免引入 streaming-JSON 相依。

**Alternatives considered**：`@streamparser/json` 等庫（相依、與 Zod 型別整合成本）；後端改送結構化事件（違反零契約變更）。

## R7 診斷耗時量測：前端 `performance.now()`，每台保存上一次非快取與快取耗時

**Decision**：`diagnosis-timing.ts`：`startTiming(machineId, jobId)` 在 `POST /diagnoses` 送出前記錄；`ai/done` 到達時計算 `elapsedMs`，依 `cached` 寫入 `lastUncachedMs` 或 `lastCachedMs`（store 內 `Map<machineId, DiagnosisTiming>`，session 內記憶）。Cached 呈現：`快取 · 14 ms`（≥ 遙測值字級）與 `上一次 8.2 s` 並列；無非快取紀錄時只顯示本次。

**Rationale**：前端量測即可呈現「秒回」對比，不需後端時間戳；per-machine 保存符合每台各自狀態機。

## R8 異常 latch 與事件合併：純函式狀態機，掛在既有轉換點

**Decision**：
- `anomaly-latch.ts`：`AnomalyLatch = { level: "warning"|"critical", enteredAt, recoveredAt: number | null, clearedBy: "user" | null }`（與 data-model §5 一致）；時間一律用客端收到批次的 `receivedAt`（不用 payload 時戳，避免時鐘偏差）。`applyTransition(latch, prev, next, receivedAt)`：無 latch 或已回復時進入 warning／critical → 以最新異常重建（等級、時間、確認狀態全部重置）；仍在異常中 warning→critical 升級並重置確認狀態（已劃線者恢復未確認）、critical→warning 維持；回到 healthy → 記 `recoveredAt`。`isLatchVisible(latch, staleNow)` = 仍異常 或 `staleNow - recoveredAt < 30_000`（以 `staleNow` 判定：Pause 期間凍結顯示，恢復後依實際經過時間判定，Pause 期間計入、可能立即消失）；相對時間錨點：進行中為 `enteredAt`、回復後為 `recoveredAt`（data-model §6）；`clearLatch()` 設 `clearedBy = "user"`，可見期內以劃線呈現、期滿消失（呼應 direction contract「清除以劃線作廢可追溯」）。store 於 `applyTelemetryBatch` 既有的 `prevState → point.state` 判斷處一併更新（同一處、不新增逐筆 reactive：latch Map 為 `shallowRef`，批次結束 `triggerRef` 一次）。
- `events.ts`：`mergeEvent(list, event, windowMs = 10_000, max = 50)`：在清單中找同 machineId、同 severity 的**最近一筆**（不限頂端），若 `event.ts - 該筆.ts ≤ 10 s`（閉區間）→ 更新該筆的 `count` 與 `ts` 並移到頂端，否則新增於頂端；訊息改為中文（`壓製機 02 進入嚴重`）；新增「回復正常」事件（severity `recovered`）供摘要列與 latch 對照，同樣計入上限 50，且不阻斷 warning／recovered 交錯時的同類合併。
- 異常摘要列 `AnomalySummary.vue`（側欄與手機覆蓋層共用）讀 `store.anomalySummary`（由 latch Map 衍生、依最近異常時間排序），點擊 `selectMachine`，清除鈕呼叫 `clearLatch`。

**Rationale**：clarify Q4 要求兩處清除同一份狀態；掛在既有轉換點不增加路徑；30 s 以既有 1 秒 tick 的 `staleNow` 判定，不需額外計時器。

## R9 鍵盤操作：單一 composable + 依視覺位置移焦的純函式

**Decision**：`useKeyboardShortcuts.ts`（留在 `shared/composables/`）在 App 層掛一個 `keydown` listener，**只收注入的 callbacks**（`focusSearch`、`selectMachine`、`diagnose`、`clearLatch`、`togglePanel`、`clearSelection`、`toggleHelp`），不 import 任何 `domains/` 模組，使既有 `shared/layering.test.ts` 維持綠；App.vue 負責接線，`diagnose` callback 由 `useDiagnoseTrigger` 提供（前置條件與去重同診斷按鈕）。輸入欄（`input`、`textarea`、contenteditable）或 IME 組字中（`event.isComposing`／`keyCode 229`）時忽略字母與符號快捷鍵。對照表（見 data-model §11）：`/` 聚焦搜尋、Enter（搜尋框內、結果恰一台）選取並把焦點移到該台卡片（手機覆蓋式搜尋同時收回）、方向鍵（焦點在卡片上）移焦、Enter 選取、`d` 診斷選取機台、`x` 清除聚焦卡片的異常標記、Escape 每次只關最上層一項（說明層 → 搜尋覆蓋 → 手機異常覆蓋層 → Copilot 面板（手機即 bottom-sheet；只關當次、不寫手動收合偏好）→ 取消選取）、`?` 開關說明層。`focus-grid.ts`：給定卡片的 `DOMRect[]` 與目前索引，依方向取最近鄰（先同列／同欄，再歐氏距離），純函式可測。卡片只保留一個 tab 停駐點（卡片本體），診斷 icon 與 latch 清除鈕改為 `tabindex=-1`、以 `d`／`x` 或滑鼠觸發。resize 把手加 `tabindex=0` 與方向鍵 ±16px（側欄 ArrowRight 加寬／ArrowLeft 減寬、事件流 ArrowUp 增高／ArrowDown 減少；範圍沿用既有：側欄 200–420、事件流 100–360），`useResizeDrag` 的 localStorage 讀寫改經 `useLocalPreference`（try/catch），key 沿用既有 `flow-gatekeeper:*`。

**Rationale**：clarify Q3 選定最小完整集；集中於一個 composable 便於說明層同源產生列表；純函式讓移焦邏輯可在 happy-dom 以假 rect 測試。

## R10 響應式策略：面板預設收合、搜尋收合為圖示、手機機群健康摘要條

**Decision**：
- Copilot 面板所有寬度預設收合（clarify Q2），`fg.copilot-panel` 記錄手動收合並跨重新載入保留；無偏好時選台即展開，有偏好時選台不展開，只有觸發診斷或點展開把手才展開並清除偏好（data-model §2）；手機 bottom-sheet 任何收合（收合鈕或 Escape）只要仍有選取機台即退為 32px peek 條（選取機台名稱與診斷狀態 chip），點擊等同展開把手；取消選取才完全隱藏。
- 工具列以既有 container query 改為三段：≥ 820px 全部；640–819px 隱藏文字只留 icon；< 640px 搜尋收成圖示按鈕，點擊展開為覆蓋式輸入框（Escape 收回），Mock 頻率與 Metrics 隱藏。
- 手機（< 768px）：rail 隱藏，主畫面頂端 `FleetHealth` 以 `compact` 模式呈現為「機群健康摘要條」（比例條＋四計數），點擊展開 `AnomalySummary`（異常摘要列）覆蓋層；主題切換進工具列。
- 五個驗收 viewport（1366×768、1440×900、1024×768、768×1024、390×844）× 兩主題的截圖由 R11 劇本產出並人工逐項檢查 SC-004；layout shift 由劇本量測 `.machine-card` 在 hover／選取／脈動前後的 bounding rect。

## R11 截圖劇本與工具：`playwright-core` + 本機 Playwright Chromium

**Decision**：`apps/web/scripts/screenshots.cjs`（devDependency `playwright-core`；Setup 階段先建 `--viewports` 雛形，US6／US7 完成 `--readme`）：連本機 dev server（或 demo 入口），依劇本操作（載入、選台、診斷、等待完成、再診斷命中快取、搜尋、斷線模擬以關閉 api 觸發）並在五個 viewport × 兩主題截圖，輸出到 `docs/screenshots/`（12 張功能 light）與 `docs/screenshots/{dark,topology}.png`。瀏覽器路徑由 `PLAYWRIGHT_CHROMIUM` 環境變數指定，預設找 `~/AppData/Local/ms-playwright/chromium*`；README 記錄一次性安裝指令。本次 critique 用的截圖腳本即此劇本的雛形。

**Alternatives considered**：完整 `playwright` 套件（會下載瀏覽器，體積大）；把劇本放進 `tests/e2e`（該套件以 ws 客戶端 harness 為主、無瀏覽器）。

## R12 impeccable 在 implement 階段的用法

**Decision**：
- 每個 UI phase 開工前讀 `reference/craft-floor.md`（craft floor 與絕對禁止項），US1 完成後跑一次 `impeccable detect --json src index.html` 與 live URL，之後每個 UI phase 收尾再跑一次。
- Finish phase：`impeccable-finish-reviewer`（對照 direction contract 與 `assigned.html`）→ 修 material fixes → `impeccable-documenter` 重寫 `DESIGN.md` 與 sidecar → 重跑 `/impeccable critique`（SC-002 ≥ 30/40）。
- hook 若啟用，對正式碼的 finding 一律處理或以 `ignore-value` 記錄理由；對 `.impeccable/mocks/` 的草圖不處理（tasks 階段清理草圖，只保留 `assigned.html`）。

## R13 繁中 UI 術語表（供 clarify 後審核；implement 以此為準）

| 英文（1.1.0） | 繁體中文（013） | 備註 |
|---|---|---|
| Diagnose / Run diagnosis | 診斷 | 工具列與面板同一詞 |
| Fleet monitor · N machines | 機群總覽 · N 台 | 主區標題改由背壓 strip 取代，保留於 aria |
| Fleet Health | 機群健康 | |
| Event Stream | 事件流 | 面板稱「事件流」，單一列稱「事件列項」 |
| Connected / Reconnecting / Disconnected | 已連線 / 重新連線中 / 已斷線 | chip 與橫幅 |
| 未授權 | 未授權 | 不變 |
| Pause / Resume | 暫停 / 恢復 | |
| Mock Hz | Mock 頻率 | 維持 disabled |
| Healthy / Warning / Critical / Stale | 正常 / 警告 / 嚴重 / 停滯 | 徽章、圖例、事件 |
| Prep / Forming & Baking / Fulfilment | 前處理 / 成型烘烤 / 包裝分揀 | stage 標題只用中文、不附英文副標（FR-038、SC-013） |
| mixer-01 … sorter-05 | 攪拌機 01 / 壓製機 02 / 包裝機 03 / 烤爐 04 / 分揀機 05 | id 維持原文 |
| Temp / Vibration / Throughput / Errors | 溫度 / 振動 / 產能 / 錯誤率 | 單位 °C、mm/s、u/min、% 原文 |
| AI Copilot / Idle / Active / Completed / Failed | AI 診斷 / 閒置 / 進行中 / 已完成 / 失敗 | 文件中稱「Copilot 面板」（手機形態為 bottom-sheet），UI 標籤為「AI 診斷」 |
| Diagnosis severity ok / warning / critical | 正常 / 警告 / 嚴重 | `DiagnosisResult.severity` 的 `ok` 譯「正常」 |
| Summary / Likely causes / Evidence / Suggested actions | 摘要 / 可能原因 / 證據 / 建議動作 | |
| Cached / Retry / 中止診斷 | 快取 / 重試 / 中止診斷 | |
| updated Ns ago | 更新 N 秒前 | 2 秒內顯示「剛剛」 |
| Theme light/dark | 主題：淺色 / 深色 | |
| Shortcut help | 鍵盤快捷鍵 | |

## R14 真實來源切換的回補順序（US7）

**Decision**：merge 前依序：(1) documenter 重寫 `apps/web/DESIGN.md`；(1a) 更新 `apps/web/PRODUCT.md`：Positioning（背壓 strip 取代 TopBar 徽章）、Operating Context（側欄內容、面板預設收合、拓樸、手機機群健康摘要條）、Accessibility 字級 12px，確認或移除所有 [推定] 標記；(2) `/speckit-constitution` 修訂第 II 條視覺條目指向 `apps/web/PRODUCT.md` 與 `apps/web/DESIGN.md`，並把「開發工作流程與品質門檻」段對 design-spec 的引用改為「依 `apps/web/PRODUCT.md`『第一屏就是工作台』」，版本 1.5.0 → 1.6.0（MINOR：真實來源變更），兩處修訂皆記入 Sync Impact Report；(3) CLAUDE.md「真實來源」段同步；(4) `apps/web/design/design-spec.md` 頂端加退役註記、`git rm -r apps/web/design/refs`（整個目錄，含 `_sources/`）；原始碼註解、測試 describe 名稱與 `tailwind.config.ts` 註解中的 design-spec 引用一律改寫，`specs/` 與 `docs/*-research-review*.md` 屬歷史工件豁免；(5) README：設計連結、截圖、術語；(6) 指南 §15.6 新增 013 段；(7) CHANGELOG `[Unreleased]` 記錄視覺真實來源切換、雙主題、拓樸、文案語言、鍵盤；契約小節註明無變更。
