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
| `--c-accent` / `--c-accent-strong` / `--c-accent-wash` | `bg-accent`… | 深青：主要動作、選取、液位線 |
| `--c-ok` / `--c-ok-fg` / `--c-ok-bg` | `bg-ok`、`text-ok-fg`、`bg-ok-bg` | 正常三件套 |
| `--c-warn` / `--c-warn-fg` / `--c-warn-bg` | 同上 | 警告 |
| `--c-crit` / `--c-crit-fg` / `--c-crit-bg` | 同上 | 嚴重 |
| `--c-stale` | `bg-stale` | 停滯（卡片與聚合面板統一） |
| `--c-focus` | `ring-focus` | 鍵盤焦點環 |

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
| `[data-fg="flow-link"][data-speed="none\|slow\|mid\|fast"]` | 連線 |
| `.machine-card[data-machine="<id>"][data-selected][data-state][data-latch][data-latch-cleared][data-diagnosis]` | 卡片（`data-latch` = `warning\|critical\|none`；`data-latch-cleared` 於操作者確認、劃線期間存在；`data-diagnosis` = `none\|active\|completed\|failed`） |
| `[data-fg="latch-clear"]` | 卡片上的清除按鈕 |
| `[data-fg="anomaly-summary"] [data-machine]` | 異常摘要列（側欄與手機覆蓋層共用） |
| `[data-fg="fleet-summary-bar"]` | 手機機群健康摘要條 |
| `[data-fg="copilot"][data-open]` | Copilot 面板 |
| `[data-fg="result-skeleton"] [data-field][data-field-state]` | 漸進骨架 |
| `[data-fg="timing"][data-cached]` | 完成 meta／快取耗時 |
| `[data-fg="event"][data-machine][data-severity][data-count]` | 事件列項 |
| `[data-fg="theme-toggle"]` | 主題切換 |
| `[data-fg="shortcut-help"]` | 說明層 |

## 4. 快捷鍵表

見 data-model §11；說明層由同一份 `SHORTCUTS` 常數（`apps/web/src/shared/lib/shortcuts.ts`）渲染，避免兩份清單漂移。

## 5. 繁中術語

以 research R13 的術語表為準；`machine-labels.ts` 是機台中文名稱的唯一來源，stage 中文名在 `machine-groups.ts`（不附英文副標）。
