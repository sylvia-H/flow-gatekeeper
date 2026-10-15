# Product

<!-- impeccable:product-schema 1 -->

> 本檔是 impeccable 的**產品事實**紀錄（PRODUCT.md），只記不隨視覺改版變動的產品真相；視覺系統另見同目錄 `DESIGN.md`。
> 建立於 2026-10-15（feature 013 UI 全面改版的前置）。標 **[推定]** 的條目是由 README、憲章、指南與既有 design-spec 推得、尚未經使用者逐條確認；其餘為專案文件已明載的事實。

## Platform

web

## Users

- **主要使用者：監控台操作者**——想長時間盯著一組機台（流程節點）的即時狀態、在異常時按一下就拿到 AI 診斷的工程／維運人員。情境是「掛在螢幕上反覆看」，不是一次性瀏覽。
- **第二類使用者：展示者／評估者**——拿到 repo、用 `docker compose --profile demo up` 一鍵跑起來，在 22 秒內看懂「高頻遙測如何被背壓壓住、AI 診斷如何逐字串流、快取如何命中」的人（面試官、技術同儕、作品集讀者）。**[推定]** 這一類的比重不低於第一類：README 的 demo 影片、逐項截圖與「每個賣點都可驗收」的寫法都是為他們而設。

## Product Purpose

flow-gatekeeper 是一個致敬 Argo CD 狀態／拓樸語言的**即時流程監控台 + 串流式 AI 診斷面板**，也是一個刻意把即時／分散式系統裡「較難、較有展示價值」的幾塊親手做出來的工程展示 side project。

成功的樣子：

1. 開啟第一屏就是可操作的監控台（不是 landing page），5 台機台的遙測即時更新而畫面不卡。
2. 任一機台轉 warning／critical 時能一眼看出；按 Diagnose 後 drawer 立即進入 active，AI 回覆逐字出現，完成後是結構化的五區塊結果，再按一次會秒回並標 Cached。
3. 斷線、worker 崩潰、Pub/Sub 中斷時畫面誠實標示（Reconnecting／Disconnected／Stale／failed + Retry），不假裝正常。
4. 展示者在 demo 影片的 22 秒內看懂上述三點。

## Positioning

鄰近產品（一般監控儀表板、chat 式 AI 助手）無法如實複製的機制：

- **背壓是畫面的一部分**：高頻 WebSocket 遙測先進 buffer、以 `requestAnimationFrame` 每幀批次提交，「收到的訊息數 ／ 實際渲染的批次數」這個背壓比值直接畫在 TopBar 上（`BackpressureBadge`），是本專案的核心賣點，不是隱藏在工程細節裡的實作。
- **AI 診斷是跨進程串流**：診斷由獨立 worker 經 BullMQ 消化，token 走 Redis Pub/Sub 由 Gateway 轉發到同一條 WebSocket；cache-aside + dedupe lock 讓同簽章的第二次診斷秒回並可視化為 Cached。
- **生產化三部曲**：崩潰自癒（007）、整棧容器化單一入口（008）、可觀測性基線（009）——系統「自己也能被監控」。

## Operating Context

- **兩種執行模式**：開發模式（`pnpm dev`，web 走 Vite 5173、api 3000）與一鍵 demo（nginx 單一入口 `http://localhost:8080`，`/ws` 與 `/diagnoses` 同源反向代理）。
- **資料來源是 mock producer**：5 台固定示範機台 `mixer-01`／`press-02`／`pack-03`／`oven-04`／`sorter-05`（跨端單一來源 `packages/contracts/src/machines.ts`），遙測以決定性規律產生、含週期性 warning／critical 尖峰，demo 劇本可重播。
- **每台機台的遙測欄位**：state（healthy／warning／critical）、temperature（°C）、vibration（mm/s）、throughput（u/min）、errorRate（%）、lastUpdated。
- **診斷流程狀態機**：idle → waiting → active（有 0／20／40／60／80／100 進度里程碑與處理步驟清單）→ streaming tokens → completed（severity、summary、likely causes、evidence、suggested actions，可帶 Cached 標記）｜failed（可 Retry）。每台機台各自一份狀態，多台可並存；drawer 一次只呈現目前選取的那台。Active 期間同一台不得重複送出。
- **連線狀態**：connected／reconnecting（指數退避 + 抖動）／disconnected；另有「未授權」chip（設了 `WS_AUTH_SECRET` 時）。斷線保留最後資料並標 stale；stale 判定為 10 秒無新資料，Pause 且連線中時凍結 stale 判定。
- **TopBar 控制**：connection chip（含延遲 ms）、search 即時過濾 sidebar 與卡片、Pause／Resume、mock frequency 控制（目前無實際後端作用，屬 UI 占位）、Diagnose 動作。
- **其他面板**：Fleet Health（healthy／warning／critical／stale 計數 + 比例條）、Event Stream（狀態轉換事件列，去重、上限 50）、sidebar 機台分組、dev-only Metrics Panel（`VITE_METRICS_PANEL`，唯讀、預設收合）。
- **響應式**：桌機為 sidebar + 中央 node grid + 右側常駐 Copilot drawer；手機為 drawer 改 bottom-sheet。

