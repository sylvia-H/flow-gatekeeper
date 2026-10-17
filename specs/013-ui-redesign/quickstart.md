# Quickstart：013 驗收劇本

**前置**：`docker compose up -d`（Redis、Mongo）→ `pnpm --filter api seed` → 三個視窗 `pnpm --filter api start:dev`、`pnpm --filter worker start:dev`、`pnpm --filter web dev` → `http://localhost:5173`。worker 需有效 `GEMINI_API_KEY` 才能走完診斷場景（場景 5–7、16）。截圖劇本需本機 Playwright Chromium（路徑由 `PLAYWRIGHT_CHROMIUM` 指定，預設找 `~/AppData/Local/ms-playwright/chromium*`）。

自動檢查：`pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test`（SC-010）；`impeccable detect --json src index.html` 與 `detect --json http://localhost:5173/`（SC-003；偵測器的過小字級門檻為 11px，另以場景 11 人工抽查 < 12px）。

**五個驗收 viewport**：1366×768、1440×900、1024×768、768×1024、390×844。

| # | 場景 | 操作 | 預期（對應 SC） |
|---|---|---|---|
| 1 | 首屏與淺色預設 | 清掉 localStorage 後載入 | 淺色主題；首屏是監控台；背壓 strip 的比值不捲動可見（SC-001） |
| 2 | 主題切換與面板偏好 | 點主題切換 20 次；重新整理。再選一台 → 手動收合 Copilot 面板 → 重新整理 → 選另一台 → 按診斷 | 每次 1 幀內換裝、無白屏、版面不位移；重整後主題保留（SC-007）。手動收合後重整再選台，面板維持收合；按診斷後面板展開，再選台會自動展開（偏好已清除）；取消選取時面板收合（取消選取只走 Escape 最後一層：第一次 Escape 收合面板、不寫偏好，第二次才取消選取；再點已選卡片不會取消選取）。390×844 下以收合鈕或 Escape 收合 bottom-sheet 後皆出現 32px peek 條（選取機台名稱；該台有診斷狀態時另附狀態 chip，如「AI 失敗」，未診斷時不顯示 chip——T073 第四輪「AI 診斷」前綴改 sr-only），點擊即展開並清除偏好；取消選取後 peek 條完全隱藏（FR-033） |
| 3 | 五 viewport × 兩主題 | 跑截圖劇本 `node apps/web/scripts/screenshots.cjs --viewports` | 10 張截圖（面板展開）逐項檢查：無溢出、無重疊、無橫向捲動、比值可見（SC-001、SC-004）；劇本輸出每張 `.machine-card` 在 hover／選取／critical 脈動前後的 bounding rect，差值皆為 0（SC-004） |
| 4 | 背壓與拓樸在高頻下 | mock 20 ms 跑 60 秒，開 DevTools Performance | 每秒提交 ≤ 更新率；走勢線每秒更新一次；比值為 60 秒視窗值、液位線位置與比值刻度相符；連線粗細隨 throughput；reduced-motion 與手機寬度下無流動（SC-005） |
| 5 | 串流漸進解析 | 選壓製機 02 → 診斷 | 骨架隨 token 填入、游標在生成中欄位；「原始串流」可展開；完成後順序為 摘要→建議動作→可能原因→證據，證據預設 2 筆、相同來源與摘錄者合併為 `×N`，完成 meta 顯示時間與耗時，嚴重度色條（US4） |
| 6 | 快取命中 | 對同一台再診斷 | 結果整塊出現（不逐欄填入；送出到完成約 1 秒內骨架維持全空佔位）；`快取 · N ms` 大字，下方同刻度兩條耗時對比橫條「快取／上一次」（T073 B；只有一筆紀錄時不畫橫條）（SC-008 之一） |
| 7 | 失敗與重試 | 停掉 worker 後診斷，或填無效 key | 人類可讀分類錯誤、重試可用、中斷前推理以原始串流保留（不顯示骨架） |
| 8 | 異常 latch | 等 mock 尖峰：壓製機 02 critical → healthy | 卡片與側欄摘要列保留標記 30 ± 1 s（自回復起算）；摘要列確認鈕（Check 圖示）、聚焦卡片按 `x` 或手機異常覆蓋層確認 → 兩處同時改為劃線（摘要列附「（已確認）」）、期滿一起消失；卡片上的標記 pill 不可互動（點它等於點卡片＝選台，T073 第三輪）；文案（T073 第四輪 `latchText`）仍異常為「嚴重 · 進入 N 秒前」（頭幾秒為「剛進入」）、回復後為「曾嚴重 · N 秒前回復」（頭幾秒為「剛回復」）；期間再異常則以最新等級重置；已劃線的 warning 升為 critical 時恢復未確認；Pause 期間標記凍結顯示，恢復後依實際經過時間判定（Pause 期間計入，已滿 30 秒者立即消失）（SC-009） |
| 9 | 事件流 | 觀察 oven-04 反覆 warning（中間夾回復正常） | 同機台同嚴重度事件在自首筆起算的 60 秒固定窗內合併成一列並顯示 ×N 與起訖時間 `HH:mm:ss–HH:mm:ss`、該列移到頂端，滿窗另起新列（T073 E 裁決，原「相距 ≤ 10 s」滑動窗）；「回復正常」事件同樣合併；點擊事件列項選取該台；時間為 24 小時制 |
| 10 | 鍵盤 | 只用鍵盤：`/`→輸入 press→Enter→`d`→Escape→Escape；聚焦帶異常標記的卡片按 `x`；`?` | Enter 選取後焦點移到壓製機 02 卡片，接著按 `d` 觸發診斷（不被輸入欄守門擋下）；整條流程 ≤ 10 次按鍵；5 張卡片 5 個 Tab 停駐點；`x` 使標記劃線；說明層可開關；IME 組字 Enter 不選取；Escape 每次只關一層（SC-014） |
| 11 | 對比與字級抽測 | 兩主題各 30 處（徽章、單位、計數、時間戳、chip、事件列項）以 DevTools 或 `impeccable detect` 的 low-contrast 規則 | 100% ≥ 4.5:1；無 < 12px 功能性文字（SC-003、SC-006） |
| 12 | 文案 | 全站巡一遍 | 無英文 UI 標籤（例外同 FR-038：machine id、job id、技術單位（含 px）、`Mock`、`AI`、`WS`、佇列名 `diagnosis`、產品名 flow-gatekeeper、AI 回覆）（SC-013） |
| 13 | README 截圖 | `node apps/web/scripts/screenshots.cjs --readme` | 產出 12 張功能（light）＋ dark ＋ 拓樸，共 14 張，與介面一致（SC-012） |
| 14 | critique 重跑 | `/impeccable critique`（雙 agent） | ≥ 30/40 且 specificity 為「為本產品而作」（SC-002） |
| 15 | 真實來源回補 | 全文搜尋 `design-spec.md`、`refs/` | 每處已改寫或標示歷史（豁免：`specs/` 與 `docs/*-research-review*.md` 歷史工件）；憲章視覺條目與品質門檻段指向 PRODUCT.md + DESIGN.md、版本遞增；PRODUCT.md 已反映改版後現況（SC-011） |
| 16 | 三機制同輪可見 | 依 README 改寫後的 22 秒 demo 劇本，在 1440×900、面板不收合下：載入 → 選台 → 診斷（觀察串流）→ 完成後再診斷同一台 | 同一輪操作中依序找到背壓比值（液位線）、串流中逐步填入的結果骨架、快取命中的耗時對比，三項皆在首次操作找到（SC-008） |

