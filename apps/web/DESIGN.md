---
name: flow-gatekeeper
description: 致敬 Argo CD 的深色即時監控台與串流式 AI 診斷面板——低飽和、工程感、狀態優先的 operational dashboard
colors:
  canvas: "#0B1014"
  surface: "#111820"
  surface-hover: "#141D27"
  surface-inset: "#0E151B"
  elevated: "#17212B"
  border-subtle: "#26323D"
  border-strong: "#3E5266"
  text-primary: "#E7EDF2"
  text-secondary: "#9AA8B5"
  text-muted: "#7C8A98"
  accent: "#4FA3FF"
  accent-hover: "#76B8FF"
  accent-bg: "#102A42"
  accent-bg-strong: "#143A5C"
  accent-wash: "#0F1B28"
  ok: "#37C978"
  ok-fg: "#9DF0BF"
  ok-border: "#1E5C38"
  ok-bg: "#123522"
  warn: "#F2B84B"
  warn-fg: "#F2CF85"
  warn-border: "#6B5220"
  warn-bg: "#3A2B12"
  crit: "#FF5C66"
  crit-fg: "#FF9AA0"
  crit-border: "#7A2A30"
  crit-bg: "#3B151A"
typography:
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0.025em"
  micro:
    fontFamily: "Inter, ui-sans-serif, system-ui"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: "14px"
    letterSpacing: "0.025em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  number:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: "28px"
rounded:
  control: "6px"
  card: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.canvas}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
  input-search:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px 0 32px"
    height: "36px"
  chip-status:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  badge-state-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok-fg}"
    typography: "{typography.micro}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
  badge-state-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn-fg}"
    typography: "{typography.micro}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
  badge-state-crit:
    backgroundColor: "{colors.crit-bg}"
    textColor: "{colors.crit-fg}"
    typography: "{typography.micro}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
  card-machine:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "12px"
  card-machine-hover:
    backgroundColor: "{colors.surface-hover}"
    rounded: "{rounded.card}"
  card-machine-selected:
    backgroundColor: "{colors.accent-wash}"
    rounded: "{rounded.card}"
  card-machine-critical:
    backgroundColor: "{colors.crit-bg}"
    rounded: "{rounded.card}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
  nav-item-active:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
---

# Design System: flow-gatekeeper

> **現況紀錄（incumbent，2026-10-15 以 `/impeccable document` 掃描程式碼產出）。** 這份是 1.1.0 既有視覺世界的忠實紀錄，供 feature 013「UI 全面改版」當作**證據與反面參考**；013 選定新視覺世界後本檔會被整份取代。token 來源：`apps/web/tailwind.config.ts`（它本身對齊舊規格 `apps/web/design/design-spec.md` v0.6 §4／§5）、`src/styles/tailwind.css`、各 `.vue` 元件。
> 標 **[推定]** 的是質性描述（North Star、氛圍用語、色彩命名），由程式碼與 design-spec §3 推得、未經使用者確認；token 數值全部是實際使用中的值。

## Overview

**Creative North Star: "The Night-Shift Control Room"** [推定]

這是一間給值夜班操作員長時間盯著的控制室：整個畫面壓在近黑的藍灰底上，面板之間只用一階一階更亮的藍灰色和一條 1px 的細邊區隔，沒有陰影堆疊、沒有裝飾。唯一會「說話」的是狀態色——綠、琥珀、紅各自只佔卡片的一角徽章與一顆狀態燈，critical 時才讓整張卡片染上暗紅底並緩慢脈動。藍色 accent 保留給「可以按」與「被選中」兩件事。

資訊密度中高：中央是自適應的機台卡片網格，每張卡片用 22px 的等寬數字承載四個遙測值，metadata 全部退到 10 到 12px 的灰階小字。等寬字體不只用在數字，也用在 machine id、job id、時間戳與 AI 串流文字，形成「凡是機器產生的東西都是 mono」的規律。動效只有三種循環動畫（critical 脈動、串流游標、indeterminate 進度條）和 150ms 的 hover 上移，全部在 `prefers-reduced-motion` 下關閉。

