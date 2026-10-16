# Tasks: UI 全面改版（UI Redesign）

**Input**: Design documents from `/specs/013-ui-redesign/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)（含 Clarifications 兩輪共八項與 checklist 自審回補）、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/ui-contract.md](./contracts/ui-contract.md)、[quickstart.md](./quickstart.md)、direction contract `apps/web/.impeccable/surfaces/src-app-vue.md`、選定草圖 `apps/web/.impeccable/mocks/decision/assigned.html`

**Tests**: 包含測試任務。依 spec FR-042 與憲章「測試門檻」，新增的純函式邏輯 MUST 各有單元測試：`useLocalPreference`、`format`（時間與耗時）、`rate-series`（含 60 秒視窗比值）、`anomaly-latch`、`flow-link`、`events` 合併、`partial-json`（合法／截斷／非 JSON）、`evidence-merge`、`diagnosis-timing`、`focus-grid`、`shortcuts`、`stage-layout`。既有 28 個測試檔（含 `shared/layering.test.ts`）MUST 維持綠；被取代的 `TopologyCanvas.vue`、`BackpressureBadge.vue` 沒有既有測試檔，替代元件的測試為新增。

**Organization**: 依 User Story 分 phase，每個 phase 可獨立實作與驗收；phase 順序依優先級再依相依（US8 鍵盤排在 US6 響應式之前，因為響應式收尾要連鍵盤一起驗）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成相依）
- **[Story]**: 對應 spec 的 User Story（US1–US8）
- 每項任務都標明確切檔案路徑；路徑以 repo 根為準

## Path Conventions

pnpm monorepo：本 feature 只動 `apps/web/`（`src/shared/`、`src/domains/monitoring/`、`src/domains/ai-copilot/`、`src/styles/`、`scripts/`、`design/`、`.impeccable/`、`PRODUCT.md`、`DESIGN.md`）與文件（`README.md`、`CHANGELOG.md`、`CLAUDE.md`、`docs/`、`.specify/memory/constitution.md`）。

---

## ⚠️ 全程硬約束（每個 phase 都適用）

1. **零契約變更**（FR-039）：MUST NOT 動 `packages/contracts`、`asyncapi.yaml`、`apps/api`、`apps/worker`。
2. **高頻路徑不逐筆寫 reactive**（FR-040，憲章 IV）：新狀態一律在既有 `applyTelemetryBatch` 批次點、1 Hz tick 或 computed 衍生；MUST NOT 在 ws message handler 內寫 reactive。
3. **hex 只存在 `apps/web/src/styles/theme.css`**（FR-007）；元件只用語意 class；`impeccable detect` 的 design-system 規則與 lint 把關。
4. **磨砂玻璃禁用 `backdrop-filter`、光暈、色彩漸層**（direction contract OWN-WORLD）；唯一允許的 `linear-gradient` 是 1px 桌面格線。
5. **每個 UI phase 開工前讀 `C:/Users/asset/.claude/plugins/cache/impeccable/impeccable/4.5.2/skills/impeccable/reference/craft-floor.md`**；phase 收尾跑 `impeccable detect --json apps/web/src apps/web/index.html`（cwd `apps/web`），正式碼的 finding 一律修或以 `impeccable hooks ignore-value` 記理由。
6. **direction contract MUST NOT 複製進任何瀏覽器交付物**（元件註解、`data-*`、隱藏 DOM 皆不可）；T076 以 grep `dist/` 驗證。
7. **UI 文案一律繁體中文**（FR-038），術語以 research R13 為準；機台中文名的唯一來源是 `machine-labels.ts`，stage 中文名在 `machine-groups.ts`（不附英文副標）。
8. **分層**：`shared/composables` 與 `shared/lib` MUST NOT import `domains/`（既有 `shared/layering.test.ts`）；需要 store 的行為以 callback 注入。
9. **phase 收尾 commit**：依 CLAUDE.md 的 `[Phase <n>: <名稱>]` 格式，先勾選 tasks 再 commit。
10. **視覺真實來源的過渡期**：T068 落地前，憲章與 CLAUDE.md 仍寫「視覺依 design-spec／refs」；本 feature 期間視覺一律依 direction contract（含 AMENDMENTS）與 spec，design-spec 已裁決退役（T068／T069 回補）。

---

## Phase 1: Setup（字型、主題基礎、工具）

**Purpose**: 主題變數與 Tailwind token 重構、字型、截圖工具——所有 UI phase 的前置。

- [X] T001 在 `apps/web/package.json` 新增 devDependency `playwright-core`（版本與本機 Playwright Chromium 相容；research R11），執行 `pnpm install` 更新 lockfile
- [X] T002 建立 `apps/web/scripts/screenshots.cjs` 雛形：以 `playwright-core` 連 dev server（預設 `http://localhost:5173`），支援 `--viewports`（五個 viewport 1366×768、1440×900、1024×768、768×1024、390×844 × 兩主題 × Copilot 面板展開，共 10 張），瀏覽器路徑由 `PLAYWRIGHT_CHROMIUM` 指定，未設定時找 `~/AppData/Local/ms-playwright/chromium*`；找不到瀏覽器時印出安裝指引並以非 0 結束
- [X] T003 [P] 改寫 `apps/web/index.html`：Google Fonts 改為 Source Sans 3（400/600/700）＋ Noto Sans TC（400/500/700）＋ JetBrains Mono（400/500）、`display=swap`；`<html lang="zh-Hant" data-theme="light">`；`<title>` 維持；移除指向 design-spec 的註解
- [X] T004 [P] 新建 `apps/web/src/styles/theme.css`：`:root[data-theme="light"]` 與 `:root[data-theme="dark"]` 兩組同名變數（contracts/ui-contract.md §1 全部 token，值以 `R G B` 三元組），依 direction contract 的 light 色值定義、dark 為煙燻玻璃衍生；加 `:root[data-theme-switching] *, *::before, *::after { transition: none !important }`
- [X] T005 重寫 `apps/web/tailwind.config.ts`：`colors` 全部改為 `rgb(var(--c-…) / <alpha-value>)` 並改名為 contract §1 的語意名（移除舊 canvas／surface.hover／elevated／subtle／strong／fg-*／accent.* 等）；`borderRadius` 改 `control: 4px, card: 6px, pill: 999px`；`boxShadow` 只留 `glass`（inset 高光）與 `sheet`；`fontSize` 移除 `2xs`、新增 `ratio: ['32px','36px']`；`fontFamily` 依 research R3 堆疊；keyframes 保留 `criticalPulse`／`streamCaret`／`indeterminate`，新增 `flow`（stroke-dashoffset）；檔頭「唯一真實來源是 design-spec」註解改指向 `apps/web/DESIGN.md`
- [X] T006 改寫 `apps/web/src/styles/tailwind.css`：`@import "./theme.css"` 置頂；卷軸色改語意 token；`.machine-card[data-selected]` 規則改用 `--c-accent`；reduced-motion 區塊補停 `animate-flow`、`[data-theme-switching]` 過渡、latch 出現動畫與走勢線 transition；移除對舊 token 的引用
- [X] T007 [P] 新建 `apps/web/src/shared/composables/useLocalPreference.ts`：`readPreference<T>(key, fallback, parse)` 與 `writePreference(key, value)`，全部 try/catch、失敗回 fallback 且不拋錯；附單元測試 `useLocalPreference.test.ts`（可用／拋錯／壞 JSON 三例）
- [X] T008 新建 `apps/web/src/shared/composables/useTheme.ts`：`theme` ref、`toggle()`、`apply(theme)`（設 `document.documentElement.dataset.theme`、加 `data-theme-switching` 一幀後移除、經 `useLocalPreference` 寫 `fg.theme`）；`apps/web/src/main.ts` 在 `createApp` 前呼叫 `applySavedTheme()`（讀 `fg.theme`，預設 light、不讀 `prefers-color-scheme`）
- [X] T009 更新 `apps/web/src/shared/lib/state-style.ts`：label 改中文（正常／警告／嚴重）、token 改為 `bg-ok`／`text-ok-fg`／`bg-ok-bg` 語意名、`STALE_DOT` 改 `bg-stale`；同步 `apps/web/src/domains/monitoring/lib/card-style.ts` 的 class 名；以 grep 舊 token 名單（`canvas|fg-muted|fg-subtle|accent-bg|surface-hover|elevated|subtle|strong|text-2xs|text-pill|border-crit-border` 等，以 T005 移除的 token 為準）掃 `apps/web/src`，逐檔改為新語意 class（含 `text-2xs` → `text-xs` 的清理），要求 0 命中（Tailwind class 是字串，typecheck 抓不到；暫不改版面，只換 token）
- [X] T010 新建 `apps/web/src/shared/lib/format.ts`：`formatClock(ts)`（本地 24h `HH:mm:ss`）、`formatRelative(ts, now)`（≤ 2 s 閉區間「剛剛」、`N 秒前`、`N 分鐘前`）、`formatDuration(ms)`（先四捨五入到整數 ms；< 1000 → `N ms`，否則四捨五入到一位小數 `N.N s`，999.6 → `1.0 s`）；附 `format.test.ts`（含 2000／2001 ms 與 999.4／999.6 ms 邊界）；`telemetry-format.ts` 的 `relativeTimeLabel` 改委派至此並保留既有測試綠

