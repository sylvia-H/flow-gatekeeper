# Implementation Plan: UI 全面改版（UI Redesign）

**Branch**: `013-ui-redesign` | **Date**: 2026-10-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-ui-redesign/spec.md`（含 Clarifications 兩輪共八項：specify 階段三項、clarify 階段五項）

---

## Summary

把 1.1.0 的「乾淨但無個性、賣點被藏起來」的監控台（critique 20/40）換成一個**為本產品而作**的視覺世界，並把四個產品機制放到該被看見的位置：

- **視覺世界：「實驗室玻璃與蝕刻刻度」**（plan 階段以 `/impeccable shape` 經三輪決策頁選定，使用者要求的品質是「穩重的專業感與材質層次」）。磨砂白玻璃面板、冷色實驗桌面、蝕刻刻度、深青液位線；**light 預設、dark 次要**（煙燻玻璃），同一套語意 token。direction contract 存於 `apps/web/.impeccable/surfaces/src-app-vue.md`，選定草圖 `apps/web/.impeccable/mocks/decision/assigned.html` 是 finish review 的對照基準。
- **四個機制**：背壓比值常駐為「橫放的量筒」strip（US2）；主畫面改為三 stage 產線拓樸、連線粗細與流動隨 throughput（US3）；串流漸進解析進結果骨架、Cached 以耗時對比呈現（US4）；異常 latch、側欄異常摘要列、卡片診斷狀態 chip、可點擊的事件列項（US5）。
- **其餘**：響應式與平板策略（US6）、最小完整快捷鍵集（US8）、視覺真實來源由 design-spec 切換為 PRODUCT.md + DESIGN.md 並回補憲章／CLAUDE.md／README／指南／CHANGELOG（US7）、UI 文案統一繁體中文、12+2 張 README 截圖以可重播劇本重拍。

技術路徑（詳見 [research.md](./research.md)）：**純前端、契約與後端零變更**。主題以 CSS custom properties 配 Tailwind 3 的 `rgb(var(--…) / <alpha-value>)` 落地，`data-theme` 同幀切換、localStorage 保存；磨砂玻璃只用 rgba 底色加 1px 內側高光，**不用 backdrop-filter**（craft floor 與高頻重繪效能）；背壓速率序列以 1 Hz tick 自既有計數器衍生（不進每幀路徑），比值主顯示改為 60 秒視窗比值、液位線標在 0–60 的比值刻度上；拓樸用 CSS grid 三欄加一層 SVG 連線；串流漸進解析用自寫的容錯 partial-JSON 純函式；latch、事件合併、耗時量測、快捷鍵皆為純函式加 composable，各有單元測試；README 截圖以 `playwright-core` 腳本一次產出。

**零契約變更是硬約束**（FR-039）；**高頻路徑不得新增逐筆 reactive 寫入**（FR-040）。

---

## Technical Context

**Language/Version**: TypeScript 5.6（strict）、Node.js 22（`.nvmrc`；本機 26 亦可）、ESM

**Primary Dependencies**：
- 既有：Vue 3.5、Pinia 3、Tailwind 3.4（PostCSS）、lucide-vue-next、Vite 7、vitest 4 + happy-dom + @vue/test-utils
- 新增（devDependency，`apps/web`）：`playwright-core`（README 截圖劇本與 critique 證據截圖；瀏覽器用本機已安裝的 Playwright Chromium，見 research R11）
- 不新增 runtime 相依：partial-JSON 解析、sparkline、拓樸連線、快捷鍵皆自寫

**Storage**: 瀏覽器 localStorage（新增：主題偏好 `fg.theme`、面板偏好 `fg.copilot-panel`；沿用不改名：`flow-gatekeeper:sidebar-width`、`flow-gatekeeper:event-strip-height`）；無後端儲存

**Testing**: vitest（純函式單元測試＋元件測試）、`pnpm --filter web typecheck/lint`；視覺驗收以截圖劇本（五 viewport × 兩主題，含 `.machine-card` bounding rect 量測）與 `impeccable detect`；finish review 由 impeccable finish-reviewer 對照 direction contract

**Target Platform**: 現代桌機與行動瀏覽器（Chromium／Firefox／Safari 近兩版）；五個驗收 viewport 1366×768、1440×900、1024×768、768×1024、390×844

**Project Type**: web application（monorepo 中的 `apps/web`；本 feature 只動此 app 與文件）

**Performance Goals**: 20 ms mock 遙測下每秒畫面提交 ≤ 顯示器更新率（既有 rAF 批次不變）；主題切換 1 幀內；走勢線、拓樸連線、latch 不增加每秒提交次數（SC-005）

**Constraints**: 契約與後端不動；具名 token、元件內無 hex；卡片圓角 ≤ 8px；無 backdrop-filter／光暈／漸層；功能性文字 ≥ 12px、對比 ≥ 4.5:1；reduced-motion 停止循環動畫；UI 文案繁體中文

**Scale/Scope**: 1 個 SPA 首屏、5 台固定機台、3 個 stage、16 個既有元件重做＋約 23 個新元件／composable／lib（確切清單以 tasks.md 為準）；28 個既有測試檔維持綠

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 說明 |
|---|---|---|
| **I. 規格驅動開發** | ✅ PASS | 在 `013-ui-redesign` 分支走完整 Spec Kit 流程；plan 階段嵌入 `/impeccable shape` 作為視覺方向的決策工具，不取代流程。implement 期間不手貼完整 code。 |
| **II. 單一真實來源** | ⚠️ PASS with amendment | 本 feature 的 US7 把視覺真實來源由 `apps/web/design/design-spec.md` 切換為 `apps/web/PRODUCT.md` + `apps/web/DESIGN.md`。**憲章第 II 條的「視覺」條目與「開發工作流程與品質門檻」段對 design-spec 的引用 MUST 在 merge 前經 `/speckit-constitution` 修訂**（FR-035；Complexity Tracking 記錄）。token 紀律（具名 token、不散落 hex）不變且由 `impeccable detect` 與 lint 把關；Argo CD 品牌資產不使用。 |
| **III. 契約優先與型別安全** | ✅ PASS | 零契約變更（FR-039）；所有新狀態（主題、面板偏好、背壓序列、latch、診斷狀態 chip、耗時、partial result）皆為前端衍生，型別定義在 `apps/web` 內、以契約型別為來源，不另寫平行契約。strict TS、無 `any`。 |
| **IV. 即時通道紀律** | ✅ PASS | 原生 ws 不變；遙測仍走 buffer + rAF 批次；新增的背壓速率序列以 **1 Hz tick** 自既有計數器取差分，走勢線與連線粗細以 computed 消費、每幀至多一次；latch 於 `applyTelemetryBatch` 內的既有狀態轉換點衍生（與事件同一處），不逐筆寫新 reactive。串流 token 不進遙測 buffer（既有分流）。 |
| **V. AI 診斷紀律** | ✅ PASS（不涉） | 不動 worker／provider／cache；前端漸進解析只影響呈現，完成態仍以 `ai/done` 經 schema 驗證的 `DiagnosisResult` 為準，partial result 不當最終結果用。 |
| **VI. 祕密與設定衛生** | ✅ PASS | 無新 secrets；localStorage 只存主題與面板偏好。 |
| **VII. 資料可追溯性** | ✅ PASS（不涉） | 不改任何持久化。 |
| **開發工作流程與品質門檻** | ✅ PASS | 純函式單元測試（FR-042）；可重播驗收：既有 mock producer＋新的截圖劇本；Phase 化 commit；merge 前 analyze 與驗收。本段「可重播驗收」括號內對 design-spec 的指標（「首屏為可操作監控台」依 design-spec）由 T068 同步修訂為依 `apps/web/PRODUCT.md`（見 Complexity Tracking）。 |

**Post-design re-check（Phase 1 後）**：data-model 與 contracts 未引入任何契約欄位；`contracts/ui-contract.md` 只描述 token 名稱、storage key、`data-*` 測試鉤子與快捷鍵表，不涉 WS／HTTP。判定不變。

---

## Project Structure

### Documentation (this feature)

```text
specs/013-ui-redesign/
├── plan.md              # 本檔
├── research.md          # Phase 0：R1–R14 技術決策
├── data-model.md        # Phase 1：前端衍生實體與狀態轉移
├── quickstart.md        # Phase 1：可重播的驗收劇本（含截圖劇本）
├── contracts/
│   └── ui-contract.md   # Phase 1：主題 token 名稱、storage key、data-* 鉤子、快捷鍵表（非通訊契約）
├── checklists/
│   ├── requirements.md  # spec 品質自審
│   └── ux.md            # 視覺與互動需求品質 checklist
└── tasks.md             # Phase 2：由 /speckit-tasks 產出
```

impeccable 工件（同為本 feature 的設計工件，位於 `apps/web/`，隨 feature 一起 commit）：

```text
apps/web/
├── PRODUCT.md                              # 產品事實（已建立；US7 更新為改版後現況，之後為視覺真實來源之一）
├── DESIGN.md                               # 目前是 1.1.0 舊世界紀錄；finish 時由 documenter 重寫為新世界
└── .impeccable/
    ├── surfaces/src-app-vue.md             # direction contract（THESIS／OWN-WORLD／STORY／FIRST VIEWPORT／FORM／FINISH）
    ├── mocks/decision/assigned.html        # 選定草圖（finish review 對照）；其餘草圖與 payload 於 tasks 階段清理
    ├── critique/…                          # 改版前基準 20/40；改版後重跑
    └── design.json                         # sidecar，finish 時重寫