## Capabilities and Constraints

- **只動前端**：契約（`packages/contracts`，Zod 單一來源；`asyncapi.yaml` 1.2.0）與後端行為在 UI 改版中一律不變；UI 只消費既有的 12 則 WS 訊息與 `POST /diagnoses`。
- **高頻事件不得逐筆寫 reactive state**：WebSocket telemetry MUST 先進 buffer、再以 `requestAnimationFrame` 每幀批次提交（憲章硬規則）。任何改版都不得破壞這條。
- **即時通道是原生 `WebSocket`**（ADR-001），不是 Socket.IO。
- **技術棧固定**：Vue 3.5、Pinia 3、Tailwind 3（token 落在 `tailwind.config.ts` 的 `theme.extend`）、lucide icons、Vite 7、vitest 4、strict TypeScript。
- **Token 紀律**：顏色、圓角、陰影、間距 MUST 用具名 token，MUST NOT 在元件內散落 hex（憲章）。
- **產品層級的介面約束**（原載於 design-spec §1，改版後仍須保留）：
  - 第一屏必須是可操作的監控台，不做 landing page。
  - 卡片圓角不超過 8px；除 badge／pill 外不用過度圓潤造型。
  - 按鈕優先用 lucide icon 搭配 tooltip；清楚的命令才用文字按鈕。
  - 不使用官方 Argo CD logo、商標或直接複製官方素材。
  - 不使用大面積紫色漸層、裝飾光球、bokeh 背景。
  - mobile／desktop 都不能有文字溢出或 UI 重疊；不得有 layout shift。
- **已知產品限制（不是 UI 能解的）**：重連不 rebind、沒有診斷結果讀取端點、worker 崩潰後約 92 秒靜默、AI token 串流 at-most-once、mock frequency 控制無後端作用。UI 對這些只能誠實呈現（failed + Retry、watchdog 45 秒），不得假裝已解。
- **明確未決**：改版後是否重錄 demo 影片與 12 張 README 截圖——待 013 feature 收尾決定。

## Brand Commitments

- 名稱 **flow-gatekeeper**，全小寫、連字號。
- 語氣：工程紀律優先、「每個賣點都可驗收」、不浮誇；UI 文案以英文為主（Diagnose、Fleet monitor、Connected、Cached、Retry…），文件為繁體中文。
- 「致敬 Argo CD」只借用其狀態／拓樸的**語言**（status light、sync/health 語意、topology 視角），不得使用其品牌資產。
- **[推定]** 既有的「深色、低飽和、工程感」只是舊視覺世界的選擇，**不是**品牌承諾；013 改版可重新選擇視覺世界。

## Evidence on Hand

- 實機 demo 影片與海報：`docs/demo/flow-gatekeeper-demo.mp4`（22 秒，1.0.0 畫面）、`docs/demo/flow-gatekeeper-demo-poster.jpg`。
- 12 張實機截圖（1.0.0 發布前攝）：`docs/screenshots/*.png`（monitoring-live、monitoring-states、fleet-health、event-stream、monitoring-search、monitoring-selected、monitoring-reconnecting-stale、copilot-streaming、copilot-completed、copilot-cached、copilot-failed、responsive-mobile）。
- 舊視覺世界的參考圖與規格：`apps/web/design/refs/*.png` 與 `apps/web/design/design-spec.md` v0.6（**自 013 起為歷史文件**，僅作反面參考與產品約束來源）。
- 真實量化數據：README「技術亮點深入」的背壓與限流數字、第三輪審查報告的實測；**沒有**使用者見證、客戶名單、市場數據——未來工作不得捏造。

## Product Principles

1. **第一屏就是工作台**：開啟即可操作，資訊密度要能支撐長時間監看，不為美觀犧牲可掃讀性。
2. **狀態永遠誠實**：healthy／warning／critical／stale／reconnecting／failed 要一眼可辨，且不只靠顏色；系統做不到的事（斷線、靜默）直接標示，不粉飾。
3. **背壓與串流是可見的賣點**：批次比值、逐字串流、Cached 標記是產品要展示的機制，UI 要把它們放在能被看見、被驗收的位置。
4. **可反覆操作、動效克制**：操作者會反覆按 Diagnose、切機台、暫停；動效只用來說明狀態轉換，不做表演。
5. **契約與後端不動**：任何 UI 決策都在既有 12 則 WS 訊息與一個 REST 端點之內完成。

## Accessibility & Inclusion

原載於 design-spec §10，屬產品要求而非視覺風格，改版後保留：

- icon-only 按鈕必須有 `aria-label` 或 tooltip；狀態不能只靠顏色，需有文字 label 或 aria label。
- progress bar 要有 `aria-valuenow` 或 indeterminate 描述；drawer 可用 Escape 關閉；keyboard focus ring 不可移除。
- critical pulse 不可過快；`prefers-reduced-motion: reduce` 時停掉 pulse、串流游標與 indeterminate 循環動畫。
- 小字（10–12px）文字對其背景對比 MUST ≥ 4.5:1（WCAG AA）。