**Checkpoint**: `pnpm --filter web typecheck && test` 綠；app 以新 token 渲染（外觀仍舊版版面但已換色系）；`useTheme().toggle()` 可程式切換（切換控制項於 T023 才有）；`node apps/web/scripts/screenshots.cjs --viewports` 可產出 10 張截圖。

---

## Phase 2: Foundational（純函式與測試）

**Purpose**: 各 User Story 共用的純函式邏輯，先寫測試再實作；不動元件。

- [X] T011 [P] 新建 `apps/web/src/domains/monitoring/lib/rate-series.ts`：`createRateSeries(capacity=60)`、`pushSample(series, counters, t)`（差分、環狀）、`maxOf(series, key)`、`droppedInWindow(series)`、`windowRatio(series)`（視窗內訊息總數 ÷ 批次總數，批次為 0 回 `null`）、`markStale(series)`；附 `rate-series.test.ts`（差分正確、滿 60 格環狀覆寫、stale 不推入、視窗比值與批次為 0）
- [X] T012 [P] 新建 `apps/web/src/domains/monitoring/lib/anomaly-latch.ts`：`applyTransition(latch, prev, next, receivedAt, machineId)`、`isLatchVisible(latch, staleNow, holdMs=30_000)`、`isLatchStruck(latch)`、`clearLatch(latch)`、`summarize(latches, staleNow, labels)`（排序規則見 data-model §6）；附 `anomaly-latch.test.ts`（進入／仍異常中升級／已劃線的 warning 升為 critical 時重置為未確認／critical→warning 維持／回復後 30 s 可見與期滿消失／回復後 30 s 內再進 warning 重置為 warning 且清除劃線／使用者清除後劃線且期滿才消失／`staleNow` 凍結時不倒數／恢復後 `staleNow` 回到實際時間時依實際經過時間判定（Pause 期間計入、已滿 30 s 即消失）；`summarize` 的相對時間錨點：進行中為 `enteredAt`、回復後為 `recoveredAt`）
- [X] T013 [P] 新建 `apps/web/src/domains/monitoring/lib/flow-link.ts`：`throughputSum(stageMachines, machines, now)`（stale 計 0）、`widthFor(sum)`（五段 2–8px）、`speedFor(sum, reducedMotion, vertical)`（none／slow／mid／fast；reducedMotion 或 vertical 時恆為 none）；附 `flow-link.test.ts`
- [X] T014 [P] 改寫 `apps/web/src/domains/monitoring/lib/events.ts`：`Severity` 加 `"recovered"`、`DerivedEvent` 加 `count`、`deriveTransitionEvent` 產生回復事件與中文訊息（`壓製機 02 進入嚴重`／`烤爐 04 回復正常`）、新增 `mergeEvent(list, event, windowMs=10_000, max=50)`（找同機台同嚴重度的最近一筆，相距 ≤ 10 s 閉區間則 `count+1`、更新 `ts` 並移到頂端，否則新增於頂端）；更新 `events.test.ts`（合併視窗含 10 000 ms 邊界、次數、移到頂端、warning／recovered 交錯時兩筆 warning 仍合併、回復事件、上限 50）
- [X] T015 [P] 新建 `apps/web/src/domains/ai-copilot/lib/partial-json.ts`：`parsePartialDiagnosis(text): PartialResult`（research R6：取第一個 `{`、補齊未閉合字串／括號、寬鬆讀取五欄位、每欄位 missing／streaming／complete）；附 `partial-json.test.ts`（完整 JSON、截斷於字串中、截斷於陣列中、非 JSON、前綴雜訊）
- [X] T016 [P] 新建 `apps/web/src/domains/ai-copilot/lib/evidence-merge.ts`：`normalizeExcerpt(s)`（去首尾與連續空白、轉小寫、去 `[…]` 時間戳樣式）、`mergeEvidence(items)`（`source` 相同且正規化 `excerpt` 相同者合併為一筆並帶 `count`，正規化後為空者不合併，依首次出現順序；不帶時間）、`splitPreview(groups, n=2)`；附 `evidence-merge.test.ts`（大小寫與空白差異合併、時間戳樣式差異合併、不同 source 不合併、空 excerpt 不合併、前 2 筆預覽與剩餘數）
- [X] T017 [P] 新建 `apps/web/src/domains/ai-copilot/lib/diagnosis-timing.ts`：`startTiming`、`settleTiming(timing, jobId, cached, now)`、`cancelTiming`、`compareLabel(timing)`；附 `diagnosis-timing.test.ts`
- [X] T018 [P] 新建 `apps/web/src/shared/lib/focus-grid.ts`：`nextIndex(rects, current, direction)`（同列／同欄優先、再歐氏距離、邊界停留）；附 `focus-grid.test.ts`（3×2 假 rect 四方向與邊界）
- [X] T019 [P] 新建 `apps/web/src/shared/lib/shortcuts.ts`：`SHORTCUTS` 常數（data-model §11 全部項目，含 `x` 與 Escape 五層順序；每項含顯示用 `keys` 與比對用 `eventKeys`）、`ESCAPE_LAYERS` 五層有序常數、`SHORTCUT_HELP_TITLE`／`SHORTCUT_FOOTNOTE`、`isTypingTarget(event)`（input／textarea／contenteditable／`isComposing`／keyCode 229）與 `isImeComposing(event)`；附 `shortcuts.test.ts`
- [X] T020 [P] 新建 `apps/web/src/domains/monitoring/lib/stage-layout.ts`：`assignToStages(visibleIds, groups)` → 依 `MACHINE_GROUPS` 順序回三欄（空欄保留為空陣列、欄內順序依分組定義），不在任何分組的 id 歸入最後一欄並 `console.warn` 一次；附 `stage-layout.test.ts`（5 台正確歸屬、搜尋後某欄為空仍回三欄、未分組 id 歸最後一欄且只警告一次）
- [X] T021 更新 `apps/web/src/domains/monitoring/lib/machine-labels.ts`：中文名稱（攪拌機 01、壓製機 02、包裝機 03、烤爐 04、分揀機 05）作為唯一來源，stage 中文名（前處理／成型烘烤／包裝分揀）加進 `machine-groups.ts` 的群組定義（保留英文 `name` 作穩定 key，新增 `key`／`label`）；更新對應測試。Phase 2 已知接線：`EventStrip.vue` 的 `SEVERITY` 表只補 `recovered` 一行（中性 token）以通過 typecheck，視覺於 T028／T052 重做；App.vue 側欄仍顯示英文群組名，T026 移除側欄時一併消失

**Checkpoint**: Phase 1–2 共 11 個新純函式測試檔（加上更新的 `events.test.ts`）與既有測試全綠；尚未改任何元件。

---

## Phase 3: User Story 1 - 新視覺世界與深淺雙主題 (Priority: P1) 🎯 MVP

