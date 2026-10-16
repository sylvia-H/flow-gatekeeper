---
name: flow-gatekeeper
description: 實驗室玻璃與蝕刻刻度——冷色實驗桌面上的磨砂玻璃面板、蝕刻刻度與深青液位線，淺色預設、深色次要的即時監控台與 AI 診斷面板
colors:
  bench: "#DDE3E8"
  bench-grid: "#D0D7DD"
  rim: "#C9D1D8"
  surface: "#FFFFFF"
  surface-strong: "#FFFFFF"
  edge: "#BAC2C8"
  highlight: "#FFFFFF"
  ink: "#1F2A33"
  ink-2: "#36434F"
  ink-3: "#4A5763"
  etch: "#9AA7B2"
  accent: "#0F6E8C"
  accent-strong: "#0B5A73"
  accent-wash: "#D9ECF2"
  ok: "#2E7D4F"
  ok-fg: "#1E5A37"
  ok-bg: "#DCEFE3"
  warn: "#B7791F"
  warn-fg: "#7A4E0C"
  warn-bg: "#F7EAD2"
  crit: "#C62828"
  crit-fg: "#9B1C1C"
  crit-bg: "#FBE2E0"
  stale: "#7A8792"
  focus: "#0F6E8C"
  scrim: "#1F2A33"
typography:
  ratio:
    fontFamily: "JetBrains Mono, Noto Sans TC, ui-monospace, monospace"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
  number:
    fontFamily: "JetBrains Mono, Noto Sans TC, ui-monospace, monospace"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: "28px"
    fontFeature: "tnum"
  title:
    fontFamily: "Source Sans 3, Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: "28px"
  heading:
    fontFamily: "Source Sans 3, Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "Source Sans 3, Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "Source Sans 3, Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  mono:
    fontFamily: "JetBrains Mono, Noto Sans TC, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    fontFeature: "tnum"
rounded:
  control: "4px"
  card: "6px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "14px"
  xl: "16px"
  gutter: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.surface-strong}"
    rounded: "{rounded.control}"
  button-primary-disabled:
    backgroundColor: "{colors.rim}"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.control}"
  button-tool:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "36px"
  button-tool-hover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    padding: "6px"
  input-search:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px 0 32px"
    height: "36px"
  chip-connection-ok:
    backgroundColor: "transparent"
    textColor: "{colors.ok-fg}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  badge-state-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  badge-state-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  badge-state-crit:
    backgroundColor: "{colors.crit-bg}"
    textColor: "{colors.crit-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  badge-stale:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  chip-diagnosis-active:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  chip-diagnosis-cached:
    backgroundColor: "{colors.rim}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  latch-struck:
    backgroundColor: "{colors.rim}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  panel-glass:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "14px"
  card-machine:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "14px"
  card-machine-hover:
    backgroundColor: "{colors.surface-strong}"
    rounded: "{rounded.card}"
  card-machine-critical:
    backgroundColor: "{colors.crit-bg}"
    rounded: "{rounded.card}"
  card-machine-selected:
    backgroundColor: "{colors.accent-wash}"
    rounded: "{rounded.card}"
  sheet:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  segment-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface-strong}"
    typography: "{typography.body}"
    height: "32px"
---

# Design System: flow-gatekeeper

> **現況紀錄（2026-10-16，feature 013 UI 全面改版完成後以 `/impeccable document` 掃描程式碼產出）。** 本檔整份取代 1.1.0 的「深色 Argo CD 致敬」紀錄；視覺世界「實驗室玻璃與蝕刻刻度」由使用者於 2026-10-15 選定（direction contract：`.impeccable/surfaces/src-app-vue.md`）。所有 token 值取自 `src/styles/theme.css`（全站唯一色值檔）、`tailwind.config.ts`、`src/styles/tailwind.css` 與各 `.vue` 元件；frontmatter 的色值是**淺色（預設）主題**，深色主題的同名值記在 `.impeccable/design.json` 的 `colorMeta.*.dark`。theme.css 存的是 `R G B` 三元組，此處以等價 hex 記錄，不另立來源。

## Overview

**Creative North Star: "實驗桌上的量筒"（The Graduated Cylinder on the Bench）**