```

### Source Code (repository root)

```text
apps/web/
├── index.html                              # 字型：Source Sans 3 + Noto Sans TC + JetBrains Mono；<html data-theme>
├── tailwind.config.ts                      # 語意 token → CSS 變數（rgb(var(--…) / <alpha-value>)）；新字級／圓角／陰影
├── src/
│   ├── styles/
│   │   ├── tailwind.css                    # 既有（卷軸、選取規則、reduced-motion）→ 改寫
│   │   └── theme.css                       # 新：:root[data-theme="light"|"dark"] 的 token 值（唯一 hex 所在）
│   ├── App.vue                             # 組裝：新 shell、快捷鍵、主題
│   ├── main.ts                             # 啟動前套用保存的主題（避免閃爍）
│   ├── shared/
│   │   ├── components/
│   │   │   ├── AppLayout.vue               # rail／工具列／面板預設收合／手機 bottom-sheet 把手與 peek 條
│   │   │   ├── TopBar.vue                  # 語意分組、搜尋收合、主題切換（手機）
│   │   │   ├── BackpressureStrip.vue       # 新：量筒 strip（取代 BackpressureBadge）
│   │   │   ├── Sparkline.vue               # 新：60 秒兩線走勢（SVG）
│   │   │   ├── Graduation.vue              # 新：蝕刻刻度（SVG，靜態）
│   │   │   ├── ThemeToggle.vue             # 新
│   │   │   ├── ShortcutHelp.vue            # 新：「?」說明層
│   │   │   ├── StatusLight.vue / SeverityBadge.vue / ProgressBar.vue  # 重皮
│   │   │   └── MetricsPanel.vue            # 重皮
│   │   ├── composables/
│   │   │   ├── useTheme.ts                 # 新：主題狀態＋localStorage＋同幀切換
│   │   │   ├── useKeyboardShortcuts.ts     # 新：/、方向鍵、Enter、d、x、Escape、?；只收注入的 callbacks、不 import domains/（layering.test 守門），App.vue 接線
│   │   │   ├── useLocalPreference.ts       # 新：try/catch 包裝的 localStorage 讀寫
│   │   │   └── useResizeDrag.ts            # 補鍵盤操作；改經 useLocalPreference、沿用既有 key 與範圍
│   │   └── lib/
│   │       ├── backpressure.ts             # 既有累計比值（改為 tooltip 用）；不變
│   │       ├── state-style.ts              # 語意 token 對照（含 stale 統一）
│   │       ├── format.ts                   # 新：全站時間／相對時間／耗時格式的單一來源（FR-022）
│   │       ├── shortcuts.ts                # 新：SHORTCUTS 常數＋isTypingTarget（說明層與 composable 同源）
│   │       └── focus-grid.ts               # 新：方向鍵依視覺位置移焦的純函式
│   ├── domains/monitoring/
│   │   ├── components/
│   │   │   ├── StageTopology.vue           # 新：三欄 stage + SVG 連線（取代 TopologyCanvas）
│   │   │   ├── StageColumn.vue             # 新
│   │   │   ├── FlowLink.vue                # 新：粗細＋流動（reduced-motion 退回）
│   │   │   ├── MachineNodeCard.vue         # 重做：刻度、latch 標記、診斷狀態 chip
│   │   │   ├── FleetHealth.vue             # 重皮；手機「機群健康摘要條」compact 模式
│   │   │   ├── AnomalySummary.vue          # 新：異常摘要列（側欄與手機覆蓋層共用；可點、可清除）
│   │   │   └── EventStrip.vue              # 可點擊、合併計數、蝕刻短線、24h 時間
│   │   ├── lib/
│   │   │   ├── anomaly-latch.ts            # 新：latch 狀態機（30s、重置、清除）
│   │   │   ├── events.ts                   # 加合併（10s 視窗、次數）與中文訊息
│   │   │   ├── flow-link.ts                # 新：throughput → 粗細／流速等級
│   │   │   ├── rate-series.ts              # 新：1 Hz 差分環狀緩衝＋60 秒視窗比值
│   │   │   ├── stage-layout.ts             # 新：assignToStages（空欄保留、未分組歸最後一欄）
│   │   │   ├── machine-groups.ts           # 既有分組單一來源；加 stage 中文名
│   │   │   └── machine-labels.ts           # 中文機台名稱
│   │   └── stores/monitoring.store.ts      # latch、速率 tick、事件合併接線
│   └── domains/ai-copilot/
│       ├── components/
│       │   ├── CopilotDrawer.vue           # 重做：收合預設、骨架、完成 meta、嚴重度色條
│       │   ├── DiagnosisResultView.vue     # 順序、證據收合合併
│       │   ├── StreamingPanel.vue          # 改為可展開的「原始串流」
│       │   ├── SuggestedActionList.vue     # 重皮與文案
│       │   └── ResultSkeleton.vue          # 新：漸進填入骨架
│       ├── lib/
│       │   ├── partial-json.ts             # 新：容錯漸進解析（純函式）
│       │   ├── diagnosis-timing.ts         # 新：耗時量測與對比
│       │   ├── evidence-merge.ts           # 新：source＋正規化 excerpt 合併、×N
│       │   └── copilot-reducer.ts          # 不改
│       └── stores/copilot.store.ts         # 面板偏好、timings Map（耗時不進 reducer）
├── scripts/
│   └── screenshots.cjs                     # 新：Setup 建雛形（--viewports：五 viewport × 兩主題），US7 完成 --readme 14 張（playwright-core）
└── design/
    └── design-spec.md                      # 頂端標示退役；refs/*.png 移除