**Goal**: 把整個 shell 換成「實驗室玻璃與蝕刻刻度」的 light 世界並提供 dark 切換；狀態三重編碼；小字對比達標。

**Independent Test**: quickstart 場景 1、2、11；五 viewport × 兩主題截圖（場景 3）對比與可辨性。

- [X] T022 [US1] 讀 craft-floor.md；依 `assigned.html` 與 direction contract 重做 `apps/web/src/shared/components/AppLayout.vue`：桌面格線的主區容器（`bg-bench` + 1px 格線）、rail 與工具列 `bg-rim`、面板統一 `glass` 樣式 class（`bg-surface/72 border-edge shadow-glass rounded-card`）；Copilot 面板預設收合（`panelOpen` 預設 false，偏好語意於 US6 T059 接線）；手機 bottom-sheet 加抓取把手，並預留收合（收合鈕或 Escape）且仍有選取機台時的 32px peek 條（`data-fg="copilot-peek"`，無選取時不渲染；行為於 T062 完成）。Phase 3 實作裁決：推擠式桌機面板只在 ≥ 1024px（`lg:`）啟用，768–1023px 與手機同用 bottom-sheet（`useModalSheet` 門檻同步改為 1024；768×1024 截圖實測 rail 240＋面板 360 會把卡片欄擠到 110px）；CopilotDrawer 收合鈕 emit `close`、Escape／遮罩 emit `dismiss`；遮罩用新 token `bg-scrim/50`（dark 下 `ink` 是淺色）
- [X] T023 [P] [US1] 新建 `apps/web/src/shared/components/ThemeToggle.vue`（`data-fg="theme-toggle"`，兩段式控制、`aria-pressed`、中文「主題：淺色／深色」），掛在 rail 底部；手機時由 TopBar 系統狀態分組承載（US6 接線）
- [X] T024 [P] [US1] 重皮 `apps/web/src/shared/components/StatusLight.vue`、`SeverityBadge.vue`、`ProgressBar.vue`、`MetricsPanel.vue` 與 `apps/web/src/domains/monitoring/components/FleetHealth.vue`：語意 token、中文 label（FleetHealth 標題「機群健康」、四計數「正常／警告／嚴重／停滯」）、最小字級 12px、徽章 `bg-*-bg + text-*-fg`；FleetHealth 的 stale 色改用 `bg-stale`，與卡片統一（FR-004）；`MetricsPanel.vue` 自有的「Ns ago」字串改用 `shared/lib/format.ts` 的 `formatRelative`（Phase 1 未動，WEB-7 測試斷言需同步）
- [X] T025 [US1] 重做 `apps/web/src/shared/components/TopBar.vue` 文案與分組（FR-034 四組；搜尋、暫停／恢復、Mock 頻率、連線 chip「已連線 · N ms」／「重新連線中」／「已斷線」、未授權、診斷）；主要動作「診斷」為 `bg-accent` 深青實心
- [X] T026 [US1] 重做 `apps/web/src/App.vue` 的 rail 內容：品牌列（名稱、環境「開發」）、`FleetHealth`、`AnomalySummary`（本任務建立 `apps/web/src/domains/monitoring/components/AnomalySummary.vue` 空殼並掛進 rail，內容由 US5 T050 改寫）、`ThemeToggle`；移除側欄機台清單（clarify Q1）；連線橫幅文案改中文
- [X] T027 [US1] 重做 `apps/web/src/domains/monitoring/components/MachineNodeCard.vue` 視覺層（不含 US3 刻度與 US5 標記）：玻璃卡片、名稱中文、id mono、狀態徽章＋狀態燈、2×2 數值 24px mono（`fontSize.number` 改 24px；單位移到標籤列避免位數變化換行）、更新時間用 `formatRelative`；嚴重卡片 `bg-crit-bg/80` 加 `border-crit`、卡內嚴重徽章加 1px `border-crit`；warning 改 1px `border-warn` 全邊框（FR-030）；停滯改為虛線邊框＋「停滯」徽章（與 id 同列），**不再整卡降透明**（實作裁決：降透明會讓小字對比跌破 FR-005 的 4.5:1）；hover 不位移、玻璃轉不透明；選取 `data-selected` 規則用 accent
- [X] T028 [US1] 重做 `apps/web/src/domains/monitoring/components/EventStrip.vue` 視覺層：玻璃面板、標題「事件流」、每個事件列項左側蝕刻短線（依嚴重度上色）、時間 `formatClock`、中文訊息、`count` 顯示 `×N`（資料接線在 US5）
- [X] T029 [US1] 重做 `apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue`、`DiagnosisResultView.vue`、`StreamingPanel.vue`、`SuggestedActionList.vue` 的視覺層與文案（AI 診斷／閒置／進行中／已完成／失敗／摘要／可能原因／證據／建議動作／原始串流／中止診斷／重試／快取；嚴重度 ok／warning／critical 譯正常／警告／嚴重）；移除 `border-l-2` 左色條（critique side-tab）。Phase 3 實作裁決：「重試」為主要層級（失敗態唯一動作且即再次診斷）、「中止診斷」中性次要（不採草圖紅框）、快取徽章中性色；步驟標籤中文對照暫放元件層 `STEP_LABEL`，T047 收斂回 `job-steps.ts`；佇列名 `diagnosis` 視為技術識別碼（T069 回補 FR-038 例外清單）
- [X] T030 [US1] 測試：更新既有 `MachineNodeCard.test.ts`、`MachineNodeCard.css.test.ts`、`CopilotDrawer.test.ts`，改為新 class 與中文文案的斷言；**新增** `apps/web/src/shared/components/TopBar.test.ts`（四個語意分組存在且各組可見選項 ≤ 4、「診斷」按鈕文案、連線 chip 三種中文文案）與 `apps/web/src/domains/monitoring/components/EventStrip.test.ts`（標題「事件流」、`formatClock` 24h 時間、`count > 1` 顯示 `×N`）
- [X] T031 [US1] 跑 `impeccable detect --json apps/web/src apps/web/index.html` 與 live URL；修正全部 finding（或記 ignore 理由）；用 T002 的 `apps/web/scripts/screenshots.cjs --viewports` 截 10 張，人工檢查對比與可辨性。結果（2026-10-16）：detect 僅 2 筆 `design-system-font`（Source Sans 3／Noto Sans TC 未列於舊 DESIGN.md，R3 定案字型，T066 重寫後消失），以 `impeccable hooks ignore-value design-system-font …` 記於 `apps/web/.impeccable/config.json`，之後 0 finding；10 張截圖兩主題皆可辨、無溢出，發現並修正 768×1024 面板擠壓與 dark 遮罩（見 T022 裁決）；截圖腳本 `applyTheme` 改點「未按下」段並用 `dispatchEvent`、`ensureCopilotOpen` 加 `:visible`

**Checkpoint**: 新視覺世界 light／dark 可切換、狀態三重編碼、無舊 token；既有功能行為不變。

---

## Phase 4: User Story 2 - 背壓比值常駐可見 (Priority: P1)

**Goal**: 量筒式背壓 strip 常駐於首屏，含速率、60 秒視窗比值、走勢線、比值刻度、液位線與丟棄數。

**Independent Test**: quickstart 場景 1、3、4；mock 20 ms 下觀察 60 秒。