整個監控台是一張冷色的實驗桌：桌面鋪著 24px 的極細格線，桌邊（rail 與工具列）是比桌面更深一階的鋼灰，面板是一片片放在桌上的磨砂白玻璃——72% 不透明的白、1px 的桌邊色細框、內側上緣一條 1px 高光，格線隱約從玻璃後透出。玻璃沒有模糊、沒有光暈、沒有投影；它「在桌上」這件事靠的是框線與高光，不是陰影。數字像量筒的液面一樣沿著蝕刻刻度讀取：背壓帶的下緣是一支 0–60 的比值刻度，深青的液位線停在比值所在；每張機台卡片的四個數值旁都有三格蝕刻小刻度，超標時刻度與數字一起換成狀態色；事件列每行左側一條蝕刻短線依嚴重度上色。

密度中高、語氣穩重：面板間距 12px、面板內距 14px，所有機器產生的值（id、數值、時間、串流）一律 JetBrains Mono 等寬並開 `tabular-nums`，人寫的標籤與說明用 Source Sans 3 配 Noto Sans TC；UI 文案一律繁體中文，只有機台 id、單位、`Mock`／`AI`／`WS`、queue 名與 LLM 輸出保留英文。整個畫面只有一種 accent（深青）：它擁有主要動作、選取、液位線與串流游標，其餘一切都是墨色三階與桌邊灰。狀態三色（正常綠、警告琥珀、嚴重紅）只出現在刻度、液位線、徽章與邊框，從不當作大面積底色——嚴重卡片的 crit-bg 是唯一例外，而且它仍是 80% 透明、透得出格線。

淺色為首次載入預設、深色為次要（深鋼灰桌面與煙燻玻璃，同一組 token 名換值），切換只改 `<html data-theme>` 一個屬性並在那一幀停用所有過渡。明確拒絕的東西（direction contract OWN-WORLD 與 PRODUCT.md）：`backdrop-filter`、光暈（零位移外擴陰影）、色彩漸層（唯一例外是桌面格線的兩道 1px 實線）、超過 6px 的一般圓角、大面積紫色漸層與裝飾光球、Argo CD 品牌資產、landing page 式首屏。

**Key Characteristics:**
- 三層材質：桌面（bench + 格線）→ 桌邊（rim）→ 磨砂玻璃（surface 72% + edge 框 + 內側高光），深度靠材質不靠陰影
- 蝕刻刻度是簽名：比值刻度 0–60 與深青液位線、卡片數值旁的三格小刻度、事件列的蝕刻短線、流向連線的蝕刻底線
- 單一深青 accent 擁有所有 live 狀態：主要動作、選取框、液位線、串流游標、進行中 chip
- 狀態三件套（實心／fg 文字／bg 底）各自只出現在刻度、液位線、徽章與邊框；嚴重卡片的脈動只換底色與邊框色
- Source Sans 3 + Noto Sans TC 做 UI、JetBrains Mono tabular 做一切機器產生的值；最小功能性字級 12px
- 圓角三檔：4px 控制項、6px 卡片與面板、全圓 pill；淺深雙主題同名 token

## Colors

冷灰藍的實驗桌面配墨色文字，深青是唯一的飽和色；狀態三色各帶一組「實心／前景文字／徽章底」三件套，兩套主題共用同一張對照表。

### Primary
- **深青 Lab Teal**（`accent` #0F6E8C）：主要動作「診斷」的底色、液位線、串流游標、進行中 chip 的文字、選取框（卡片 2px 框、事件列與異常列的 1px inset ring）、走勢線的批次虛線。它是「系統正在等你」與「這是你選的」的唯一訊號色。對玻璃 5.39:1 可作文字；對桌面 bench 4.47、桌邊 rim 3.75 不達標，所以**桌面與桌邊上的深青文字一律改用 accent-strong**（Copilot 標頭的聽診器圖示即是）。
- **深青加深 Lab Teal Deep**（`accent-strong` #0B5A73）：主要按鈕的 hover／按下底色與邊框、桌面與桌邊上的深青文字（bench 5.96、rim 4.99）。
- **深青水洗 Teal Wash**（`accent-wash` #D9ECF2）：選取卡片、選取事件列、選取異常列的底色；進行中 chip 的底（accent 字在上為 4.75:1，剛過門檻，不要再淡）。