**finish review**：`impeccable-finish-reviewer` 對照 `apps/web/.impeccable/surfaces/src-app-vue.md` 與 `assigned.html`；修完 material fixes 後 `impeccable-documenter` 重寫 `apps/web/DESIGN.md` 與 sidecar。

## 驗收總表（T077，2026-10-17）

**環境**：HEAD `1e137df`＋工作樹內 T075 進行中的行為保持重構（`useMediaQuery`／`useFocusTrap` 抽出，未 commit）；api（`MOCK_TELEMETRY_INTERVAL_MS=5`）、worker（真 Gemini）、web dev server 皆沿用已在跑的行程。驗收以 playwright-core 1.64.1＋`chromium_headless_shell-1243`（headless，顯示器更新率實測 60 Hz）自動操作與量測；每個測試頁都擋掉 Vite HMR 的 WebSocket（只放行 app 的 `/ws`），避免重構中途的熱更新換掉模組（第一次場景 4 量測即因熱更新出現 `useMediaQuery is not defined` 而作廢重跑）。量測期間 api 曾自行重啟一次（PID 變更，約 4 秒斷線），受影響的那輪場景 4 已重跑。證據檔在 session scratchpad `t077/`（下稱 `t077/`），腳本在 `t077js/`。**Gemini 實際呼叫 1 次**（場景 5；場景 6／16 的第二次診斷命中快取；場景 2、7、10、11、12 以 `page.route` 攔 `POST /diagnoses`＋`/ws` 注入事件，不打 Gemini）。