明確拒絕的東西（來自舊規格 §1，已確認）：landing page 式首屏、大面積紫色漸層、裝飾光球與 bokeh、超過 8px 的卡片圓角、Argo CD 官方品牌資產。

**Key Characteristics:**
- 深色藍灰五階面：canvas → surface-inset → surface → surface-hover → elevated，以明度而非陰影分層
- 狀態三色各自成一組四件套（實色／前景文字／邊框／暗底），所有面板共用同一張對照表
- 單一 accent 藍，只用於 primary action、選取態、串流游標與背壓比值
- Inter 做 UI、JetBrains Mono 做一切機器產生的值
- 圓角三檔：6px 控制項、8px 卡片、全圓 pill；陰影只有兩種且極淡

## Colors

低飽和的冷藍灰底配三個略帶霓虹感的狀態色；accent 是整個畫面唯一的飽和藍。

### Primary
- **Signal Blue**（#4FA3FF）[推定命名]：primary action（Diagnose、Run diagnosis）的底色、機台卡片與側欄項目的選取態、串流游標、背壓比值數字、focus ring。它是「系統在等你操作」與「你剛選了這個」的唯一訊號色。
- **Signal Blue Hover**（#76B8FF）：primary button hover。
- **Blue Ink**（#102A42）：選取的側欄項目底色、Cached badge 底色、Active 狀態 chip 底色。
- **Blue Ink Strong**（#143A5C）：Cached badge 邊框、active 控制項的強調面。
- **Blue Wash**（#0F1B28）：被選取機台卡片的整面底色，比 surface 只亮一點點、帶一絲藍。

### Neutral
- **Abyss Canvas**（#0B1014）：app 最底層背景，也是 primary button 上的文字色（深字配亮藍底）。
- **Inset Well**（#0E151B）：內凹面——拓樸畫布底、搜尋框、串流面板、進度條軌道。
- **Panel**（#111820）：側欄、頂欄、卡片、drawer 內的子卡片。
- **Panel Hover**（#141D27）：卡片與按鈕 hover 時抬起的底色。
- **Elevated**（#17212B）：drawer 主體、狀態 chip、背壓徽章等浮在面板上的東西。
- **Hairline**（#26323D）：所有分隔線與卡片邊框；也是卷軸 thumb。
- **Hairline Strong**（#3E5266）：hover 邊框、placeholder 與 stale 的中性圓點、待辦步驟圓點。
- **Text Primary**（#E7EDF2）、**Text Secondary**（#9AA8B5）、**Text Muted**（#7C8A98）：三階文字；muted 已提亮到對所有面 ≥ 4.6:1 以撐住 10–12px 小字。

### Status（三組四件套）
- **OK**：實色 #37C978（狀態燈、比例條、已完成步驟點）、前景 #9DF0BF、邊框 #1E5C38、暗底 #123522。
- **Warning**：實色 #F2B84B、前景 #F2CF85、邊框 #6B5220、暗底 #3A2B12。warning 卡片**不換邊框**，只在內側加一圈 warn-bg 的 1px inset ring，越界數值染 warn 實色。
- **Critical**：實色 #FF5C66、前景 #FF9AA0、邊框 #7A2A30、暗底 #3B151A。critical 卡片整面換 crit-bg、邊框換 crit-border、加 1.2s 脈動。

### Named Rules
**The One Blue Rule.** accent 藍只出現在四個地方：primary action、選取態、串流游標、背壓比值。任何裝飾性的藍都是錯的。
**The Four-Piece Rule.** 每個狀態色都是「實色／fg／border／bg」四件套，徽章永遠是 `bg-*-bg + text-*-fg`，實色只給圓點與比例條，絕不把實色當文字色用在暗底上。
**The Tint-Not-Shout Rule.** critical 用暗紅底加慢脈動表達緊急，不用亮紅大面積、不閃爍；warning 連邊框都不換。

## Typography

**UI Font:** Inter（fallback ui-sans-serif, system-ui），只載 400／500／600。
**Mono Font:** JetBrains Mono（fallback ui-monospace, monospace），只載 400／500。
兩者由 Google Fonts 以 `display=swap` 載入，失敗退回系統字型。

