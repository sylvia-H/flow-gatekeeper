# Phase 0 Research — 前端高頻 WebSocket Gatekeeper 監控台

本 feature 的架構取捨多屬憲章／design-spec／指南 §10 既定，Technical Context 無殘留 `NEEDS CLARIFICATION`。以下記錄「落地既定約束時仍需拍板的工程細節」。格式：Decision / Rationale / Alternatives。

## R1. 高頻遙測不逐筆重繪 — buffer + requestAnimationFrame 批次

- **Decision**：`useHighFrequencyWs` 的 `onmessage` 只把資料 `push` 進普通陣列 buffer（非 reactive）；一支 `requestAnimationFrame` 迴圈每幀 `buffer.splice(0)` 後透過 `onBatch` 一次交給 store 的 `applyTelemetryBatch`。buffer 設上限 `maxBufferSize`（預設 2000），超過丟最舊、保最新。
- **Rationale**：憲章 IV 硬性要求；每幀最多提交一次 → `renderedBatches` 遠少於 `receivedMessages`，這正是 `BackpressureBadge` 要秀的比值。背景分頁時 rAF 暫停，cap 護住記憶體，切回前景一次 flush（指南 §10.3 已定此形狀）。
- **Alternatives**：（a）逐筆寫 reactive → 憲章明令禁止、高頻卡頓；（b）`setInterval` 節流 → 與畫面刷新不對齊、仍可能掉幀，rAF 天然對齊 vsync 較優。

## R2. WebSocket 連線位址 — Vite dev proxy `/ws`（同源）

- **Decision**：`vite.config.ts` 加 `server.proxy['/ws'] = { target: 'http://localhost:3000', ws: true, changeOrigin: true }`；前端一律連 **同源** `` `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws` ``。
- **Rationale**：前端（:5173）與 Gateway（:3000）跨埠；proxy 讓瀏覽器連同源、由 Vite 轉發到 Gateway，免 CORS、免在 bundle 放後端位址祕密，且 production build 若與 API 同源亦可直接運作。
- **Alternatives**：（a）`VITE_WS_URL` 環境變數硬指 `ws://localhost:3000/ws` → 需管理 env 且把後端位址寫進 bundle；（b）直接 `new WebSocket('ws://localhost:3000/ws')` 硬編 → 換環境即壞。proxy 最省心。

## R3. 訂閱授權 — dev 送空 token（Clarify 決議）

- **Decision**：連線收到 `system/connected` 後送 `{ type:'machine/subscribe', token:'', machineIds:[5 台] }`。前端不持有 `WS_AUTH_SECRET`。
- **Rationale**：Gateway 僅在**伺服器端**設有 `WS_AUTH_SECRET` 時才比對 token（見指南 §7.4 骨架 `if (secret && msg.token !== secret)`）；dev 若未設祕密則放行，符合 spec Clarifications「不把祕密打包進 bundle」（憲章 VI）。
- **Alternatives**：build-time `VITE_WS_AUTH_SECRET` → 祕密進 bundle，被 Clarify 否決；runtime 輸入 → 監控台不合理的操作摩擦。

## R4. .vue 型別檢查與 lint 納入

- **Decision**：新增 `vue-tsc`，`typecheck` script 改為 `vue-tsc --noEmit -p tsconfig.json`；`tsconfig.json` 的 `include` 加入 `"src/**/*.vue"`。lint 加 `eslint-plugin-vue` + `vue-eslint-parser`，於 root（或 web 專屬）flat config 對 `**/*.vue` 套用 vue 解析與 recommended。
- **Rationale**：本 feature 首度引入 SFC；現行 `tsc`＋`include: src/**/*.ts` 完全看不到 `.vue`，型別安全（憲章 III）會漏。`vue-tsc` 是官方 SFC 型別檢查器。
- **Alternatives**：只用 `tsc` 忽略模板型別 → 破壞 strict 保證；用 Volar CLI 以外工具 → 生態較弱。

## R5. 測試策略 — 純函式／store 為主，DOM 元件測試從簡

- **Decision**：以 Vitest node environment 測 `applyTelemetryBatch`（批次關係／`batchRatio`）、`nextBackoffDelay`、`isStale`、`machineLabel` fallback。Pinia store 測試用 `setActivePinia(createPinia())`，不需 jsdom。元件視覺留給 quickstart 的人工／截圖驗收（design-spec §11）。`@vue/test-utils`＋`jsdom` 僅在之後確有元件掛載測試需求時才加。
- **Rationale**：憲章測試門檻要「至少純函式單測」；batching 關係、backoff 決定性正是最有價值、最穩定的斷言，且無 I/O。高頻 UI 的視覺／效能本質上靠 DevTools Performance 與截圖驗收，不宜用脆弱的 DOM 斷言硬測。
- **Alternatives**：全面元件快照測試 → 維護成本高、對高頻行為斷言力弱。

## R6. 圖示與字型

- **Decision**：icon 用 `lucide-vue-next`（design-spec §1 指定 lucide）。字型以 Tailwind `fontFamily` token（`Inter` / `JetBrains Mono`）為主，`index.html` **可選**掛 Google Fonts / fontsource 連結；未載到時退回 `ui-sans-serif` / `ui-monospace` 系統字型，不阻斷功能。
- **Rationale**：design-spec 明列 lucide 與兩款字型；數值用 mono 可減少寬度跳動（design-spec §4.2）。字型以漸進增強處理，避免離線／CDN 失敗即壞版。
- **Alternatives**：自畫 svg icon → 重造輪子；把字型檔進 repo → 體積與授權管理成本，side project 不必要。

## R7. 狀態新鮮度（stale）與 lastUpdated 來源

- **Decision**：store 為每台機台記 `lastUpdated`（收到該機台批次時以 `Date.now()` 或 payload `timestamp` 設定）。`isStale(lastUpdated, now, 10_000)` 為純函式；卡片依此降到 opacity 0.55 並顯示 `Stale` badge，不清空數值（design-spec §8.3）。以單一 `now` tick（每秒一次的 interval 或 rAF 附帶）驅動 stale 重算，避免每幀重算整表。
- **Rationale**：spec FR-017／SC-005 要求；門檻抽純函式可單測。用低頻 `now` tick 重算即可，stale 判斷不需高頻。
- **Alternatives**：每幀重算所有卡片 stale → 沒必要的計算；用 CSS 動畫替代 → 無法表達「資料過舊」語意。

## R8. main.ts 由骨架改為實際掛載

- **Decision**：改寫 `apps/web/src/main.ts` 為 `createApp(App).use(createPinia()).mount('#app')`，移除 001 的 `createGatekeeperApp` placeholder render；保留「僅在瀏覽器環境掛載」的 guard 讓 entry smoke 測試可乾淨 import。
- **Rationale**：001 骨架註解明言監控台 UI／WebSocket／rAF 批次「留待後續 feature」——即本 feature。App.vue 成為組裝點。
- **Alternatives**：保留 placeholder 另開 entry → 徒增分歧。