### Neutral
- **實驗桌面 Bench**（`bench` #DDE3E8）：app 最底層與主區背景；也作串流面板、建議指令區塊、比例條軌道的「內凹」底。
- **桌面格線 Bench Grid**（`bench-grid` #D0D7DD）：主區 24px 方格的 1px 線色，整個系統唯一的 `linear-gradient` 用途。
- **桌邊 Rim**（`rim` #C9D1D8）：rail、56px 工具列、Copilot 面板標頭、快捷鍵 kbd 底、快取 chip 與低優先度 pill 底、劃線作廢的異常標記底。比桌面深一階，承載「結構」而非「內容」。
- **玻璃 Surface**（`surface` #FFFFFF）：永遠以 `bg-surface/72` 使用的磨砂白；與 bench 合成後約 #F5F7F9，header 註解的對比表以此合成色計算。hover 時轉為不透明（`bg-surface` 或 `bg-surface-strong`）。
- **實玻璃 Surface Strong**（`surface-strong` #FFFFFF）：不透明覆蓋層（bottom-sheet、異常清單、快捷鍵說明、peek 條）、卡片 hover 底、停滯徽章底，也是 accent 底上的文字色。
- **玻璃框 Edge**（`edge` #BAC2C8）：所有 1px 邊框、分隔線與卷軸 thumb；是「rgba(31,42,51,0.18) 疊在桌面上」的合成色，所以 `border-edge` 不帶 alpha。
- **上緣高光 Highlight**（`highlight` #FFFFFF）：只用於 `shadow-glass` 的內側 1px 高光（90%）。
- **墨色三階 Ink**（`ink` #1F2A33／`ink-2` #36434F／`ink-3` #4A5763）：主文字、次文字、標籤與 meta。ink-3 對桌邊 4.80:1 是整個系統的最低文字對比，12px 小字即以它為底線。
- **蝕刻 Etch**（`etch` #9AA7B2）：**只給非文字裝飾**——刻度線、卡片小刻度、流向連線底線、事件列「回復」的短線、待辦步驟短線、placeholder 圓點、「還有 N 筆」的底線裝飾；對玻璃 2.29:1，不得當文字色。
- **停滯 Stale**（`stale` #7A8792）：停滯徽章的色點與虛線框、機群健康第四段。對玻璃 3.43，非文字用。
- **焦點 Focus**（`focus` #0F6E8C）：所有鍵盤焦點環的顏色，淺色等於 accent，深色提亮為 #73C6DF。
- **遮罩 Scrim**（`scrim` #1F2A33）：bottom-sheet 與覆蓋層後方 `bg-scrim/50` 的蒙層；兩套主題都是深色（不能用 ink，深色主題的 ink 是淺色）。

### Status（三組三件套）
- **正常**：實心 `ok` #2E7D4F（狀態燈、比例條、連線 chip 點與框、嚴重度色條、已完成步驟短線）、文字 `ok-fg` #1E5A37、底 `ok-bg` #DCEFE3。
- **警告**：實心 `warn` #B7791F（刻度、狀態燈、警告卡片 1px 全邊框）、文字 `warn-fg` #7A4E0C（越界數值、丟棄數、橫幅文字）、底 `warn-bg` #F7EAD2。warn 實心對玻璃只有 3.39，**不得作文字**。
- **嚴重**：實心 `crit` #C62828（刻度、狀態燈、嚴重卡片邊框）、文字 `crit-fg` #9B1C1C、底 `crit-bg` #FBE2E0（嚴重卡片以 80% 使用、徽章與失敗訊息不透明）。

### Named Rules
**The One Teal Rule.** 深青只出現在主要動作、選取、液位線、串流游標與「進行中」；任何裝飾性的青都是錯的。桌面與桌邊上的深青文字一律用 accent-strong。
**The Etch-Is-Not-Text Rule.** `etch` 與狀態實心色只畫刻度、短線、點、邊框與色條；文字一律用 ink 階或 `*-fg`。刻度旁的數字是文字，用 ink-3。
**The Three-Piece Rule.** 每個狀態都是「實心／fg／bg」三件套：徽章永遠 `bg-*-bg + text-*-fg`，實心只給刻度、燈、框與色條；嚴重卡片是唯一拿 `*-bg` 當大面積底的地方，而且是 80%。
**The One Source Rule.** 色值只存在 `theme.css`，兩套主題同名換值；元件與 `tailwind.config.ts` 只寫語意 class（`bg-bench`、`text-ink-2`…），半透明一律由 class 的 alpha 修飾（`bg-surface/72`、`bg-crit-bg/80`、`bg-scrim/50`、`bg-ink/20`）決定。

## Typography

**UI Font:** Source Sans 3（fallback Noto Sans TC → PingFang TC → Microsoft JhengHei → system-ui），載 400／500／600／700。
**Mono Font:** JetBrains Mono（fallback Noto Sans TC → ui-monospace），載 400／500；中文落在 Noto Sans TC。
三者由 Google Fonts 以 `display=swap` 載入，失敗退回系統字型。