- [X] T032 [US2] 在 `apps/web/src/domains/monitoring/stores/monitoring.store.ts` 掛 `RateSeries`：於既有 1 秒 `tickNow` 推入差分樣本（`receivedMessages`／`renderedBatches`／`droppedMessages`）、斷線時 `markStale`；暴露 `rateSeries`（shallowRef）、`ratePeak`、`windowRatio`、`droppedInWindow` getter；累計比值沿用 `backpressure.ts` 供 tooltip
- [X] T033 [P] [US2] 新建 `apps/web/src/shared/components/Graduation.vue`：靜態 SVG **比值刻度**（FR-009a：0–60、線性、1 格 = 1:1、每 10 格大格並標數字、`stroke-etch`），`role="img"` 加 `aria-label`（例：「背壓比值刻度 0 到 60」）
- [X] T034 [P] [US2] 新建 `apps/web/src/shared/components/Sparkline.vue`：props `samples`、`peak`；兩條 polyline（訊息實線、批次虛線）、`preserveAspectRatio="none"`、旁標「近 60 秒」小字（不共用比值刻度）；reduced-motion 時無 transition、瞬間更新；`role="img"` 加文字摘要（例：「近 60 秒每秒訊息 N、每秒批次 M」）
- [X] T035 [US2] 新建 `apps/web/src/shared/components/BackpressureStrip.vue`（`data-fg="backpressure"`，`role="region"`、`aria-label` 含目前比值，例：「背壓，比值 4.2 比 1」）：三組數字（每秒訊息 → 每秒批次 → 60 秒視窗比值 `text-ratio` mono，`data-fg="ratio"`，累計比值放 tooltip）、`Graduation`、液位線（2px `bg-accent`，left = `min(windowRatio, 60) / 60`，超過上限釘右端標「>60」）、`Sparkline`、丟棄數（`droppedInWindow > 0` 才顯示、`text-warn`）、斷線標示「連線中斷」；手機保留比值與訊息數，**丟棄數手機也顯示**（Phase 4 審查裁決：FR-011 無 viewport 例外，以短文案「丟棄 N」恆佔位、不改高度；「連線中斷」手機隱藏，由主區橫幅說明）。其他 Phase 4 實作裁決：`Graduation`／`Sparkline` 檔名保留、以 `defineOptions({ name })` 過 lint；刻度加 5 的中格；走勢線與狀態欄同一固定高度外層（窄版 ≤ 32rem 時整塊換列，strip 約 146px、不隨狀態長高）；液位線用 `translateX` 不用 `left`；重連時 `clearSamples` 清掉斷線前樣本；累計比值無批次時為 null、併入 region 名稱；`BackpressureStrip` 只收 props
- [X] T036 [US2] 在 `apps/web/src/App.vue` 用 `BackpressureStrip` 取代「Fleet monitor · N machines」標題列與 TopBar 內的 `BackpressureBadge`；刪除 `apps/web/src/shared/components/BackpressureBadge.vue`（無既有測試檔），`backpressure.ts` 保留累計比值計算；確認五個 viewport 不捲動可見（strip 放在連線橫幅之上，斷線橫幅不會把比值往下推；2026-10-16 十張截圖確認）
- [X] T037 [US2] 新增元件測試 `apps/web/src/shared/components/BackpressureStrip.test.ts`：比值大字存在且為視窗比值、region 名稱含比值、丟棄數為 0 時不渲染、stale 時顯示「連線中斷」、比值 > 60 時液位線釘右端並顯示「>60」

**Checkpoint**: SC-001、SC-005 可驗；critique P0 關閉。

---

## Phase 5: User Story 3 - 產線 stage 拓樸主畫面 (Priority: P2)

**Goal**: 三 stage 欄加流向連線取代無序網格；連線粗細與流動隨 throughput；手機堆疊。

**Independent Test**: quickstart 場景 3、4；搜尋清空某欄；reduced-motion。

- [X] T038 [P] [US3] 新建 `apps/web/src/domains/monitoring/components/FlowLink.vue`（`data-fg="flow-link" data-speed`）：SVG 線＋箭頭、`aria-hidden="true"`（裝飾性）、`stroke-width` 由 props、`animate-flow` 依 speed 等級設定 `animation-duration`（三檔）、`none` 時無動畫；垂直模式（手機）props `orientation="vertical"` 時 speed 強制 `none`（FR-016）
- [X] T039 [P] [US3] 新建 `apps/web/src/domains/monitoring/components/StageColumn.vue`（`data-fg="stage" data-stage`）：`role="region"`、`aria-label`＝中文 stage 名；標題只用中文（不附英文副標，FR-038）、機台數、卡片 `flex-col gap-3`、空狀態文案「此階段無符合的機台」。Phase 5 實作裁決：stage 欄**不包玻璃面板**（卡片本身是玻璃片，再包一層成卡中卡，craft-floor 明列；草圖 `assigned.html` 亦為卡片直接放桌面、只有標題），direction contract 前文「三片並排玻璃」以草圖為準；T065 finish review 的 prompt 要註明此裁決
- [X] T040 [US3] 新建 `apps/web/src/domains/monitoring/components/StageTopology.vue`：grid 三欄（`minmax(220px,1fr)`）＋兩個 `FlowLink`；以 `stage-layout.ts` 的 `assignToStages(store.visibleMachineIds, MACHINE_GROUPS)` computed 分欄；`flow-link.ts` 計算每段 width／speed（每幀至多一次）；單欄堆疊、FlowLink 垂直的切換依**容器寬度**（ResizeObserver，< 708px 堆疊；無此 API 退回 `< md`，Phase 5 裁決，見 T062 註記）；主區容器保留桌面格線；流動虛線 `6 6`（週期 12 整除 keyframe -24）、`stroke-ink-3` 不用 accent、三檔 2.4／1.2／0.6s
- [X] T041 [US3] 在 `apps/web/src/App.vue` 以 `StageTopology` 取代 `TopologyCanvas`，刪除 `TopologyCanvas.vue`（無既有測試檔；搜尋空狀態改由 T043 的 `StageColumn.test.ts` 新增斷言覆蓋）；StageTopology 的捲動容器 MUST 保留 ≥ 8px 內距（App.vue 外層有 `overflow-hidden rounded-card`，卡片焦點環 2px 與 critical 光暈 6px 貼邊會被裁掉，Phase 3 審查提醒）
- [X] T042 [US3] `MachineNodeCard.vue` 加每個數值旁的 3 格蝕刻小刻度（inline SVG），超標門檻沿用 `telemetry-format.ts` 既有的 `offendingMetrics` 越界判定（`card-style.ts` 只放外觀 class；warning／critical 時 `stroke-warn`／`stroke-crit`），並確認狀態變化不改尺寸（既有 `min-h` 與固定 StatusLight 外框維持）
- [X] T043 [US3] 新增元件測試 `StageTopology.test.ts`（三欄順序與歸屬、空欄保留）、`StageColumn.test.ts`（中文標題無英文副標、region 名稱、空狀態文案）、`FlowLink.test.ts`（速度等級映射到 `data-speed`、reduced-motion 與垂直模式下為 `none`、`aria-hidden`）

**Checkpoint**: 拓樸可用、連線隨 throughput 變化、手機堆疊無溢出。

---

## Phase 6: User Story 4 - 診斷串流與結果的呈現 (Priority: P2)

**Goal**: 串流漸進填入結果骨架、原始串流可展開、完成態重排與 meta、快取耗時對比、失敗分類。

**Independent Test**: quickstart 場景 5、6、7、16。

- [X] T044 [US4] 在 `apps/web/src/domains/ai-copilot/stores/copilot.store.ts` 加 `timings: Map<machineId, DiagnosisTiming>`：`diagnose()` 送 POST 前 `startTiming`，reducer 之後若轉 completed 則 `settleTiming`，failed／cancel 則 `cancelTiming`；暴露 `timingFor(machineId)`；更新 `copilot.store.test.ts`
- [X] T045 [P] [US4] 新建 `apps/web/src/domains/ai-copilot/components/ResultSkeleton.vue`（`data-fg="result-skeleton"`，每欄位 `data-field data-field-state`）：props `partial: PartialResult`；missing 顯示佔位條、streaming 顯示已解析內容＋游標（`animate-stream-caret`，reduced-motion 停）、complete 正常顯示；每欄位以視覺隱藏文字傳達狀態（「尚未產生」／「生成中」／「已完成」）；順序 摘要＋嚴重度 → 建議動作 → 可能原因 → 證據
- [X] T046 [US4] 改寫 `apps/web/src/domains/ai-copilot/components/DiagnosisResultView.vue`：區段順序改為 摘要＋嚴重度 → 建議動作 → 可能原因 → 證據；證據用 `evidence-merge.ts` 合併（顯示 `×N`、不顯示時間）並預設 2 筆＋「還有 N 筆」展開；嚴重度色條（頂部 2px）
- [X] T047 [US4] 改寫 `apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue`：active 態以 `parsePartialDiagnosis(streamText)` computed 餵 `ResultSkeleton`，`StreamingPanel` 改為可展開的「原始串流」區（預設收合）；completed 態移除滿版 ProgressBar，改 meta 一行（`data-fg="timing" data-cached`：`完成 HH:mm:ss · N.N s`，快取時 `快取 · N ms` 用 `text-ratio` 並列 `上一次 N.N s`）；cached 結果不走動畫；failed 態用既有 `humanizeError` 分類文案、提供重試，並以原始串流（展開）呈現中斷前推理、不顯示骨架；步驟清單標籤改中文。Phase 6 實作裁決：drawer 直接讀 copilot store 的 `timingFor`／`completedAtFor`（不經 App.vue props）；meta 畫在 `DiagnosisResultView`（prop `meta`）；嚴重度色條在結果區頂端；失敗態保留 `ProgressBar status="failed"`；證據合併後不顯示 `ev.id`；「中止診斷」移到進度列旁；骨架佔位條 `bg-ink/20`；`STEP_LABEL` 已收斂回 `job-steps.ts`
- [X] T048 [US4] 測試：更新 `CopilotDrawer.test.ts`（failed 態顯示原始串流不顯示骨架、cached 對比）；新增 `ResultSkeleton.test.ts`（三態與狀態文字、順序）、`DiagnosisResultView.test.ts`（順序、證據收合與 `×N` 合併、meta、cached 對比）

