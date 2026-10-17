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

圓角：`rounded-control`（4px）、`rounded-card`（6px）、`rounded-pill`（999px，僅 badge／pill 用，屬 spec FR-006 與 direction contract「圓角 ≤ 6px」的明文例外）。陰影只有三個：`shadow-glass`（inset 高光）、`shadow-sheet`（bottom-sheet 與 peek 條，由下而上 `0 -8px 24px ink/0.18`）與 `shadow-panel`（由上而下展開的覆蓋層——快捷鍵說明層、手機異常覆蓋層——`0 8px 24px ink/0.18`，與 sheet 同強度、方向相反；2026-10-17 新增）。字級：`text-2xs` 退役，最小功能性字級 `text-xs`（12px，FR-005）；新增 `text-ratio`（32px）給背壓比值與快取耗時。

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
| `[data-fg="backpressure"]` | 背壓 strip 根；`[data-fg="ratio"]` 比值數字（60 秒視窗比值）；`[data-fg="ratio-plain"]` ≥ md 常駐白話行「每幀合併約 N 則 · 近 60 秒最高 X」（走勢區最左、12px ink-3，不增加 strip 高度，空間不足截斷、全文在 `title`；手機不顯示）；刻度 1:1 處的蝕刻錨點 `.grad-unity`／`.grad-unity-label`「1:1」（桌機與 compact 刻度皆有）；丟棄數一律「丟棄 N 則」（T073 第四輪） |
| `[data-fg="bp-paused"]` | 背壓 strip 狀態列的「已暫停」pill（手機不顯示；與斷線 pill 同現時只顯示斷線）（T073 第三輪）。斷線 pill 與 TopBar 連線 chip 同字：「已斷線」，`connection` prop 為 `reconnecting` 時「重新連線中」（T073 第四輪由「連線中斷」改） |
| `[data-fg="pause-toggle"][aria-pressed]` | 工具列暫停鈕：文字與可讀名稱固定「暫停」，按下態 `aria-pressed="true"`＋`bg-ink text-surface-strong`；`screenshots.cjs` 若要暫停請用此選擇器（T073 第三輪） |
| `[data-fg="pause-banner"]`、`[data-fg="banner-resume"]` | 暫停橫幅「已暫停畫面更新 · 暫停於 HH:mm:ss」與內嵌「恢復」鈕（連線／授權橫幅優先；按恢復後焦點回 `pause-toggle`）（T073 第三輪） |
| `[data-fg="stage"][data-stage="prep\|forming\|fulfilment"]` | stage 欄 |
| `[data-fg="flow-link"][data-speed="none\|slow\|mid\|fast"][data-orientation="horizontal\|vertical"]` | 連線 |
| `[data-fg="stage-topology"][data-layout="row\|stacked"]` | 拓樸根；並排或堆疊由容器寬度決定（< 708px 堆疊，Phase 5 實作裁決：當時 1024×768 面板展開時主區僅約 400px，用斷點會橫向捲動；T073 起 < 1366px 面板改為 bottom-sheet、不推擠主區，1024×768 開面板維持三欄） |
| `[data-fg="metric-tick"]` | 卡片數值旁的 3 格小刻度（`stroke-etch`／`stroke-warn`／`stroke-crit`，依該指標自身越界等級）；嚴重越界時改畫三條 3px 全寬實心短柱（`fill-crit`，「全填實」），形狀與平時細線不同、色弱也分得出（T073 第三輪），盒子仍 10×14px |
| `.machine-card[data-machine="<id>"][data-selected][data-state][data-latch][data-latch-cleared][data-diagnosis]` | 卡片（`data-latch` = `warning\|critical\|none`；`data-latch-cleared` 於操作者確認、劃線期間存在；`data-diagnosis` = `none\|active\|completed\|failed`）。選取外觀（T073 第四輪）：外側 2px accent outline（offset 0），**保留狀態自己的邊框與底色**（crit 卡選取後仍 `border-crit` + crit-bg 靜止底、脈動停；warn 卡仍 `border-warn`），只有 healthy／placeholder 另鋪 accent-wash 底；鍵盤焦點環為 2px focus outline（offset 2px），選取＋聚焦時改為 6px focus 色雙線（offset 0）。id 列的診斷 chip 為方角 4px tag、只有文字不帶圖示，可見文字「AI：嚴重」「AI：嚴重 · 快取」「診斷中 60%」「AI 失敗」（可讀名稱前綴「診斷：」） |
| `[data-fg="latch-mark"]` | 卡片底列的異常標記 pill（非互動 `span`，所在底列 `pointer-events-none`，點擊落到卡片＝選台）。T073 第三輪前是可點的清除鈕 `[data-fg="latch-clear"]`，因落在選台範圍內易誤觸不可逆確認而移除；確認只走摘要列確認鈕、鍵盤 `x` 與手機覆蓋層。文案（T073 第四輪，與摘要列同一函式 `latchText`）：仍異常「嚴重 · 進入 N 秒前」（現在式）、已回復一律以「曾」起頭「曾嚴重 · N 秒前回復」（原「嚴重 · 已回復 N 秒前」） |
| `[data-fg="anomaly-summary"] [data-machine]` | 異常摘要列（側欄與手機覆蓋層共用）；列內選取鈕 `[data-fg="anomaly-select"]`、確認鈕 `[data-fg="anomaly-clear"]`（lucide `Check` 圖示、aria-label「確認 <中文名> 的異常標記」、title「確認此異常（劃線保留至回復後 30 秒）」；T073 第三輪由「清除」X 改為「確認」語意，選擇器名沿用不改。Phase 7 裁決時與卡片的 `latch-clear` 區分，避免 E2E 同時命中兩顆；卡片上已無可點的確認入口）；列屬性 `data-level="warning\|critical"`、`data-active`／`data-struck`（有屬性才算，與卡片 `data-latch-cleared` 同寫法） |
| `[data-fg="fleet-summary-bar"][aria-expanded]` | 手機機群健康摘要條（`<button>` 固定 44px，`aria-controls` 只在展開時指向覆蓋層面板 id，預設 `anomaly-overlay-panel`） |
| `[data-fg="anomaly-overlay"]`、`[data-fg="anomaly-overlay-scrim"]` | 手機異常清單覆蓋層（`role="dialog"`，`fixed top-14 z-[60]`，面板自摘要條下緣起；內含 `[data-fg="anomaly-summary"]`）與其遮罩（點擊收合） |
| `[data-fg="copilot"][data-open]` | Copilot 面板（≥ 1366px 為主區右側推擠式 348px 側欄（T077 由 360 縮為 348：1366 寬含 10px 傳統捲軸時拓樸內容寬 710 ≥ 三欄門檻 708）；< 1366px 為 bottom-sheet，掛 `role="dialog"`＋焦點陷阱——T073 由 `lg`／1024 提到自訂 screen `desk`／1366（第一版 `xl`／1280 經交叉審查算出 1280–1365 推擠後拓樸仍單欄，使用者裁決改 1366），斷點與 `useModalSheet` 的 `MOBILE_QUERY` 一致）。T073 critique 第三輪：sheet 一律 `role="dialog"`，但只有接手焦點時才 `aria-modal="true"`＋焦點陷阱（進行中／完成／失敗、未選機台的空狀態，或使用者自己 Tab／點進外框；閒置選台時即使焦點落在 body——觸控 Safari 點卡片不給焦點——也不接手）；選台後的閒置態不搶焦點（`aria-modal="false"`，焦點留在卡片、方向鍵續行、`d` 開始診斷後才接手、Escape 由 App 層面板層收合），並以 polite live region 告知；閒置態只一列「機台名 · 狀態徽章（含停滯）」＋「診斷」（不重複卡片遙測），內容與標頭內層 `max-w-xl` 置中；T073 critique 第四輪：sheet 形態的閒置選台把標頭與內容合併成單列（`h-8`，含抓取把手約 51px）——`text-xs text-ink-3` 的「AI 診斷」前綴＋機台中文名（標題 `h2`，機台 id 為視覺隱藏文字、併入 dialog 名稱）、狀態徽章（含停滯）、行內「診斷」（文字精確為「診斷」）、收合鈕，省略「未診斷」chip；進行中／完成／失敗、未選機台的空狀態與 ≥ 1366px 推擠式側欄維持原標頭與內容。AppLayout 以 ResizeObserver 量 `[data-fg="copilot"]` 外框高度，主區與 rail 以 `--fg-bottom-reserve` 留出等量 `padding-bottom`（peek 條 32px；只有閒置單列——App 同步傳入 `sheetCompact`＝已選台且該台診斷為 idle——且未接手焦點時才採用量到的 sheet 高度，其餘展開情形（進行中／完成／失敗、空狀態、一打開就是 modal）保留前值，不隨串流長高；desk+ 恆 0），事件流不被閒置 sheet 蓋住；sheet 出現／換台／方向鍵移焦時以 scroll-margin-bottom 等價手段把卡片捲到 sheet 上緣之上。`CopilotDrawer` 以 `update:engaged`（boolean，值變化時發一次；接手焦點＝`aria-modal="true"` 時 true，閒置非 modal 與 ≥ 1366px 推擠式恆 false）對外，App／AppLayout 只在 engaged 時渲染遮罩，非 modal 時點其他卡片即改選。合併門第 2 輪：modal sheet 回到「已選台、閒置」（按「中止診斷」、搜尋 Enter 改選閒置機台）時退回非 modal——`aria-modal="false"`、`update:engaged` 發 false、遮罩消失；焦點仍在 sheet 內或已遺失時移到閒置單列的「診斷」鈕（停用時落在 sheet 根節點），焦點已在外面（卡片）則不動；之後在 sheet 內移動焦點不再接手，從外面 Tab／點進來才接手。sheet 為 modal 時 App 層快捷鍵不處理 `/`（不把焦點搬出 sheet，比照說明層） |
| `[data-fg="copilot-peek"]` | < 1366px bottom-sheet 收合（收合鈕或 Escape）且仍有選取機台時的 32px peek 條（點擊展開；無選取時不渲染；主區與 rail 底部留出等高 32px） |
| `[data-fg="result-skeleton"] [data-field][data-field-state]` | 漸進骨架 |
| `[data-fg="timing"][data-cached]` | 完成 meta／快取耗時 |
| `[data-fg="timing-bars"] [data-bar="cached\|previous"]` | 快取態的耗時對比橫條（同刻度兩條：快取 `bg-accent`、上一次 `bg-ink-3`，1px `etch` 底線；只有一筆紀錄時不渲染橫條）（T073 新增） |
| `[data-section]`、`[data-severity]`、`[data-evidence][data-evidence-count]` | 結果檢視內部的測試屬性（區段、色條嚴重度、合併後證據列；Phase 6 新增，僅供測試） |
| `[data-fg="event"][data-machine][data-severity][data-count]` | 事件列項；選取機台的每一列有選取底色與內框，但只有該台最新一列（頂端第一筆）標 `aria-current="true"`，其餘選取列附視覺隱藏文字「（選取中）」（合併門第 2 輪） |
| `[data-fg="event-time"][title]` | 事件列時間欄：單筆一個時間；合併列（同機台同嚴重度、以 `firstTs` 起算的 60 秒固定窗）顯示起訖「HH:mm:ss–HH:mm:ss」，< 640px 視窗起點與分隔符只留給螢幕閱讀器，`title` 恆為全文（T073 新增） |
| `[data-fg="theme-toggle"]` | 主題切換（rail 底部為兩段式「淺色｜深色」；< 768px 視窗時由 TopBar 系統狀態分組承載、依視窗斷點而非工具列段位，compact 段改為**單一圖示鈕**（aria-label「切換為深色／淺色主題」）以免 390 寬「重新連線中＋未授權」時溢出，Phase 9 裁決） |
| `.tb-bar[data-tb-size="full\|icons\|compact"]` | 工具列三段（ResizeObserver：≥ 820 full、640–819 icons、< 640 compact） |
| `[data-fg="search-toggle"][aria-expanded]`、`[data-fg="search-overlay"]` | compact 時的搜尋圖示鈕與覆蓋式搜尋（`bg-rim` 橫條蓋住工具列；Escape／失焦／收回鈕／Enter 唯一結果收回） |
| `[data-fg="shortcut-help"]` | 說明層；每列 `[data-shortcut="<ShortcutId>"]`（Phase 8 新增測試鉤子） |
| `[data-fg="shortcut-help-toggle"][aria-expanded]` | TopBar 系統狀態分組的快捷鍵說明圖示鈕（aria-label「快捷鍵說明」、title「快捷鍵說明（?）」）；與 `?` 共用 App 的同一個開關。≥ 768px 恆常駐；< 768px 的 compact 工具列在未授權 chip 出現時讓位（390 寬放不下，`?` 仍可用）（T073 新增） |

## 4. 快捷鍵表

見 data-model §11；說明層由同一份 `SHORTCUTS` 常數（`apps/web/src/shared/lib/shortcuts.ts`）渲染，避免兩份清單漂移。

## 5. 繁中術語

以 research R13 的術語表為準；`machine-labels.ts` 是機台中文名稱的唯一來源，stage 中文名在 `machine-groups.ts`（不附英文副標）。