**Character:** 中性、略帶人文感的工具字配嚴格的等寬數字。Source Sans 3 與 Noto Sans TC 負責人寫的標籤、按鈕、說明與 LLM 摘要；JetBrains Mono 負責一切機器產生的值，並**全部開 `tabular-nums`**，讓刻度旁的數字位數變化不位移。沒有 display 級標題：整個 app 最大的字是 32px 的背壓比值與快取耗時，不是任何標題。

### Hierarchy
- **Ratio**（600, 32px/1, mono tabular）：背壓比值、快取命中時的「N ms」主數字。整個畫面的視覺錨點。
- **Number**（500, 24px/28px, mono tabular）：卡片 2×2 遙測值、每秒訊息與每秒批次。
- **Title**（700, 20px/28px）：rail 品牌列「flow-gatekeeper」，全站唯一一處。
- **Heading**（600, 16px/24px）：卡片機台中文名、Copilot 標頭「AI 診斷」與面板內機台名、進行中的進度百分比（mono 500）。
- **Body**（400, 14px/20px）：按鈕文字（600）、搜尋框、事件訊息、結果摘要與條列（`leading-relaxed`）、stage 標題與面板區段標頭（600、ink-2）。
- **Label**（400, 12px/16px）：數值標籤、meta、刻度數字（mono）、走勢「近 60 秒」；徽章、chip、異常標記、「主題」與 peek 條的「AI 診斷」用 600。**12px 是最小功能性字級**，10／11px 已退役。
- **Mono**（400, 12px/16px, mono tabular）：machine id、時間戳、單位、事件時刻、`N/50`、`×N`、證據摘錄、原始串流、快捷鍵 kbd。

### Named Rules
**The Machine-Speaks-Mono Rule.** 凡是 id、數值、時間、單位、log、AI 原始輸出，一律 JetBrains Mono + `tabular-nums`；凡是人寫的標籤與說明，一律 sans。
**The 12px Floor Rule.** 功能性文字不小於 12px（`text-xs`），且對其實際底（玻璃合成色、桌邊、徽章底）≥ 4.5:1；對比表在 `theme.css` 檔頭。
**The No-Hero Rule.** 沒有 display 字級；視覺重量來自 32px 的比值與 24px 的遙測數字，不來自標題。

## Layout

桌機（≥ 1024px）是固定三欄的 app shell，`h-screen w-screen overflow-hidden`，body 不捲動、各區自行捲動：

- **左 rail**（≥ 768px 顯示）：預設 240px，可拖曳或鍵盤調整 200–420px（把手 6px 寬疊在 1px 右框上，hover／focus 時顯示 60% 深青），`bg-rim border-r border-edge`，內距 16px、區塊間距 12px。由上而下：品牌列（20px 名稱 + 「開發」環境 pill）、機群健康玻璃片、最近異常玻璃片、`mt-auto` 貼底的主題切換。
- **工具列**：56px 高、`bg-rim border-b border-edge`、左右內距 12px；四組語意分組（導航／播放控制／系統狀態／主要動作），控制項高度統一 36px、間距 12px。依工具列可用寬度三段收合：≥ 820px 全部顯示、640–819px 只留圖示、< 640px 搜尋收成圖示鈕（展開為覆蓋式輸入框）、Mock 頻率與指標面板隱藏。
- **主區**：`bg-bench` + 24px 格線，內距 12px，直欄間距 12px：背壓帶玻璃片（約 96px）→ 連線橫幅（有事才出現，玻璃片）→ 拓樸捲動區（內距 8px 留給焦點環）→ 事件流玻璃片（可拖曳或鍵盤調整 100–360px）。
- **拓樸**：五欄 grid `minmax(220px,1fr) 24px minmax(220px,1fr) 24px minmax(220px,1fr)`，24px 溝槽放流向連線；三欄各有標頭（14px 600 名稱 + mono 台數）以 1px edge 下緣界定，**欄本身不包玻璃**，卡片直接放在桌面上、縱向間距 12px。容器內容寬 < 708px（3×220 + 2×24）時改為單欄堆疊、段間 24px 高的朝下短箭頭、不流動——以容器寬度而非 viewport 判斷，因為 Copilot 面板開合會改變主區寬度。
- **Copilot 面板**：≥ 1024px 為 360px 寬的推擠式玻璃片（`my-3 mr-3`），收合時留一條 36px 寬的展開窄條（直書「AI 診斷」）；< 1024px 改為 bottom-sheet（`fixed bottom-0`，最高 85vh，頂角 6px，`bg-surface-strong` 不透明、`shadow-sheet`，後方 `bg-scrim/50` 從工具列以下蓋住），收合後仍有選取機台時退為底部 32px 的 peek 條。
- **手機（< 768px）**：rail 隱藏；主區頂端常駐 44px 的機群健康摘要條（比例條 + 四個計數，點開為異常清單覆蓋層）；背壓帶只留每秒訊息、比值與丟棄數，刻度縮成 18px 的 compact 版；工具列主題切換改為單一 36px 圖示鈕。