| # | 場景 | 結果 | 證據 | 日期 | 備註 |
|---|---|---|---|---|---|
| 1 | 首屏與淺色預設 | 通過 | `t077/s01-*.png`、`s01-s02-all.json`、`s01b-panel-open.json` | 2026-10-17 | 乾淨 context 五個 viewport：`data-theme="light"`、`fg.theme` 未寫入、首屏為拓樸、無橫向捲動、比值在視窗內（5.4–5.7）。另驗 SC-001 的 10 種組合（五 viewport × 兩主題 × 選台後面板展開）：比值皆在視窗內且未被面板／sheet 蓋住（`elementFromPoint` 命中比值本身） |
| 2 | 主題切換與面板偏好 | 通過 | `t077/s01-s02-s2.json`、`s02-pref-1440.png`、`s02-peek-390.png`、`s02-peek-chip-390.png` | 2026-10-17 | 連切 20 次：每次 click 同步換 `data-theme`，第一個 rAF 時實際繪製底色已是目標主題（dark `rgb(22,29,35)`／light `rgb(221,227,232)`，0 次白底），卡片／stage／strip／aside／header 的 rect 位移 0 件；重整後 light、dark 皆保留。偏好流程 10 步全符合（手動收合寫 `manuallyCollapsed:true`→重整選台維持收合→按診斷展開並寫 `false`→再選台自動展開→Escape 收合不寫偏好→Escape 取消選取）。390：收合鈕／Escape 收合皆出現 32px peek 條（貼底），點擊展開並清偏好，取消選取後隱藏；診斷失敗後 peek 條附「AI 失敗」chip。預期已依 T073 第四輪裁決更新（未診斷時無 chip、取消選取只走 Escape） |
| 3 | 五 viewport × 兩主題 | 通過（捲軸問題已修） | `t077/viewports/*.png／*.json`（`screenshots.cjs --viewports`）、`t077/s03b-scrollbar.json`、`s03b-1366-strip150.png` | 2026-10-17 | 10 張 × overflow／search／pulse／hover／selected 全 ✓，layout shift 與橫向溢出 0 件、0 項 skipped（另有 `shots-r4` 同結果）。**已修（2026-10-17 主 session 裁決：推擠式面板 360 → 348px，含 10px 捲軸時內容寬 710 ≥ 708，完整版 Chrome 1366×768 實測事件流 150／360px 皆維持三欄，`t077js/s03c.cjs`）。原發現：**以完整版 Chrome（`chromium-1243`、不帶 `--hide-scrollbars`，捲軸 10px）在 1366×768、推擠式面板展開時，事件流**預設 150px** 即讓拓樸捲動區出現垂直捲軸、`contentRect` 698px < 708px，拓樸翻成 `stacked` 單欄（首屏只見 1.5 台）；1440×900 仍 `row`。headless 截圖沒有捲軸所以看不到。交主 session 決定（T062 候選：面板 360→348、或 `scrollbar-gutter: stable` 搭配門檻微調） |
| 4 | 背壓與拓樸在高頻下 | 通過 | `t077/s04-paced20.json`、`s04-native.json`、`s04b-motion.json`、`s04-*-end.png` | 2026-10-17 | **20 ms、60 秒**：api 設定為 5 ms 且不得重啟，改以 Playwright WS 代理把伺服器批次節流成每 20 ms 送 1 批（每批 5 點，實送 3 129 批、多出的丟棄）。顯示器更新率（rAF）60–61/s（實測 60.0 Hz，headless）；**每秒提交（有 DOM 變更的幀）48–51/s、平均 49.9，60 秒中 0 秒超過更新率**；strip「每秒批次」49–50；合併比 5.0–5.1 全程 > 1；走勢線每秒更新 1 次；液位線位置與比值／60 的差 ≤ 0.08%；連線 `data-speed` mid／fast、粗細 5／6.5／8 隨產出量變化。**原生頻率對照**（api 5 ms，Windows 計時器實際每秒 72–87 批）：rAF 53–61/s（實測 56.7 Hz，機器同時有其他負載）、每秒提交 42–58/s 平均 49.4，0 秒超過 rAF；合併比 7.7–9.8。reduced-motion：連線 `data-speed="none"`、無流動動畫（僅 0.01ms 粗細 transition）；390 寬：連線垂直、`none` |
| 5 | 串流漸進解析 | 通過 | `t077/s05-s06-s16.json`、`s05-streaming-0..3.png`、`s05-done.png` | 2026-10-17 | 真 Gemini 6.9 s：骨架五欄依 token 由 missing→streaming→complete，游標只在生成中欄位（summary→likelyCauses→suggestedActions→evidence）；「原始串流」可展開（1 606 字）；完成順序 摘要→建議動作→可能原因→證據；證據預設 2 筆＋「還有 2 筆」（展開 4 筆）、合併列 `×5`；meta「完成 13:51:45 · 6.9 s」；色條 `data-severity="warning"` |
| 6 | 快取命中 | 通過 | `t077/s05-s06-s16.json`、`s06-done.png` | 2026-10-17 | 同台再診斷（等回復正常、簽章相同）：`ai/done cached:true`、0 token，結果整塊出現（約 1 s 內骨架全空佔位，無逐欄填入）；`快取 · 947 ms` 大字＋耗時對比橫條（快取 947 ms 13.79%／上一次 6.9 s 100%）。預期已依 T073 B 更新 |
| 7 | 失敗與重試 | 通過 | `t077/s07.json`、`s07-midstream.png`、`s07-failed.png`、`s07-http503.png` | 2026-10-17 | 未停 worker：以假 jobId＋`/ws` 注入 `job/status active`→3 個 `ai/token`→`ai/error provider_error`，等同串流中途失敗：chip「失敗」、可讀錯誤「無法連線 AI 服務，請稍後重試。」、重試鈕可用（按下再送出 POST）、「原始串流（中斷前）」預設展開保留半截 JSON、不顯示骨架；HTTP 503 對照：「診斷佇列暫時無法使用，請稍後再試」＋重試 |
| 8 | 異常 latch | 通過 | `t077/s08.json`、`s08-struck.png`、`s08-paused.png` | 2026-10-17 | 以 WS 代理改寫 press-02／oven-04 遙測使計時可重現：標記保留 **30.23 s**（自客端收到回復批次起算），期間卡片 rect 不變；鍵盤 `x` 確認後卡片 pill 劃線（`line-through`）＋摘要列 `data-struck`「（已確認）」，兩處同時於 30.31 s 消失；回復 10 s 後再進入 warning → 以最新等級（warning）重置，自第二次回復 30.25 s 消失；已確認的 warning 升 critical → `data-latch="critical"`、劃線解除；暫停 28 s（回復後 33.7 s 恢復）期間標記凍結（文字停在「曾嚴重 · 5 秒前回復」、暫停橫幅可見），恢復後 5 ms 內消失。文案：「嚴重 · 剛進入」→「曾嚴重 · 剛回復／N 秒前回復」。預期已依 T073 第三、四輪裁決更新（pill 不可互動、`latchText` 時態） |
| 9 | 事件流 | 通過 | `t077/s09.json`、`s09-events-20s.png`、`s09-events-end.png` | 2026-10-17 | 自然 mock 75 秒：oven-04 警告在 60 秒固定窗內累計到 ×27（`14:00:42–14:01:41`），滿窗後另起新列（`14:01:43–…`）；有更新的列移到頂端；「回復正常」列同樣合併；點事件列選取 oven-04；時間 24 小時制（`14:0x`）。預期已依 T073 E 裁決更新（60 秒固定窗＋起訖） |
| 10 | 鍵盤 | 通過 | `t077/s10.json` | 2026-10-17 | `/`→`press`→Enter→`d` 共 **8 鍵** 觸發診斷（Enter 後焦點在壓製機 02 卡片，`d` 未被輸入欄守門擋下，POST 1 次）；Escape 收合面板、再 Escape 取消選取；Tab 走完全頁 5 張卡片各 1 個停駐點（卡片內診斷鈕不佔停駐點）；`x` 使卡片與摘要列劃線；`?` 開關說明層、工具列說明鈕亦可開；說明層＋面板開著時 Escape 依序只關說明層→面板→選取；組字中 Enter（`isComposing`、keyCode 229）不選取，輸入欄中按 `d` 只是輸入字元；390 compact：`/` 開覆蓋式搜尋並聚焦、Escape 只關覆蓋 |
| 11 | 對比與字級抽測 | 通過 | `t077/s11-s12.json`、`s11-*.png`、`detect-src.json`、`detect-url.json` | 2026-10-17 | 每主題 11 個畫面狀態（監控、選台、串流、完成、失敗、暫停、說明層、1024 閒置 sheet、390 監控／異常覆蓋層／完成），每主題 1 624 個可見文字元素（含 230 個 pill／badge／chip、1 480 個等寬數值／時間戳／單位）逐一以合成背景計算：**< 4.5:1 為 0**（light 最低 4.75、dark 最低 5.58）；**< 12px 功能性文字 0**。`impeccable detect --json src index.html` → `[]`；live URL 只有契約允許的格線 `codex-grid-background`（advisory） |
| 12 | 文案 | 通過 | `t077/s11-s12.json`（`englishUnique`） | 2026-10-17 | 同上 22 個畫面的可見文字與 `aria-label`／`title`／`placeholder`：英文只剩 machine id、job id、單位（mm/s、u/min、說明層的 px）、`Mock`、`AI`、AI 回覆（原始串流 JSON）。另有 rail 品牌字樣與文件標題「flow-gatekeeper」（產品名，非 UI 標籤；FR-038 例外清單已補列產品名、px 與佇列名 `diagnosis`） |
| 13 | README 截圖 | 通過 | `docs/screenshots/` 14 張（commit `1e137df`）、T070 紀錄；比對 `t077/s06-done.png` | 2026-10-17 | 14 張於 2026-10-17 T073 四輪修正後以 `--readme` 單輪產出（14／14，Gemini 1 次＋快取 2 次）；本次未重跑（避免第二次 Gemini 呼叫），以同日實拍畫面比對 `copilot-cached.png` 版面與元件一致。合併前若 T075 之後再有可見變更須重拍 |
| 14 | critique 重跑 | 未通過（依使用者裁決結案） | `apps/web/.impeccable/critique/2026-10-17T05-27-46Z__src-app-vue.md` | 2026-10-17 | 四輪趨勢 20→28→29→29→29，最終 **29/40**，未達 ≥ 30；specificity「大體為本產品而作」。使用者 2026-10-17 裁決第四輪為最後一次評分、不再追分（T073） |
| 15 | 真實來源回補 | 通過 | `git grep design-spec`／`refs/`（排除 `specs/`、`docs/*-research-review*`） | 2026-10-17 | 命中處皆為退役標註或歷史段（README、CLAUDE.md、CHANGELOG、PRODUCT.md、指南 §9 整章退役橫幅與各 feature 歷史章、`src` 註解「已退役 design-spec §x」、`docs/design-spec.md` 移轉橫幅）；憲章 1.5.0→1.6.0、Sync Impact Report 記兩處修訂與模板檢查；PRODUCT.md 已依現況更新、無待確認 [推定] |
| 16 | 三機制同輪可見 | 通過 | `t077/s05-s06-s16.json`、`s05-streaming-*.png`、`s06-done.png` | 2026-10-17 | 1440×900、面板不收合、同一輪：載入即見比值 5.9（液位線在、視窗內）→ 選壓製機 02 → 診斷中骨架逐欄填入 → 完成後再診斷命中快取、耗時對比「快取 947 ms／上一次 6.9 s」；三項皆首次操作找到 |

**iOS Safari 虛擬鍵盤（Phase 9 提醒）**：未驗（無 iOS 裝置與模擬器）。替代證據 `t077/ios-substitute.json`、`ios-sub-webkit-search.png`：Playwright WebKit 27.2（`webkit-2359`）以 iPhone 13 參數（390×844、觸控、iOS UA）點搜尋圖示鈕，覆蓋層開啟、`document.activeElement` 為 `INPUT[type=search]`、`aria-expanded="true"`，輸入「烤爐」只剩 oven-04——證明 `nextTick` 後 `focus()` 有執行且輸入可用；iOS 是否因非同步 focus 不跳鍵盤仍須實機確認。

**已知限制（不在驗收 viewport 預設狀態內）**：rail 拉到 420px＋推擠式面板展開＋1366 寬時工具列約 574px 進 compact 形態。

**自動檢查（SC-010）**：`pnpm --filter web test` 64 檔 1 108 則全綠（含工作樹 T075 新增測試）；typecheck／lint 與 `pnpm check` 由 T076 執行。