**Character:** 中性、緊湊、不帶個性的工具字。Inter 負責所有人寫的字（標題、按鈕、說明），JetBrains Mono 負責所有機器產生的值。沒有 display 級標題——整個 app 最大的字是 22px 的遙測數字，不是任何標題。

### Hierarchy
- **Title**（600, 16px/24px）：面板標題，實際只用在 drawer 的「AI Copilot」與側欄的「flow-gatekeeper」（兩處都是 14px 的 semibold）；`text-md` 定義了但幾乎未用。
- **Body**（400, 14px/20px）：按鈕文字、卡片機台名稱（500）、side nav 項目、結果 summary。
- **Label**（500, 12px/16px，uppercase + tracking-wide）：區段標頭（Fleet Health、Event Stream、Summary、Likely causes）、側欄分組名。
- **Micro**（600, 10px/14px，uppercase）：狀態徽章（HEALTHY／WARNING／CRITICAL／Stale）、單位、計數。另有 11px/16px 的 `text-pill` 給 drawer 狀態 chip 與 Cached badge。
- **Mono 12px**：machine id、job id、時間戳、latency、event 時刻、evidence 摘錄、串流文字（leading-relaxed）。
- **Number**（400, 22px/28px, mono, leading-none）：卡片上的四個遙測值，唯一的「大字」。

### Named Rules
**The Machine-Speaks-Mono Rule.** 凡是 id、數值、時間、log、AI 原始輸出，一律等寬；凡是人寫的標籤與說明，一律 Inter。
**The No-Hero Rule.** 沒有 display 字級；視覺重量來自 22px 等寬數字與狀態色，不來自標題。

## Layout

桌機是固定三欄的 app shell，`h-screen w-screen overflow-hidden`，body 不捲動、各區自行捲動：

- **左欄 sidebar**：預設 240px（可拖曳調整，把手 6px 寬疊在 1px 右邊框上），`bg-surface` + `border-r`。由上而下：品牌列（Activity icon + 名稱 + 環境標籤）、依分組的機台清單、`mt-auto` 貼底的 Fleet Health。
- **中欄**：56px 頂欄（`bg-surface` + `border-b`，內容為 TopBar）+ 填滿的 main。main 內是拓樸畫布：`bg-surface-inset` 加 24px 方格的 3.5% 白色格線，`p-4 md:p-6`，卡片網格 `repeat(auto-fill, minmax(min(100%, 220px), 1fr))`、gap 16px。底部另有可調高度的 Event Stream 列（`bg-surface`，每列最小高 34px）。
- **右欄 drawer**：400px 固定寬、`bg-elevated` + `border-l`，可收合成 36px 的展開把手。

手機（< md 768px）：sidebar 隱藏；drawer 變成 bottom-sheet，`fixed` 於底部、高 70–85vh、頂部 8px 圓角、`shadow-drawer`，背後是 `bg-black/50` 遮罩（從 56px 頂欄以下開始）；卡片網格自然退成單欄。TopBar 在窄寬度下依序隱藏次要項（Mock Hz、Metrics、背壓徽章）以保 Diagnose 完整可見。

間距節奏：Tailwind 4px 基準。卡片內距 12px、卡片內區塊間距 12px、2×2 遙測網格 gap 12px×8px；drawer 與面板內距 16px；區段之間 16px；TopBar 項目間距 8–12px；控制項高度統一 36px。

## Elevation & Depth

**以色階分層為主、陰影為輔。** 深度幾乎全靠五階藍灰底（canvas → inset → surface → hover → elevated）與 1px hairline 邊框；陰影只有兩種且極淡，用來讓卡片與 bottom-sheet 從底上微微浮起，不用來表達層級。