驗收 viewport 五個：1366×768、1440×900、1024×768、768×1024、390×844，兩套主題下不得溢出、重疊、橫向捲動；hover／選取／嚴重脈動／搜尋過濾不得造成 layout shift（截圖劇本量測）。

間距節奏：Tailwind 4px 基準。面板間距 12px、面板與卡片內距 14px（`p-3.5`）、卡片內區塊間距 12px、2×2 遙測格 gap 12px×8px、rail 內距 16px、stage 溝槽 24px；控制項高 36px、chip 高 32px、徽章高 20px（1px 框 + `py-px` + 16px 行高）。**任何讀數、徽章、標記的出現或消失都不改變所屬容器的高度**：佔位恆在（比值的「:1」、「>60」格、卡片底列 20px、手機丟棄數位置）。

## Elevation & Depth

**材質分層，不用投影。** 深度來自三種材質的疊放：桌面（bench + 格線）最底，桌邊（rim）承載結構，磨砂玻璃放在桌上。玻璃「在上面」靠三件事：72% 的白底讓格線隱約透出、1px `edge` 細框、內側上緣 1px 的 `highlight` 高光（`shadow-glass`）。hover 時玻璃轉為不透明（`bg-surface` 或 `bg-surface-strong`），不抬升、不加影。沒有任何零位移的外擴陰影（那就是被禁的光暈），也沒有 `backdrop-filter`。

### Shadow Vocabulary
- **Glass**（`box-shadow: inset 0 1px 0 rgb(var(--c-highlight) / 0.9)`）：每一片玻璃常駐的內側上緣高光；它是材質的一部分，不是層級。
- **Sheet**（`box-shadow: 0 -8px 24px rgb(var(--c-ink) / 0.18)`）：只給脫離文件流的覆蓋層——bottom-sheet、peek 條、手機異常清單、快捷鍵說明——讓不透明的 sheet 與下方內容分層。桌機上的推擠式面板不用它。

### Named Rules
**The Glass Recipe Rule.** 一片玻璃 = `rounded-card border border-edge bg-surface/72 shadow-glass`，四件缺一不可；要不透明就換 `bg-surface-strong`，不要改 alpha 到別的值。
**The No-Halo Rule.** 不用零位移的外擴 box-shadow、不用 `backdrop-filter`、不用色彩漸層；桌面的兩道 1px 格線是唯一的 `linear-gradient`。
**The Pulse-Is-Color Rule.** 嚴重卡片的脈動（`criticalPulse` 1.2s）只動 `background-color`（crit-bg 80% → 100%）與 `border-color`（crit → crit-fg），不動尺寸、不動 box-shadow；選取時以 `animation: none` 停住，選取的深青框與水洗底不被染紅。
**The Outline-Not-Ring Rule（卡片）.** 機台卡片的選取框（1px accent 邊框 + 內縮 1px outline 組成 2px）與焦點環（2px `focus` 色 outline、外延 2px）都走 `outline`，與底色脈動和玻璃高光互不相干；其他控制項的焦點環用 `focus-visible:ring-2 ring-focus`。

## Shapes

三檔圓角、全部偏方：控制項（按鈕、輸入框、kbd、串流面板、色條、液位線端、抓取把手）4px；卡片、玻璃面板、bottom-sheet 頂角、覆蓋層 6px；徽章、chip、狀態燈、連線 chip、卷軸 thumb 全圓 999px。6px 是一般圓角的上限（PRODUCT.md 產品約束），pill 是明文例外。

邊框一律 1px `edge`；狀態以邊框色表達——警告卡片換 `warn` 全邊框、嚴重卡片換 `crit`、選取換 `accent`，**只換色不改寬度**，盒模型不變。停滯把邊框改虛線（`border-dashed`）而不改色，與狀態色疊加；空 stage 欄的佔位也是虛線框。主要按鈕帶一圈 `accent-strong` 邊框，停用時換 `edge`。