**Checkpoint**: critique 的兩個 P1（結果順序、串流／Cached）關閉；SC-008 可驗。

---

## Phase 7: User Story 5 - 異常與診斷狀態的記憶 (Priority: P2)

**Goal**: latch 標記（卡片＋異常摘要列，兩處確認同步、劃線至期滿）、卡片診斷狀態 chip、事件流可點擊與合併。

**Independent Test**: quickstart 場景 8、9。

- [X] T049 [US5] 在 `monitoring.store.ts` 的 `applyTelemetryBatch` 既有 prev→next 判斷處接 `anomaly-latch.ts`（時間用該批的客端 `receivedAt`；`latches: shallowRef<Map>`，批次結束 `triggerRef` 一次）、事件改用 `mergeEvent`；新增 `clearLatch(machineId)`、`anomalySummary` getter（`summarize(latches, staleNow, …)`，以 `staleNow` 判定可見性：Pause 期間凍結顯示、恢復後依實際經過時間判定）；更新 `monitoring.store.test.ts`（回復 30 s 期滿、Pause 凍結、恢復後 Pause 期間計入、清除後劃線、warning 升 critical 重置確認；**Phase 2 審查提醒**：既有「超過 50 上限（同一台交替 warning／critical）」與「同批次同機台 id 唯一」兩條測試在改接 `mergeEvent` 後會因合併而失敗，須改寫為不同機台或拉開時間）
- [X] T050 [US5] 改寫 T026 建立的 `apps/web/src/domains/monitoring/components/AnomalySummary.vue` 空殼（`data-fg="anomaly-summary"`）：`<ul role="list">` 清單（狀態燈、中文名、相對時間——進行中「進入 N 秒前」錨 `enteredAt`、回復後「已回復 N 秒前」錨 `recoveredAt`，皆用 `formatRelative`；已確認者劃線）、點擊 `selectMachine`、每列清除鈕（`aria-label="清除 ○○ 的異常標記"`）、空狀態「目前沒有異常」；`apps/web/src/App.vue` 的 rail 接線改讀 `anomalySummary`／`clearLatch`。Phase 7 實作裁決：元件只收 props／emit（T061 重用）；清除鈕 `data-fg="anomaly-clear"`、選取鈕 `anomaly-select`（與卡片 `latch-clear` 區分）；文案「嚴重 · 進入 N 秒前」「嚴重 · 已回復 N 秒前」，2 秒內「剛進入／剛回復」；已確認列劃線＋隱藏清除鈕留同尺寸佔位；選取列 `bg-accent-wash ring-1 ring-inset ring-accent`；side rail 拖到 200px 時兩行排版仍可讀（2026-10-16 截圖）
- [X] T051 [US5] `MachineNodeCard.vue` 底列加異常標記（`data-latch`、確認後 `data-latch-cleared` 並以劃線呈現、可點擊清除、`data-fg="latch-clear"`、`tabindex=-1`；相對時間錨點同 T050：「嚴重 · 進入 N 秒前」／「嚴重 · 已回復 N 秒前」；出現動畫在 reduced-motion 下停用）與診斷狀態 chip（`data-diagnosis`：診斷中 N%／結果 · 嚴重度／快取／失敗），皆不改卡片尺寸；在 `apps/web/src/domains/ai-copilot/stores/copilot.store.ts` 新增 `badgeFor(machineId)` computed（data-model §7，由每台狀態 Map 衍生）供 chip 使用，並更新 `copilot.store.test.ts`（none／active／completed（含 cached）／failed 四態）；**Phase 3 審查提醒**：AppLayout 的 peek 條是 `<button aria-label>`，slot `peek-status` 的內容會被 aria-label 蓋掉且不能放互動元素——chip 放進 peek 條時要把狀態併進 aria-label、chip 本身非互動。Phase 7 實作裁決：清除鈕不能巢狀在卡片主按鈕內，底列移到主按鈕外絕對定位（`pointer-events-none`、主按鈕 `aria-describedby` 指向標記文字與更新時間）、主按鈕底部留固定 `h-5` 佔位（卡片固定高 4px）；**診斷 chip 放在 id 列**（1366 面板展開時底列約 159px 放不下標記＋chip），底列只留標記＋更新時間；`DiagnosisBadge`／`diagnosisBadgeOf`／`diagnosisBadgeText` 抽到 `domains/ai-copilot/lib/diagnosis-badge.ts`（T062 peek 條用 `diagnosisBadgeText`），嚴重度譯名收成 `shared/lib/severity-label.ts`；出現動畫 `latchIn`（opacity 0.35→1，reduced-motion 停）
- [X] T052 [US5] `EventStrip.vue` 每個事件列項改 `<button>`（`data-fg="event" data-machine data-severity data-count`）點擊 `selectMachine`；合併次數 `×N`；回復事件中性色；上限 50 不變；面板容器有 `overflow-hidden`，列項焦點環用 `ring-inset` 以免被裁切（Phase 3 審查提醒）。Phase 7 實作：`<li class="group">` 內滿寬 `<button>`（分隔線在 button 上、列高維持 32px），prop `selectedId` → `aria-current`＋`bg-accent-wash ring-1 ring-inset ring-accent`＋訊息 `text-ink`；回復事件文字維持 `text-ink-2`
- [X] T053 [US5] 測試：新增 `AnomalySummary.test.ts`（清單角色、排序、空狀態、清除後劃線）；更新 `MachineNodeCard.test.ts`（latch 可見、清除後兩處同步劃線、期滿消失、chip 四態）與 T030 建立的 `EventStrip.test.ts`（事件列項可點擊選台、`×N`、回復事件中性色）

**Checkpoint**: SC-009 可驗；critique 的「異常無記憶」P1 關閉。

---

## Phase 8: User Story 8 - 鍵盤操作與快捷鍵 (Priority: P3)

**Goal**: `/`、方向鍵、Enter、`d`、`x`、Escape、`?` 與把手鍵盤調整；每張卡片一個 Tab 停駐點。

**Independent Test**: quickstart 場景 10。

