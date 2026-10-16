# UI Contract（013）：token 名稱、storage key、測試鉤子、快捷鍵

> 這不是通訊契約（`packages/contracts` 與 `asyncapi.yaml` 零變更）。本檔定義前端內部的穩定介面，供元件、測試、截圖劇本與後續 feature 依賴。hex 數值**不在本檔**，只在 `apps/web/src/styles/theme.css`。

## 1. 語意 token（CSS 變數名 ↔ Tailwind class）

| 變數 | Tailwind | 用途 |
|---|---|---|
| `--c-bench` | `bg-bench` | 實驗桌面（主區底） |
| `--c-bench-grid` | `bg-bench-grid`（格線色） | 桌面格線 |
| `--c-rim` | `bg-rim` | 桌面邊：rail、工具列、面板標頭 |
| `--c-surface` | `bg-surface/[alpha]` | 磨砂玻璃面板（light 72%、dark 依 R1） |
| `--c-surface-strong` | `bg-surface-strong` | 不透明面板（覆蓋層、說明層） |
| `--c-edge` | `border-edge` | 玻璃邊 |
| `--c-highlight` | （inset shadow 用） | 內側上緣高光 |
| `--c-ink` / `--c-ink-2` / `--c-ink-3` | `text-ink` / `text-ink-2` / `text-ink-3` | 三階文字（ink-3 仍 ≥ 4.5:1） |
| `--c-etch` | `stroke-etch` / `text-etch` | 蝕刻刻度與短線 |
| `--c-accent` / `--c-accent-strong` / `--c-accent-wash` | `bg-accent`… | 深青：主要動作、選取、液位線。**當文字用時**：放在玻璃面或 accent-wash 上可用 `text-accent`；放在 bench 或 rim 上 MUST 用 `text-accent-strong`（light 下 `accent` 對 bench 僅 4.47:1、對 rim 3.75:1，Phase 1 審查實測） |
| `--c-ok` / `--c-ok-fg` / `--c-ok-bg` | `bg-ok`、`text-ok-fg`、`bg-ok-bg` | 正常三件套 |
| `--c-warn` / `--c-warn-fg` / `--c-warn-bg` | 同上 | 警告 |
| `--c-crit` / `--c-crit-fg` / `--c-crit-bg` | 同上 | 嚴重 |
| `--c-stale` | `bg-stale` | 停滯（卡片與聚合面板統一） |
| `--c-focus` | `ring-focus` | 鍵盤焦點環 |
| `--c-scrim` | `bg-scrim/50` | bottom-sheet 後方遮罩；兩套主題皆為深色（Phase 3 新增：`ink` 在 dark 下是淺色，不能當遮罩） |

圓角：`rounded-control`（4px）、`rounded-card`（6px）、`rounded-pill`（999px，僅 badge／pill 用，屬 spec FR-006 與 direction contract「圓角 ≤ 6px」的明文例外）。陰影只有 `shadow-glass`（inset 高光）與 `shadow-sheet`（手機 bottom-sheet）。字級：`text-2xs` 退役，最小功能性字級 `text-xs`（12px，FR-005）；新增 `text-ratio`（32px）給背壓比值與快取耗時。

主題切換根屬性：`<html data-theme="light|dark">`；切換瞬間 `<html data-theme-switching>`。

## 2. localStorage key

| key | 值 | 預設 | 來源 |
|---|---|---|---|
| `fg.theme` | `"light" \| "dark"` | `light` | 013 新增 |
| `fg.copilot-panel` | `{"manuallyCollapsed":boolean}` | `{"manuallyCollapsed":false}` | 013 新增；`true` 時選台不自動展開，觸發診斷或點展開把手才展開並寫回 `false`；跨重新載入保留（data-model §2） |
| `flow-gatekeeper:sidebar-width` | 數字字串（px，200–420） | `240` | 既有，沿用不改名 |
| `flow-gatekeeper:event-strip-height` | 數字字串（px，100–360） | `150` | 既有，沿用不改名 |

讀寫一律 try/catch（經 `useLocalPreference`）；不可用時以預設運作。

## 3. `data-*` 測試與截圖鉤子

