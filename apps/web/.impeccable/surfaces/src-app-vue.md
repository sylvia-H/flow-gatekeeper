---
version: 1
slug: "src-app-vue"
primary_target: "src/App.vue"
related_targets: []
---

# Surface brief: flow-gatekeeper 監控台（src/App.vue，整個 web 首屏）

- **Scope / mode**: Operate。單一工作畫面：即時機台監控台 + AI 診斷面板，第一屏即工作台。
- **Audience / job**: 監控台操作者（長時間監看、異常時診斷）與展示者／評估者（demo 影片的二十餘秒內看懂背壓、串流、快取；013 當時劇本為 22 秒，2.0.0 重錄版 23 秒）。
- **Task / action**: 掃視 5 台機台狀態 → 選台 → 診斷 → 讀結果 → 確認異常。主要動作「診斷」。
- **Proof / content**: 既有 12 則 WS 訊息與 `POST /diagnoses` 的真實資料；5 台固定 mock 機台、三個 stage；背壓計數由前端衍生。無任何可捏造的商業宣稱。
- **Constraints**: 純前端；契約與後端不動；高頻事件 buffer + rAF 批次提交；具名 token 不散落 hex；卡片圓角 ≤ 8px；不用紫色漸層／光球；不用 Argo CD 品牌資產；UI 文案一律繁體中文；light 預設、dark 次要、可切換；四個 viewport 不溢出不重疊無 layout shift；無障礙規則見 PRODUCT.md。
- **Chosen direction / memorable moment**: 實驗室玻璃與蝕刻刻度（Lab Glass）。記憶點：背壓欄位是一支橫放的量筒，比值以深青液位線標在蝕刻刻度上。使用者在三輪決策中選定（2026-10-15），要求的品質是「穩重的專業感與材質層次」。
- **Chosen sketch**: `.impeccable/mocks/decision/assigned.html`（1440×900 首屏草圖，finish review 的對照基準）。
- **Unresolved**: 繁中 UI 術語表（plan 階段擬定供審）；dark 主題的煙燻玻璃實際明度（build 時定，須維持 4.5:1）；磨砂半透明在 Vue 元件中的落地方式（純 rgba 底色 + 1px 內側高光，不得用 backdrop-filter）。

## Direction contract

THESIS: 每個面板都是一片磨砂玻璃，刻度蝕刻在玻璃上，數字像量筒液面一樣沿刻度讀取；拒絕品類預設的「灰階側欄＋柔邊卡片網格＋一抹藍」，也拒絕 glassmorphism 的模糊與光暈。

OWN-WORLD: 冷色實驗桌面（light #DDE3E8 鋪 24px 極細格線；dark 為深鋼灰桌面）；面板是磨砂白玻璃 rgba(255,255,255,0.72)、1px 邊 rgba(31,42,51,0.18)、內側上緣 1px 高光，格線隱約透出；rail 與工具列是較深的鋼灰桌邊（#C9D1D8）；墨色文字 #1F2A33；accent 深青 #0F6E8C 只給主要動作、選取與液位線；狀態色正常 #2E7D4F、警告 #B7791F、嚴重 #C62828，只出現在刻度、液位線、徽章與邊框。字型：Source Sans 3 + Noto Sans TC（UI），JetBrains Mono（一切機器產生的值，tabular）。密度：面板間距 12px、內距 14px，數字對齊刻度。禁止 backdrop-filter、光暈、漸層；圓角 ≤ 6px。所有內容拿掉仍能從「磨砂玻璃片＋蝕刻刻度＋液位線」認出。

STORY: 操作者打開就看到一支橫放的量筒：比值的液位線停在刻度上、兩條走勢線在刻度上方；三片玻璃裡哪台的刻度變紅、底部事件列哪行的蝕刻短線是紅的；他選台、按診斷，右側玻璃片裡的結果骨架逐格填入；評估者在 demo 影片的二十餘秒內（2.0.0 版 23 秒）讀懂背壓、串流與快取三個機制。

FIRST VIEWPORT: （1440×900）左 240px 鋼灰桌邊 rail：品牌、機群健康（四計數＋比例條）、最近異常摘要列（可點選台、可清除）、主題切換。頂端 56px 工具列：搜尋、暫停、Mock 頻率、連線 chip、右端深青主要動作「診斷」。其下約 100px 的量筒背壓帶：左側三組數字「每秒訊息 → 每秒批次 → 比值（≥32px mono）」，整條下緣蝕刻刻度 0–60s，比值位置一條 2px 深青液位線，兩條走勢線在刻度上方。主區三片並排玻璃（前處理／成型烘烤／包裝分揀），段間箭頭隨 throughput 變粗；機台卡片四個數值各帶 3 格蝕刻小刻度，超標時刻度換狀態色；選取卡片深青 2px 框；診斷狀態 chip 與異常標記在卡片底列。右側 360px Copilot 玻璃片（預設收合、選台展開）。底部約 150px 事件列：每行左側蝕刻短線依嚴重度上色。

FORM: 實驗室玻璃與蝕刻刻度，我的 grounded 清單第 6 名，擲骰指定（第三輪）。seed: none (unavailable)——擲骰輸出未印 SEED REFERENCE，三輪紀錄見 .impeccable/questions/（不入 git）。簽名動作：蝕刻刻度與液位線——背壓是量筒、每個數值旁有刻度、事件列每行有蝕刻短線。借入的紀律：變更保持直到確認（翻牌看板）、走勢以堆疊細線脈衝畫且選取線加粗（Factory 封套）、清除以劃線作廢可追溯（機票夾）、單一 accent 擁有所有 live 狀態（Metro）。

AMENDMENTS (2026-10-15, analyze): 以下各點優先於本 contract 前文與 `assigned.html` 草圖（spec FR-009a、FR-005、FR-031、FR-026）。(1) 量筒下緣的蝕刻刻度是**比值刻度** 0–60（線性、1 格 = 1:1、每 10 格標數字，比值 > 60 時液位線釘右端並標「>60」），不是時間刻度；FIRST VIEWPORT 的「0–60s」與草圖的 `60s` 標籤作廢。(2) 走勢線不共用比值刻度，另以「近 60 秒」小字標示時間範圍。(3) 驗收 viewport 為五個：1366×768、1440×900、1024×768、768×1024、390×844（Constraints 的「四個 viewport」作廢）。(4) 最小功能性字級 12px（草圖中 10／11px 的刻度數字與單位作廢）。(5) 異常標記經操作者清除後以劃線呈現並保留至期滿（回復後 30 秒）才消失，不是點擊即消失。(6)（2026-10-17，T073／T077 裁決）推擠式 Copilot 面板只在 ≥ 1366px（自訂 screen `desk`）出現、寬 348px，< 1366px 一律 bottom-sheet（閒置單列非 modal、進行中／完成／失敗才 modal）；走勢線只畫單秒合併比一條（y 自 0、離群釘頂、無效秒斷線），刻度上 0 到液位為實心液柱，另有最高水位短線與 1:1 錨點；(5) 的「清除」改稱「確認」（Check 圖示），確認入口為側欄異常列、鍵盤 `x` 與手機覆蓋層；卡片上的異常 pill 不可互動（落在點即選台區域內，誤觸不可逆）；診斷 chip 以「AI：」起頭（「AI：嚴重度」／「AI：嚴重度 · 快取」／「AI 失敗」），4px 方角、無圖示。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