- [X] T054 [US8] 新建 `apps/web/src/shared/composables/useKeyboardShortcuts.ts`：App 層 `keydown`；**只收注入的 callbacks**（`focusSearch`、`selectMachine`、`diagnose`、`clearLatch`、`togglePanel`、`clearSelection`、`toggleHelp`），不 import 任何 `domains/` 模組；`isTypingTarget` 守門；`/` 聚焦搜尋、Enter（搜尋框內且結果恰一台、非 IME）選取並把焦點移到該台卡片（手機覆蓋式搜尋同時收回）、方向鍵用 `focus-grid.ts` 移焦（讀 `.machine-card` 的 `getBoundingClientRect`）、Enter 選取、`d` 診斷**選取**機台（不作用於僅聚焦的卡片）、`x` 清除聚焦卡片 latch、Escape 每次只關最上層一項（說明層 → 搜尋覆蓋 → 手機異常覆蓋層 → Copilot 面板（手機即 bottom-sheet；呼叫 `togglePanel` 只關當次，不寫 `manuallyCollapsed`）→ 取消選取）、`?` 開關說明層。`apps/web/src/App.vue` 負責接線，`diagnose` callback 由 `useDiagnoseTrigger` 提供（前置條件與去重同診斷按鈕）；`shared/layering.test.ts` MUST 維持綠。**Phase 2 審查提醒**：上列 callbacks 不足以支撐 Escape 五層——缺「關搜尋覆蓋」「關手機異常覆蓋層」與「哪一層開著」的查詢；派工前先把注入介面補齊，建議依 `shortcuts.ts` 的 `ESCAPE_LAYERS` 收 `Record<EscapeLayerId, { isOpen(): boolean; close(): void }>`，依陣列順序關第一個開著的層；按鍵比對用 `SHORTCUTS[].eventKeys`、IME 守門用 `isImeComposing`。Phase 8 實作：注入介面 `KeyboardShortcutHandlers`（focusSearch／selectMachine／clearSelection／diagnose／clearLatch／toggleHelp／getSelectedId／getSearchResultIds／isLatchVisible／layers）；守門順序 defaultPrevented／IME → 搜尋框只放 Enter → isTypingTarget → Ctrl／Meta／Alt → repeat 只允許方向鍵；說明層開著時只處理 `?` 與 Escape；AppLayout 自己的 window Escape 監聽已移除（否則一次關兩層）、MetricsPanel 關閉時 `preventDefault`；`search-overlay`／`anomaly-overlay` 兩層先 `isOpen: () => false`，T060／T061 接真實狀態；T059 後 `copilot-panel.isOpen` 改讀 store 的 `panelOpen`；2026-10-16 真實瀏覽器驗證：→ 移焦、Enter 選取、`?`、Escape 三次依序關說明層／面板／選取、把手 ArrowRight → 256
- [X] T055 [P] [US8] 新建 `apps/web/src/shared/components/ShortcutHelp.vue`（`data-fg="shortcut-help"`，`role="dialog"`、焦點陷阱、Escape 關閉、不遮工具列），內容由 `SHORTCUTS` 常數渲染
- [X] T056 [US8] 改 `MachineNodeCard.vue` 為單一 Tab 停駐點：卡片本體 `tabindex=0`，診斷圖示與 latch 清除鈕 `tabindex=-1`（滑鼠仍可點；診斷圖示的鍵盤替代為 Enter 選取後按 `d`）；`TopBar.vue` 搜尋框支援 Enter 選取唯一結果，選取後焦點移到該台 `.machine-card`（手機覆蓋式搜尋同時收回），使後續 `d` 不被輸入欄守門擋下；**Phase 3 審查提醒**：嚴重卡片的 `focus-visible:ring-2`（box-shadow）會被 `animate-critical-pulse` 的 box-shadow 動畫蓋掉，未選取的嚴重卡片聚焦時看不到焦點環——改用 `focus-visible:outline` 並與 `.machine-card[data-selected]` 的 outline 規則排定優先順序。Phase 8 實作：`tailwind.css` 在選取規則之後加 `.machine-card:focus-visible { outline: 2px solid focus; outline-offset: 2px }`（shorthand 一條，cascade 測試鎖順序；外延 4px 由 StageTopology `p-2` 容納）；診斷圖示 `tabindex=-1`＋`group-focus-within:opacity-100`＋`@mousedown.prevent`；TopBar Enter 主處理並同步 `preventDefault`、`defineExpose({ searchInput })`
- [X] T057 [US8] `apps/web/src/shared/composables/useResizeDrag.ts` 加鍵盤：把手 `tabindex=0`、`role="separator"`、`aria-label`、`aria-valuenow/min/max`、方向鍵 ±16px（側欄 ArrowRight 加寬／ArrowLeft 減寬；事件流 ArrowUp 增高／ArrowDown 減少，與既有 `direction: -1` 對應；範圍沿用既有：側欄 200–420、事件流 100–360）；localStorage 讀寫改經 `useLocalPreference`（key 沿用 `flow-gatekeeper:sidebar-width`／`flow-gatekeeper:event-strip-height`）；`AppLayout.vue` 與 `App.vue` 的把手接線。Phase 8 實作：`useResizeDrag` 回 `{ size, startDrag, onKeydown, handleAttrs }`（`handleAttrs` computed 含 tabindex／role／aria-*，`v-bind`）、方向鍵語意不受 `direction` 影響、Home／End 跳界、拖曳值取整、補 `pointercancel`；aria-valuetext「N 像素」
- [X] T058 [US8] 測試：新增 `useKeyboardShortcuts.test.ts`（happy-dom：輸入欄與 IME 守門、Escape 五層順序（說明層 → 搜尋覆蓋 → 手機異常覆蓋層 → Copilot 面板 → 取消選取）每次只關一層且關面板時不寫手動收合偏好、`d` 呼叫注入的 diagnose、搜尋框 Enter 選取唯一結果後焦點移到該台卡片且接著按 `d` 會呼叫 diagnose、`d` 不作用於僅聚焦未選取的卡片、`x` 只在聚焦卡片且標記可見時呼叫 clearLatch、`?` 開關）、`ShortcutHelp.test.ts`（dialog 角色、列出含 `x` 的全部快捷鍵、Escape 關閉）、`apps/web/src/shared/composables/useResizeDrag.test.ts`（方向鍵 ±16px 且方向對應正確（側欄 Right 加寬、事件流 Up 增高）、範圍夾限 200–420／100–360、aria 值、localStorage 拋錯時回預設）

**Checkpoint**: SC-014 可驗；5 張卡 5 個停駐點。

---

## Phase 9: User Story 6 - 響應式與平板策略 (Priority: P3)

**Goal**: 面板預設收合與偏好、搜尋收合、1024×768 不重疊、手機機群健康摘要條與主題切換位置、bottom-sheet 把手。

**Independent Test**: quickstart 場景 3（10 張截圖逐項）、場景 2。