| 選擇器 | 元素 |
|---|---|
| `[data-fg="backpressure"]` | 背壓 strip 根；`[data-fg="ratio"]` 比值數字（60 秒視窗比值） |
| `[data-fg="stage"][data-stage="prep\|forming\|fulfilment"]` | stage 欄 |
| `[data-fg="flow-link"][data-speed="none\|slow\|mid\|fast"][data-orientation="horizontal\|vertical"]` | 連線 |
| `[data-fg="stage-topology"][data-layout="row\|stacked"]` | 拓樸根；並排或堆疊由容器寬度決定（< 708px 堆疊，Phase 5 實作裁決：1024×768 面板展開時主區僅約 400px，用斷點會橫向捲動） |
| `[data-fg="metric-tick"]` | 卡片數值旁的 3 格小刻度（`stroke-etch`／`stroke-warn`／`stroke-crit`，依該指標自身越界等級） |
| `.machine-card[data-machine="<id>"][data-selected][data-state][data-latch][data-latch-cleared][data-diagnosis]` | 卡片（`data-latch` = `warning\|critical\|none`；`data-latch-cleared` 於操作者確認、劃線期間存在；`data-diagnosis` = `none\|active\|completed\|failed`） |
| `[data-fg="latch-clear"]` | 卡片上的清除按鈕 |
| `[data-fg="anomaly-summary"] [data-machine]` | 異常摘要列（側欄與手機覆蓋層共用）；列內選取鈕 `[data-fg="anomaly-select"]`、清除鈕 `[data-fg="anomaly-clear"]`（與卡片的 `latch-clear` 區分，避免 E2E 同時命中兩顆；Phase 7 裁決）；列屬性 `data-level="warning\|critical"`、`data-active`／`data-struck`（有屬性才算，與卡片 `data-latch-cleared` 同寫法） |
| `[data-fg="fleet-summary-bar"][aria-expanded]` | 手機機群健康摘要條（`<button>` 固定 44px，`aria-controls` 只在展開時指向覆蓋層面板 id，預設 `anomaly-overlay-panel`） |
| `[data-fg="anomaly-overlay"]`、`[data-fg="anomaly-overlay-scrim"]` | 手機異常清單覆蓋層（`role="dialog"`，`fixed top-14 z-[60]`，面板自摘要條下緣起；內含 `[data-fg="anomaly-summary"]`）與其遮罩（點擊收合） |
| `[data-fg="copilot"][data-open]` | Copilot 面板 |
| `[data-fg="copilot-peek"]` | 手機 bottom-sheet 收合（收合鈕或 Escape）且仍有選取機台時的 32px peek 條（點擊展開；無選取時不渲染） |
| `[data-fg="result-skeleton"] [data-field][data-field-state]` | 漸進骨架 |
| `[data-fg="timing"][data-cached]` | 完成 meta／快取耗時 |
| `[data-section]`、`[data-severity]`、`[data-evidence][data-evidence-count]` | 結果檢視內部的測試屬性（區段、色條嚴重度、合併後證據列；Phase 6 新增，僅供測試） |
| `[data-fg="event"][data-machine][data-severity][data-count]` | 事件列項 |
| `[data-fg="theme-toggle"]` | 主題切換（rail 底部為兩段式「淺色｜深色」；< 768px 視窗時由 TopBar 系統狀態分組承載、依視窗斷點而非工具列段位，compact 段改為**單一圖示鈕**（aria-label「切換為深色／淺色主題」）以免 390 寬「重新連線中＋未授權」時溢出，Phase 9 裁決） |
| `.tb-bar[data-tb-size="full\|icons\|compact"]` | 工具列三段（ResizeObserver：≥ 820 full、640–819 icons、< 640 compact） |
| `[data-fg="search-toggle"][aria-expanded]`、`[data-fg="search-overlay"]` | compact 時的搜尋圖示鈕與覆蓋式搜尋（`bg-rim` 橫條蓋住工具列；Escape／失焦／收回鈕／Enter 唯一結果收回） |
| `[data-fg="shortcut-help"]` | 說明層；每列 `[data-shortcut="<ShortcutId>"]`（Phase 8 新增測試鉤子） |

## 4. 快捷鍵表

見 data-model §11；說明層由同一份 `SHORTCUTS` 常數（`apps/web/src/shared/lib/shortcuts.ts`）渲染，避免兩份清單漂移。

## 5. 繁中術語

以 research R13 的術語表為準；`machine-labels.ts` 是機台中文名稱的唯一來源，stage 中文名在 `machine-groups.ts`（不附英文副標）。