### Shadow Vocabulary
- **Card**（`box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 12px 28px rgba(0,0,0,0.22)`）：所有機台卡片常駐；上緣 1px 白色 4% 高光模擬邊緣受光。
- **Drawer**（`box-shadow: -18px 0 36px rgba(0,0,0,0.35)`）：手機 bottom-sheet 與桌機 drawer。
- **Critical Pulse**（keyframes：`0 0 0 0 rgba(255,92,102,0.35)` → `0 0 0 6px rgba(255,92,102,0)`，1.2s ease-in-out infinite）：critical 卡片與狀態燈的擴散光暈，是唯一會動的陰影。

### Named Rules
**The Tonal-Steps Rule.** 要讓東西「在上面」，換下一階底色加 hairline，而不是加陰影。
**The Outline-Not-Ring Rule.** 選取框用 `outline 1px + offset -2px` 疊在 1px accent 邊框上組成 2px，不用 ring／box-shadow——因為 critical 的脈動動的就是 box-shadow，ring 會被蓋掉。

## Shapes

三檔圓角、全部偏方：控制項（按鈕、輸入框、子卡片、evidence 列）6px；卡片與 bottom-sheet 頂角 8px；徽章、chip、狀態燈、進度條、卷軸 thumb 全圓 999px。卡片圓角上限 8px 是產品約束，不是風格偏好。

邊框一律 1px hairline（#26323D），hover 升為 strong（#3E5266），選取升為 accent。warning 卡片不換邊框，改用 1px inset ring 的暗琥珀；critical 換成暗紅邊框。狀態燈是 12px 方框內置中的 9px 圓點，脈動只作用於圓點。

拓樸畫布有 24px 方格的 3.5% 白色格線，是整個 app 唯一的圖樣。

## Components

### Buttons
- **Shape:** 6px 圓角，高 36px，icon 16px 加 6px 間距，文字 14px/500；窄螢幕只留 icon（文字 `hidden md:inline`），一律有 `aria-label` 與 `title`。
- **Primary**（Diagnose、Run diagnosis）：`bg-accent text-canvas`，hover `bg-accent-hover`，disabled `opacity-50 cursor-not-allowed`。
- **Secondary**（Pause／Resume、中止診斷）：`bg-surface border-subtle text-fg-muted`，hover `bg-surface-hover text-fg`；Mock Hz 以 disabled + `opacity-60` 作占位。
- **Icon-only**（卡片右下 Diagnose、drawer 關閉、面板展開把手）：`p-1.5` 或 `p-1`，`text-fg-subtle`，hover 底色 surface-hover、文字轉 accent 或 fg；卡片上的那顆預設 `opacity-0`，hover／focus 或無 hover 裝置時顯示。
- **Focus:** 全站統一 `focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`。

### Chips（pill）
- **Connection chip**：`bg-elevated rounded-pill px-2.5 py-1 text-xs`，前置 8px 圓點依三態上色（ok／warn／crit），reconnecting 時圓點脈動，後綴 mono 的延遲 ms。
- **Drawer status chip**：`text-pill`（11px）配 Idle（elevated／subtle）、Active（accent-bg／accent）、Completed（ok-bg／ok-fg）、Failed（crit-bg／crit-fg）。
- **State badge**（卡片右上）：10px/600 uppercase tracking-wide，`bg-*-bg text-*-fg`，無邊框；Stale 徽章則有 warn-border 邊框。
- **Cached badge**：`bg-accent-bg text-accent border-accent-bg-strong`。
- **Severity badge**：12px/500，`bg-*-bg text-*-fg border-*-border`，有邊框。
- **Backpressure badge**：`bg-elevated rounded-pill font-mono text-xs text-fg-muted`，比值數字 `text-accent font-medium`。