- [X] T059 [US6] `copilot.store.ts` 加 `panel: { manuallyCollapsed }`（`useLocalPreference` 讀寫 `fg.copilot-panel`）與 `panelOpen` getter（data-model §2：載入收合；無偏好時選台展開；有手動收合偏好時選台不展開；觸發診斷或點展開把手 → 展開並清除偏好；只有面板上的收合鈕記錄手動收合偏好，Escape 收合只設當次 `open = false`；取消選取 → 收合）；`AppLayout.vue`／`App.vue` 改讀此 getter，移除 Phase 3 的 `panelOpen` ref；接線依 Phase 3 既定的事件分流：CopilotDrawer 收合鈕 emit `close`（寫偏好）、Escape／遮罩 emit `dismiss`（不寫偏好）、AppLayout 的 `dismiss-panel`（桌機 Escape）同樣不寫偏好。Phase 9 實作：store `panel` reactive＋`PANEL_PREFERENCE_KEY`，actions `onMachineSelected`／`openPanel`／`collapsePanel`／`dismissPanel`，getter `panelOpen`；`diagnose()` 開頭 `openPanel()`（被前置條件擋下也展開以顯示原因，`d` 與卡片圖示同路徑）；`$onAction(selectMachine)` 讓再選同台依偏好重新展開；偏好值不變不寫 storage
- [X] T060 [US6] `TopBar.vue` 容器查詢三段：≥820 全部；640–819 只留圖示；<640 搜尋收成圖示鈕（點擊或 `/` 展開覆蓋式輸入、Escape／失焦收回）、Mock 頻率與 Metrics 隱藏、`ThemeToggle` 移入系統狀態分組（手機）；任一分組 ≤ 4 個可見。Phase 9 實作：段位以 ResizeObserver 量 `.tb-bar` 寬度（`data-tb-size`）；主題切換依**視窗** `< 768` 顯示於工具列（rail 隱藏時），且工具列內一律 `ThemeToggle variant="icon"` 單一圖示鈕（390 寬「重新連線中＋未授權」時兩段式會把診斷鈕裁掉 7px）；指標面板只在非 compact 且 rail 在時渲染；覆蓋式搜尋與一般搜尋共用同一 `<input>`、`bg-rim` 橫條、Escape／失焦／收回鈕／Enter 唯一結果收回；`defineExpose({ searchInput, size, isSearchOverlayOpen, openSearchOverlay, closeSearchOverlay, focusSearch })`
- [X] T061 [US6] `FleetHealth.vue` 加 `compact` 模式＝「機群健康摘要條」（`data-fg="fleet-summary-bar"`，比例條＋四計數一列）；`App.vue` 在 `< md` 時於主畫面頂端渲染摘要條，點擊展開 `AnomalySummary`（異常摘要列）覆蓋層（Escape／點外部收合、`role="dialog"`），不推擠拓樸。Phase 9 實作：`FleetHealth compact`（`expanded`／`controls`、emit `toggle`，`h-11` button）；新元件 `AnomalyOverlay.vue`（`fixed top-14 z-[60]`，面板自摘要條下緣 `top-16` 起、不捲動標題列放關閉鈕、內部重用 AnomalySummary 去外框）；App.vue `isMobile` matchMedia、摘要條放背壓 strip 之上、≥ md 不渲染且 `anomalyOverlayOpen` 歸零；覆蓋層開著時 composable 只處理 Escape 與 `/`
- [X] T062 [US6] `AppLayout.vue` 手機 bottom-sheet：頂部抓取把手、閒置態高度收斂（`min-h` 改依內容）；任何收合（收合鈕或 Escape）只要仍有選取機台即退為 32px peek 條（`data-fg="copilot-peek"`，顯示選取機台中文名與診斷狀態 chip，點擊等同展開把手：展開並清除手動收合偏好；Escape 收合仍不寫偏好），取消選取才完全隱藏；1366×768 與 1024×768 面板展開時三欄仍各容一張完整卡片（必要時卡片 `minmax` 調整；Phase 5 現況：StageTopology 以容器寬度 < 708px 切堆疊，1024 展開面板時主區約 400px 會走堆疊，本任務要決定縮 `minmax` 讓三欄並排或接受堆疊，並更新 `StageTopology.test.ts`）。Phase 9 裁決：**維持 220px、1024 展開面板接受堆疊**（200px 放不下嚴重溫度五位數；1024 展開主區僅約 366px，縮多少都放不下三欄）。已知限制：1366×768 展開面板時主區剛好 708px＝門檻，拓樸區一出現垂直捲軸（事件流拉到 360、斷線橫幅）ResizeObserver 讀到的 contentRect 少掉捲軸寬（Windows 約 15px）就翻成堆疊；headless 截圖看不到捲軸，T077 要用有視窗的 Chrome 在 1366 把事件流拉高驗一次，必要時再議（候選：面板預設寬 360→348、或 `scrollbar-gutter: stable` 搭配門檻微調）
- [X] T063 [US6] 擴充 `apps/web/scripts/screenshots.cjs`（自 T002 雛形）：`--viewports` 模式輸出五 viewport × 兩主題 × 面板展開共 10 張，並在 hover／選取／critical 脈動前後量測每張 `.machine-card` 的 bounding rect、另於搜尋過濾前與清除搜尋後比對 stage 欄與卡片的 rect（FR-015），差值不為 0 時以非 0 結束（SC-004）；人工逐項檢查 SC-004 並修正發現的溢出／重疊。Phase 9 實作：量測 overflow／search（含 768／390 經覆蓋式搜尋；命中 0 或全部或無空欄 → skipped，有差值仍 fail）／pulse（7×200ms，記 transitions）／hover（被遮時 CDP forcePseudoState）／selected（先確保面板展開），內容座標、容差 0.5px，干擾偵測（HMR／導覽／WS 錯誤）只記錄；新選項 `--search`／`--pulse-wait`／`--only`／`--no-fail`；2026-10-16 全量實跑五 viewport × 兩主題 0 件、0 skipped，人工看截圖無溢出重疊
- [X] T064 [US6] 測試：新增 `apps/web/src/shared/components/AppLayout.test.ts`（面板預設收合、無偏好時選台展開、手動收合後選台不展開、診斷後展開並清除偏好、偏好跨重新掛載保留、取消選取收合、手機以收合鈕與以 Escape 收合後皆出現 peek 條（Escape 不寫偏好）且點擊展開並清除偏好、取消選取後 peek 條不渲染）、`apps/web/src/domains/monitoring/components/FleetHealth.test.ts`（compact 摘要條四計數、點擊展開覆蓋層）；更新 T030 建立的 `TopBar.test.ts`（三段收合與手機主題切換位置）

**Checkpoint**: SC-004、SC-007 可驗；critique P2 關閉。

---

## Phase 10: User Story 7 - 視覺真實來源切換與文件回補 (Priority: P3)

**Goal**: merge 前 MUST 完成的真實來源回補、README 截圖、CHANGELOG。

**Independent Test**: quickstart 場景 13、15、16。

- [ ] T065 [US7] 跑 impeccable finish review：spawn `impeccable-finish-reviewer`（給 direction contract 路徑、`assigned.html`、10 張截圖；prompt 明列「FR-009a（比值刻度 0–60，非時間）、FR-005（最小功能性字級 12px）、FR-031（五個 viewport）與 direction contract 的 AMENDMENTS 優先於草圖」），依其 ordered list 修 material fixes；再跑一次 `impeccable detect` 確認 0 finding（或皆有 ignore 理由）
- [ ] T066 [US7] spawn `impeccable-documenter` 重寫 `apps/web/DESIGN.md` 與 `apps/web/.impeccable/design.json`（從實作萃取兩套主題 token、元件、Named Rules）；人工複核 frontmatter token 與 `theme.css` 一致
- [ ] T067 [US7] 更新 `apps/web/PRODUCT.md`：Product Purpose（Diagnose／drawer／Cached／Retry 等 UI 術語改為繁中現況用語）、Capabilities and Constraints（token 值落在 `src/styles/theme.css`、`tailwind.config.ts` 只引用變數）、Positioning（背壓 strip 取代 TopBar 徽章）、Operating Context（側欄內容、Copilot 面板預設收合與偏好、三 stage 拓樸、手機機群健康摘要條、事件流合併與可點擊）、Accessibility 字級改為 12px，確認或移除所有 [推定] 標記
- [ ] T068 [US7] `/speckit-constitution`：第 II 條「視覺」條目改為「一律依 `apps/web/PRODUCT.md` 與 `apps/web/DESIGN.md`」，「開發工作流程與品質門檻」段對 design-spec 的引用改為「依 `apps/web/PRODUCT.md`『第一屏就是工作台』」，版本 1.5.0 → 1.6.0，兩處修訂皆記入 Sync Impact Report；依憲章 Governance 檢查 `.specify/templates` 相依模板有無 design-spec 引用並記入 Sync Impact Report；同步 `CLAUDE.md`「真實來源」段的視覺條目
- [ ] T069 [US7] `apps/web/design/design-spec.md` 檔頭加退役註記（FR-036 文字）；`git rm -r apps/web/design/refs`（含 `_sources/`）；全文搜尋 `design-spec.md` 與 `refs/` 的引用並逐處改寫或標示歷史，範圍包含 README、指南、CLAUDE.md、`apps/web/src` 內元件與測試的註解及 describe 名稱、`apps/web/index.html`、`apps/web/tailwind.config.ts`；`specs/` 與 `docs/*-research-review*.md` 屬歷史工件豁免
- [ ] T070 [US7] 完成 `apps/web/scripts/screenshots.cjs --readme`：依劇本產出 `docs/screenshots/` 12 張功能截圖（light）＋ `dark-theme.png`、`topology.png`；README 「功能逐項展示」圖說與術語改中文對照、22 秒 demo 劇本依新 UI 改寫（背壓 strip、串流骨架、快取耗時對比的位置，供 quickstart 場景 16 / SC-008）、設計連結指向 `apps/web/PRODUCT.md` 與 `apps/web/DESIGN.md`、「快速開始」加 `playwright-core` 與本機 Chromium 路徑說明、版本註記更新
- [ ] T071 [P] [US7] `docs/Flow-Gatekeeper-SDD-完整實作指南.md` §15.6 新增「013 UI 全面改版」段：視覺真實來源切換、雙主題、拓樸、背壓 strip（60 秒視窗比值）、文案語言、鍵盤；註明新增 `playwright-core` 推翻了 `MachineNodeCard.css.test.ts` 註解記載的「以 CSS cascade 測試取代 Playwright 截圖、不新增瀏覽器相依」取捨，並同步更新該測試檔註解。UI 術語中文對照（FR-038）只改**現況描述段**：指南 §15.6 新段與其中引用的現況說明；README 的術語由 T070 處理（「功能逐項展示」與「快速開始」）。歷史段落（既有 feature 章節、`docs/*-research-review*.md` 審查報告）依「回補不重寫歷史」豁免
- [ ] T072 [P] [US7] `CHANGELOG.md` `[Unreleased]`：使用者可見變更（視覺世界、light 預設／dark 切換、stage 拓樸、背壓 strip、串流骨架與快取耗時、異常 latch（確認後劃線）、事件合併與可點擊、面板預設收合與偏好、鍵盤快捷鍵、UI 文案繁中、README 截圖重拍）；契約小節註明「無變更」；相容性注意：localStorage 新 key、`playwright-core` devDependency
- [ ] T073 [US7] 重跑 `/impeccable critique`（雙 agent，目標 ≥ 30/40），快照存 `apps/web/.impeccable/critique/`；若未達標，依其 priority issues 修正後再跑一次（上限兩輪）