```

**Structure Decision**：維持既有 `apps/web` 的 domain 分層（`shared/`、`domains/monitoring`、`domains/ai-copilot`），新元件與純函式放進對應層；主題 token 的 hex 唯一存在 `src/styles/theme.css`，Tailwind 設定只引用變數。`TopologyCanvas.vue` 與 `BackpressureBadge.vue` 由新元件取代後刪除（兩者皆無既有測試檔，替代元件的測試為新增）。`shared/composables` 與 `shared/lib` 不得 import `domains/`（既有 `shared/layering.test.ts`），需要 store 的行為一律以 callback 注入。

---

## Phase 0：Research（已完成，見 research.md）

R1 主題機制 · R2 磨砂玻璃落地 · R3 字型與 CJK · R4 背壓速率序列與走勢線 · R5 stage 拓樸與連線 · R6 串流漸進解析 · R7 診斷耗時量測 · R8 異常 latch 與事件合併 · R9 鍵盤操作 · R10 響應式策略 · R11 截圖劇本與工具 · R12 impeccable 在 implement 的用法 · R13 繁中術語表 · R14 真實來源切換的回補順序

## Phase 1：Design（已完成）

- [data-model.md](./data-model.md)：12 節前端衍生實體與狀態轉移（含 EvidenceGroup）。
- [contracts/ui-contract.md](./contracts/ui-contract.md)：語意 token 名稱表、storage key、`data-*` 測試鉤子、快捷鍵表、繁中術語表。
- [quickstart.md](./quickstart.md)：16 個驗收場景（含截圖劇本、critique 重跑、SC-008 三機制同輪可見）。

## Phase 2 預告（由 `/speckit-tasks` 產出）

建議 phase 切法（供 tasks 參考）：Setup（字型、theme.css、token 重構、useTheme、截圖劇本雛形）→ Foundational（純函式 lib：rate-series、anomaly-latch、partial-json、evidence-merge、flow-link、focus-grid、shortcuts、stage-layout、events 合併，各帶測試）→ US1 視覺世界與雙主題 → US2 背壓 strip → US3 stage 拓樸 → US4 串流與結果 → US5 記憶 → US6 響應式 → US8 鍵盤 → US7 文件回補與截圖（此為 plan 階段建議；實際 phase 順序以 tasks.md 為準：US8 鍵盤排在 US6 響應式之前） → Finish（impeccable finish-reviewer、documenter 重寫 DESIGN.md、critique 重跑、detect）。

---

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 憲章 II「視覺」條目指向的真實來源將被本 feature 取代（含憲章「開發工作流程與品質門檻」段「可重播驗收」括號內的 design-spec 指標；兩處皆由 T068 修訂） | 全面改版後 design-spec.md 與 refs 已不描述任何現況；impeccable 的 PRODUCT.md + DESIGN.md 是改版後唯一能從實作衍生、可被偵測器驗證的視覺紀錄 | 「同時維護 design-spec 與 DESIGN.md」會製造兩份真實來源，正是憲章 II 要避免的分歧；故以 `/speckit-constitution` 修訂條目，而非並存 |
| 新增 devDependency `playwright-core`（推翻 `MachineNodeCard.css.test.ts` 註解記載的「以 CSS cascade 測試取代 Playwright 截圖、不新增瀏覽器相依」取捨；回補於指南 §15.6 並更新該註解） | SC-012 要求 14 張 README 截圖由可重播劇本產出；critique、finish review 與 SC-004 的 bounding rect 量測也需要瀏覽器 | 手動截圖不可重播；`tests/e2e` 的 harness 不含瀏覽器自動化；用系統 Chrome 的 `--screenshot` 無法操作互動狀態 |