### Cards / Containers
- **MachineNodeCard**：`<button>` 元素，`min-h-[148px] rounded-card border p-3 shadow-card`，`flex-col gap-3`；hover `-translate-y-px border-strong bg-surface-hover`（150ms）。狀態：healthy `border-subtle bg-surface`；warning 加 `ring-1 ring-inset ring-warn-bg`；critical `border-crit-border bg-crit-bg animate-critical-pulse`；selected `border-accent bg-accent-wash outline`；stale `opacity-[0.55]`，數值不清空。內容：名稱 14px/500 + Stale 徽章、machine id mono 12px、狀態徽章 + 狀態燈；2×2 遙測網格（label 12px subtle、值 22px mono、單位 10px subtle）；貼底的 `updated Ns ago` mono 12px。
- **Drawer 子卡片**（idle 摘要、job meta、evidence）：`rounded-control border-subtle bg-surface px-2.5 py-2`，無陰影。
- **Streaming panel**：`rounded-control bg-surface-inset p-3 font-mono text-xs leading-relaxed text-fg-muted`，max-h 320px，尾端 1.5×14px 的 accent 游標以 0.8s steps(1) 閃爍。

### Inputs / Fields
- **Search**：高 36px，`rounded-control border-subtle bg-surface-inset`，左內距 32px 放 16px 的 Search icon（subtle），placeholder subtle，focus 邊框轉 strong + accent ring；`type="search"`。這是全站唯一的輸入欄。

### Navigation
- **Sidebar group header**：12px/500 uppercase tracking-wide subtle。
- **Sidebar item**：`rounded-control px-2 py-1.5 text-sm text-fg-muted` 前置 16px Boxes icon（subtle）；hover surface-hover；active `bg-accent-bg text-fg`。
- **Brand row**：Activity icon（accent）+ 14px/600 名稱 + 12px subtle 環境標籤，底邊 hairline。

### ProgressBar（signature）
高 6px 的 pill 軌道（`bg-surface-inset`）；數值態以 300ms ease-out 變寬，顏色依狀態；indeterminate 態為 1/3 寬的 accent 色塊以 1.2s 從 -100% 滑到 220%；reduced-motion 時停成靜止的 1/3 條。帶 `role="progressbar"` 與 aria 值。

### StatusLight（signature）
12px 方框內置中 9px 圓點，`bg-ok／bg-warn／bg-crit`，critical 時脈動；`role="img"` + `aria-label="Status: …"`。同一張 `STATE_STYLE` 對照表供卡片徽章、Fleet Health 比例條與圖例、Event Stream 嚴重度點共用。

### Fleet Health（signature）
高 8px 的四段比例條（ok／warn／crit／strong 代表 stale），0 佔比不渲染；下方 2×2 圖例（8px 圓點 + 12px label + 右對齊 mono 計數），底部 10px mono `total N`。

### Event Stream（signature）
`bg-surface` 的可調高度面板；標頭為 Label 級「Event Stream」+ mono `N/50`；每列 ≥34px：mono 時刻（subtle）、6px 嚴重度圓點 + label、截斷的訊息（muted），列間 60% 透明的 hairline；空狀態是置中的 12px subtle 說明句。

## Do's and Don'ts

### Do:
- **Do** 用五階底色加 1px hairline 分層；要「浮起」就換下一階底色。
- **Do** 讓每個狀態同時有顏色、文字徽章與 aria label；徽章一律 `bg-*-bg + text-*-fg`。
- **Do** 把一切機器產生的值（id、數值、時間、串流）設成 JetBrains Mono。
- **Do** 保持控制項高度 36px、圓角 6px；卡片圓角 8px、內距 12px。
- **Do** 在 `prefers-reduced-motion: reduce` 下停掉三種循環動畫並把 transition 縮到 0.01ms。
- **Do** 讓 10–12px 小字對其底色 ≥ 4.5:1（text-muted 已為此提亮到 #7C8A98）。

### Don't:
- **Don't** 在元件內寫 hex、`style="color:#…"` 或自創 warning／critical 色（憲章硬規則）。
- **Don't** 把 accent 藍用在 primary action、選取態、游標、背壓比值以外的地方。
- **Don't** 用陰影表達層級，也不要在選取態用 ring／box-shadow（會被 critical 脈動蓋掉）。
- **Don't** 用大面積紫色漸層、裝飾光球、bokeh，或超過 8px 的卡片圓角。
- **Don't** 讓 warning 卡片換邊框、讓 critical 閃爍或用亮紅整面。
- **Don't** 在 stale 時清空數值或改變卡片盒模型（避免 layout shift）。