**Checkpoint**: SC-002、SC-008、SC-011、SC-012、SC-013 可驗；真實來源一致。

---

## Phase 11: Polish & 收尾

**Purpose**: 清理、全棧檢查、驗收與 merge 準備。

- [ ] T074 [P] 清理 `apps/web/.impeccable/`：只保留 `surfaces/`、`critique/`、`design.json`、`mocks/decision/assigned.html`（其餘草圖與 `payload.json` 刪除）；`.gitignore` 加 `apps/web/.impeccable/questions/` 與 `apps/web/.impeccable/hook.cache.json`
- [ ] T075 [P] 刪除不再使用的程式碼與 token：`card-style.ts` 中的 inset ring；複跑 T009 的舊 token grep 確認仍為 0 命中（`text-2xs` 已於 T009 清理）；確認 `TopologyCanvas`、`BackpressureBadge` 已無殘留引用（檔案已於 T036／T041 刪除）；`pnpm --filter web lint` 零警告；**Phase 9 提醒**：`matchMedia` 的 `useMediaQuery` 寫法在 `TopBar.vue`、`StageTopology.vue`、`App.vue` 各有一份，收成 `shared/composables/useMediaQuery.ts`（含測試）；`ShortcutHelp.vue` 與 `AnomalyOverlay.vue` 的焦點陷阱重複，可抽 `useFocusTrap`（iOS Safari 點按鈕不給焦點時的還原後備一併處理）；`shadow-sheet` 用在由上而下的面板時陰影方向相反，考慮加 `shadow-panel` token
- [ ] T076 全棧檢查：`pnpm check`（契約 lint、typecheck、lint、test）與 `pnpm build` 綠；`pnpm --filter web test` 含新增 ≥ 11 個純函式測試檔；`git diff develop -- packages/contracts asyncapi.yaml apps/api apps/worker` MUST 為空；grep `apps/web/dist/` 無 direction contract 字樣（`THESIS`、`OWN-WORLD`、`FIRST VIEWPORT`、`Lab Glass`）
- [ ] T077（Phase 9 提醒：iOS Safari 覆蓋式搜尋在 `nextTick` 後 `focus()` 可能不跳出虛擬鍵盤，須實機或模擬器驗一次；已知限制：rail 拉到 420px＋lg 面板展開＋1024 寬時工具列僅 214px 會溢出，不在驗收 viewport 預設狀態內）依 [quickstart.md](./quickstart.md) 場景 1–16 逐項驗收並在 quickstart 加「驗收總表」記錄結果與日期（場景 4 須記錄 20 ms mock、60 秒的實測每秒提交率與顯示器更新率，供 SC-005）；SC-001～SC-014 逐條勾選於 spec.md
- [ ] T078 更新 `specs/013-ui-redesign/spec.md` Status 為已完成、`CLAUDE.md` 管理區段改為「目前無進行中的 SDD feature；最近一次完成的是 013」；`/speckit-analyze` 複跑確認無跨工件矛盾；準備 `git merge --no-ff` 回 develop（push 前先與使用者確認）

---

## Dependencies & Execution Order

```text
Phase 1 Setup ──► Phase 2 Foundational ──► Phase 3 US1（MVP）
                                              │
                                              ├──► Phase 4 US2（背壓 strip；依賴 T032 store tick）
                                              ├──► Phase 5 US3（拓樸；依賴 US1 卡片、flow-link、stage-layout）
                                              ├──► Phase 6 US4（串流；依賴 partial-json、evidence-merge、timing、US1 Copilot 面板）
                                              └──► Phase 7 US5（記憶；依賴 anomaly-latch、events、US1 卡片／事件流）
US4 與 US5 都完成後 ──► Phase 8 US8（鍵盤：需要卡片、面板、latch 清除都存在）
US2／US3／US5／US8 完成後 ──► Phase 9 US6（響應式收尾：需要全部元件就位）
全部 UI phase 完成後 ──► Phase 10 US7（finish review、DESIGN.md、PRODUCT.md、憲章、README、CHANGELOG、critique）──► Phase 11 Polish
```

- US2、US3、US4、US5 在**行為**上互不相依，可在 US1 之後由不同 agent 推進，但下列共用檔案 MUST 依序修改（同一檔案不得平行）：
  - `apps/web/src/domains/monitoring/components/MachineNodeCard.vue`：T027 → T042 → T051 → T056
  - `apps/web/src/App.vue`：T026 → T036 → T041 → T050 → T054 → T057 → T059 → T061
  - `apps/web/src/domains/monitoring/stores/monitoring.store.ts`：T032 → T049
  - `apps/web/src/domains/ai-copilot/stores/copilot.store.ts`：T044 → T051 → T059
  - `apps/web/src/shared/components/TopBar.vue`：T025 → T036 → T056 → T060
  - `apps/web/src/shared/components/AppLayout.vue`：T022 → T057 → T059 → T062
  - `apps/web/src/domains/monitoring/components/EventStrip.vue`：T028 → T052
- US7 的 T068（憲章）MUST 在 T066（DESIGN.md 重寫）與 T067（PRODUCT.md 更新）之後，因為憲章條目要指向已存在且正確的兩份文件。
- T069 改寫指南中的 design-spec 引用、T071 新增指南 §15.6，兩者同檔：T069 不標 [P]，先於 T071 完成。

## Parallel Execution Examples

- **Phase 2**：T011–T020 十個純函式檔可同時由不同 agent 實作（各自檔案與測試）；T021 在其後。
- **Phase 3 之後**：一個 agent 做 US2（T032–T037），另一個做 US4（T044–T048），第三個做 US3（T038–T043）；涉及上列共用檔案的任務依序列順序交接；US5 的 T049 等 T032 併入後再開。
- **Phase 10**：T071、T072 文件任務可平行；T065 → T066 → T067 → T068 串行；T069 → T070 串行（皆改 README）。

## Implementation Strategy

- **MVP = Phase 1–3**：新視覺世界加雙主題，既有功能不變。此時已可 demo「改版後的樣子」並跑第一次 detect 與截圖。
- **第二增量 = Phase 4–7**：四個產品機制依 critique 優先級（P0 背壓 → P1 串流／記憶 → 拓樸）。
- **第三增量 = Phase 8–9**：鍵盤與響應式收尾，決定 SC-002 能否達 30/40。
- **收尾 = Phase 10–11**：真實來源回補是 merge 門檻，不可省略。