幾何語彙是「線」：刻度是 1px 線（`vector-effect: non-scaling-stroke` 讓拉伸不變粗）、液位線是 2px 寬的深青短柱、事件列的嚴重度是 16×2px 短線、處理步驟是 12×2px 短線、可能原因的項目符號是 10×2px 短線、結果頂部的嚴重度是 2px 色條；狀態燈是 12px 方框內置中的 10px 圓點。沒有圓角大色塊、沒有填色圖示底。

## Components

### Buttons
- **Shape:** 4px 圓角，高 36px（Copilot 內的全寬主要鈕為 `py-2`），icon 16px 加 6px 間距，文字 14px/600；窄工具列只留 icon，一律有 `aria-label` 與 `title`。lucide 線性圖示，不用 glyph 字型。
- **Primary**（工具列「診斷」、Copilot「診斷」／「重試」）：`bg-accent text-surface-strong border-accent-strong`，hover `bg-accent-strong`；disabled 工具列版 `bg-surface/72 border-edge text-ink-3`、面板版 `bg-rim border-edge text-ink-3`（不用整顆半透明，停用對比仍 ≥ 3:1）。工具列上的焦點環加 `ring-offset-2 ring-offset-rim`。
- **Tool**（搜尋圖示鈕、暫停／恢復、主題圖示鈕、中止診斷）：玻璃配方的按鈕版 `bg-surface/72 border-edge text-ink-2 shadow-glass`，hover `bg-surface text-ink`；Mock 頻率以 `border-dashed text-ink-3 cursor-not-allowed` 作停用占位。
- **Icon-only**（關閉、清除異常、卡片右下診斷、收合把手）：`p-1.5` 或 `h-7 w-7`／`h-8 w-8`，`text-ink-2`／`text-ink-3`，hover 轉 `text-ink` 或 `text-accent`、底轉 `bg-surface/72` 或 `bg-rim`；卡片上的那顆預設 `opacity-0`，hover／focus-within 或無 hover 裝置時顯示，並有 `bg-surface-strong border-edge` 底。
- **Segmented**（主題切換「淺色｜深色」）：兩段各自帶 1px edge 框、高 32px，選中段 `bg-ink text-surface-strong font-semibold`，未選 `bg-surface/72 text-ink-2`；焦點環 `ring-offset-2 ring-offset-rim`。
- **Disclosure**（原始串流展開、「還有 N 筆」）：無底無框的 14px 文字鈕，`text-ink-2` hover `text-ink`；「還有 N 筆」帶 `decoration-etch` 底線。
- **Focus:** 全站 `focus:outline-none focus-visible:ring-2 focus-visible:ring-focus`；列表列與捲動區用 `ring-inset`。

### Chips（pill）
- **連線 chip**：高 32px、`rounded-pill border` 透明底，點／框用狀態實心色、文字用 `*-fg`（已連線 ok、重新連線中 warn、已斷線 crit），後綴 mono 的 `· N ms`；未授權 chip 另有 `bg-crit-bg`。
- **狀態徽章**（卡片右上、面板摘要）：12px/600、`py-px px-2 leading-4`、`bg-*-bg text-*-fg`、透明邊框佔位；嚴重卡片上的徽章改 `border-crit`（底色相近才分得出來）。
- **停滯徽章**：`border-stale bg-surface-strong text-ink-2` + 6px `bg-stale` 色點。
- **診斷狀態 chip**（卡片 id 列、peek 條）：進行中 `border-accent bg-accent-wash text-accent`、已完成 `border-edge bg-surface-strong text-ink-2`、快取 `bg-rim text-ink-2`、失敗 `border-crit bg-crit-bg text-crit-fg`。
- **Copilot 狀態 chip**：閒置 `bg-surface-strong text-ink-2`、進行中 `bg-accent-wash text-accent`、已完成 `bg-ok-bg text-ok-fg`、失敗 `bg-crit-bg text-crit-fg`。
- **優先度 pill**（建議動作）：高 `bg-crit-bg text-crit-fg`、中 `bg-warn-bg text-warn-fg`、低 `bg-rim text-ink-2`；證據來源 pill `bg-rim text-ink-2` 500。
- **環境 pill**（rail 品牌列「開發」）：`border-edge text-ink-2` 12px/600。

### Cards / Containers
- **玻璃面板**（背壓帶、機群健康、最近異常、事件流、連線橫幅、桌機 Copilot）：`rounded-card border border-edge bg-surface/72 shadow-glass`，內距 14px（背壓帶 `px-3.5 py-2`）；面板標頭 14px/600 `text-ink-2` 配右側 mono 12px 計數；Copilot 標頭另有 `bg-rim border-b` 的桌邊帶。
- **MachineNodeCard**：`<button>`，`min-h-[148px] rounded-card border p-3.5 shadow-glass`，`flex-col gap-3`，`transition-colors 150ms`、**hover 不位移**。狀態：healthy／placeholder `border-edge bg-surface/72` hover `border-etch bg-surface-strong`；warning `border-warn bg-surface/72`（hover 只轉不透明、邊框保留）；critical `border-crit bg-crit-bg/80 animate-critical-pulse`（hover `bg-crit-bg`）；selected 由 `.machine-card[data-selected]` 給 `border-accent bg-accent-wash` + 內縮 outline、停脈動；stale 疊 `border-dashed`，數值不清空。內容：16px/600 中文名｜狀態徽章 + 狀態燈；20px 高的 id 列（mono 12px id · 相對時間 → 停滯徽章 → 診斷 chip，出現與否不改高）；2×2 遙測（12px 標籤 + mono 單位、24px mono 數值 + 10×14px 三格刻度，越界時數值 `text-*-fg`、刻度 `stroke-*`）；底列 20px 佔位放異常標記，右下診斷圖示鈕。
- **異常標記 pill**（卡片底列、`animate-latch-in` 160ms）：嚴重 `border-crit bg-crit-bg text-crit-fg`、警告 `border-warn bg-warn-bg text-warn-fg`，可點清除（hover `border-current`）；清除後 `border-edge bg-rim text-ink-3 line-through`、disabled，保留到回復後 30 秒期滿才消失。最近異常列同步劃線。
- **內凹區塊**（原始串流面板、建議指令、比例條軌道）：`rounded-control border border-edge bg-bench`，串流面板 mono 12px `leading-relaxed text-ink-2`、max-h 320px，尾端 6×14px 深青方塊游標以 0.8s `steps(1)` 閃爍。
- **結果骨架**：區段以 `divide-y divide-edge` 分隔、`py-3.5`；缺欄位時 10px 高 `bg-ink/20` 的靜止佔位條；串流中的欄位尾端同一種游標；頂部 2px 嚴重度色條 `bg-ok／warn／crit`。
- **覆蓋層**（快捷鍵說明、手機異常清單）：`rounded-card border-edge bg-surface-strong shadow-sheet`，後方 `bg-scrim/50`，起於工具列以下（`top-14`）。

### Inputs / Fields
- **搜尋**：高 36px，玻璃配方的輸入版 `rounded-control border-edge bg-surface/72 shadow-glass`，左內距 32px 放 16px Search 圖示（ink-3），placeholder ink-3，focus `border-accent` + 2px focus ring；`type="search"`。compact 時為覆蓋在工具列上的 `bg-rim` 全寬輸入框。全站唯一的輸入欄。

### Navigation
- 沒有側欄導航；rail 的「最近異常」列是唯一的清單式導航：列高 ≥ 36px、`rounded-control`，hover `bg-surface`，選取 `bg-accent-wash ring-1 ring-inset ring-accent`；每列 8px 狀態燈 + 14px 名稱 + 12px ink-3 時間，右側 28px 清除鈕（無標記時留等寬空位）。事件流的列（min-h 32px、`border-b border-edge/60`）同一套 hover／選取規則。

### BackpressureStrip（signature：橫放的量筒）
上列三組「12px 標籤在上、數值在下」的讀數：每秒訊息（24px mono，標籤前一條 ink-2 實線）→ 箭頭 → 每秒批次（標籤前一條 accent 虛線）→ 箭頭 → 比值（32px/600 深青，後綴 14px mono「:1」恆佔位；斷線時轉 ink-2）；右側走勢區 48px 高：「近 60 秒」12px 標籤 + 兩條 1.5px 折線（訊息 ink-2 實線、批次 accent 虛線 `4 3`），時間軸固定 60 格靠右對齊；狀態欄（「連線中斷」pill、「丟棄 N 筆」warn-fg）只壓縮走勢線寬度。下列是 **Graduation**：SVG 刻度 0–60 線性、1 格 = 1:1、每 5 格中格、每 10 格大格並以 HTML 絕對定位標 12px mono ink-3 數字（不用 SVG text，拉伸不變形），線色 `stroke-etch` 1px；液位線是 2px×14px 的深青短柱以 `translateX(比值/60)` 位移（`motion-safe` 500ms ease-out），比值 > 60 時釘右端並在恆佔位的 28px 格標「>60」。以容器寬度收斂：< 36rem 拿掉箭頭、< 32rem 走勢區換到下一列；手機只留每秒訊息、比值、丟棄數與 18px compact 刻度。

### FlowLink（signature）
24px 的 SVG：`stroke-etch` 底線表達管線、粗細隨下游 throughput 總和三檔變化；上層 `stroke-ink-3` 的 `6 6` 虛線以 `animate-flow`（1s 線性位移 -24）流動、三檔時長；箭頭 `fill-ink-3`。堆疊版面改為垂直短箭頭且不流動；reduced-motion 只保留粗細。

### FleetHealth（signature）
rail 版：玻璃片，標頭「機群健康」+ 「共 N 台」，2×2 計數（8px 狀態點 + 12px 標籤 + 右對齊 16px mono 計數染 `*-fg`、停滯用 ink），下方 8px 高 `rounded-control border-edge bg-bench` 軌道的四段比例條（ok／warn／crit／stale，0 佔比不渲染）。手機版：44px 高的玻璃按鈕，比例條 + 四個計數一列 + 展開箭頭。

### StatusLight
12px 方框內置中 10px `rounded-pill` 圓點，`bg-ok／warn／crit`；燈本身不脈動（嚴重卡片的脈動在底色，燈再閃會在半週期與底同色而消失）；`role="img"` + `aria-label="狀態：…"`。狀態 → 色 token 與中文標籤的單一對照在 `shared/lib/state-style.ts`，卡片徽章、機群健康、事件流、Copilot 摘要共用。

## Do's and Don'ts

### Do:
- **Do** 用玻璃配方 `rounded-card border border-edge bg-surface/72 shadow-glass` 做每一片面板；要不透明就換 `bg-surface-strong`。
- **Do** 讓每個狀態同時有顏色、文字徽章與 aria label；徽章一律 `bg-*-bg + text-*-fg`，實心色只給刻度、燈、框與色條。
- **Do** 把一切機器產生的值（id、數值、時間、單位、串流）設成 JetBrains Mono + `tabular-nums`；數字旁附蝕刻刻度時刻度用 `stroke-etch`、數字用 ink-3。
- **Do** 桌面與桌邊上的深青文字用 `text-accent-strong`；玻璃上才能用 `text-accent`。
- **Do** 保持控制項高 36px、圓角 4px；卡片與面板圓角 6px、內距 14px、間距 12px；功能性文字 ≥ 12px 且對實際底 ≥ 4.5:1。
- **Do** 以邊框「換色不換寬」、底色「換 alpha 不換尺寸」表達狀態；任何徽章、讀數、標記的出現都要有恆在的佔位，不改容器高度。
- **Do** 在 `prefers-reduced-motion: reduce` 下停掉五種循環／一次性動畫（critical-pulse、stream-caret、indeterminate、flow、latch-in）並把 transition 縮到 0.01ms；主題切換那一幀停用所有過渡。
- **Do** 以容器寬度（container query／ResizeObserver）而非 viewport 斷點決定背壓帶、拓樸與工具列的收斂。

### Don't:
- **Don't** 在元件或 `tailwind.config.ts` 寫色值；色值只存在 `theme.css`，兩套主題同名換值（憲章硬規則）。
- **Don't** 用 `backdrop-filter`、零位移外擴 box-shadow（光暈）或色彩漸層；桌面格線的兩道 1px 實線是唯一的 `linear-gradient`。
- **Don't** 把深青用在主要動作、選取、液位線、串流游標與「進行中」以外的地方；不要把 `etch`、`stale`、`warn` 實心色當文字色。
- **Don't** 給 stage 欄包玻璃（卡片已是玻璃，欄只有一條蝕刻下緣線）；不要給桌機推擠式面板加 `shadow-sheet`。
- **Don't** 用 ring／box-shadow 做卡片選取框或焦點環（卡片走 outline）；不要讓嚴重脈動動尺寸或陰影；選取中的嚴重卡片不得繼續脈動。
- **Don't** 讓 hover 位移卡片、讓停滯清空數值或降整卡透明度（ink-3 小字會跌破 4.5:1）；一般圓角不超過 6px，pill 以外不用全圓。
- **Don't** 用 10／11px 文字、uppercase 追蹤字距的 eyebrow／kicker、glyph 圖示字型或系統 display 字體；圖示一律 lucide 線性 SVG。
