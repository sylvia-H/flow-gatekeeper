# Quickstart：013 驗收劇本

**前置**：`docker compose up -d`（Redis、Mongo）→ `pnpm --filter api seed` → 三個視窗 `pnpm --filter api start:dev`、`pnpm --filter worker start:dev`、`pnpm --filter web dev` → `http://localhost:5173`。worker 需有效 `GEMINI_API_KEY` 才能走完診斷場景（場景 5–7、16）。截圖劇本需本機 Playwright Chromium（路徑由 `PLAYWRIGHT_CHROMIUM` 指定，預設找 `~/AppData/Local/ms-playwright/chromium*`）。

自動檢查：`pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test`（SC-010）；`impeccable detect --json src index.html` 與 `detect --json http://localhost:5173/`（SC-003；偵測器的過小字級門檻為 11px，另以場景 11 人工抽查 < 12px）。

**五個驗收 viewport**：1366×768、1440×900、1024×768、768×1024、390×844。

| # | 場景 | 操作 | 預期（對應 SC） |
|---|---|---|---|
| 1 | 首屏與淺色預設 | 清掉 localStorage 後載入 | 淺色主題；首屏是監控台；背壓 strip 的比值不捲動可見（SC-001） |
| 2 | 主題切換與面板偏好 | 點主題切換 20 次；重新整理。再選一台 → 手動收合 Copilot 面板 → 重新整理 → 選另一台 → 按診斷 | 每次 1 幀內換裝、無白屏、版面不位移；重整後主題保留（SC-007）。手動收合後重整再選台，面板維持收合；按診斷後面板展開，再選台會自動展開（偏好已清除）；取消選取時面板收合。390×844 下以收合鈕或 Escape 收合 bottom-sheet 後皆出現 32px peek 條（選取機台名稱與診斷狀態 chip），點擊即展開並清除偏好；取消選取後 peek 條完全隱藏（FR-033） |
| 3 | 五 viewport × 兩主題 | 跑截圖劇本 `node apps/web/scripts/screenshots.cjs --viewports` | 10 張截圖（面板展開）逐項檢查：無溢出、無重疊、無橫向捲動、比值可見（SC-001、SC-004）；劇本輸出每張 `.machine-card` 在 hover／選取／critical 脈動前後的 bounding rect，差值皆為 0（SC-004） |
| 4 | 背壓與拓樸在高頻下 | mock 20 ms 跑 60 秒，開 DevTools Performance | 每秒提交 ≤ 更新率；走勢線每秒更新一次；比值為 60 秒視窗值、液位線位置與比值刻度相符；連線粗細隨 throughput；reduced-motion 與手機寬度下無流動（SC-005） |
| 5 | 串流漸進解析 | 選壓製機 02 → 診斷 | 骨架隨 token 填入、游標在生成中欄位；「原始串流」可展開；完成後順序為 摘要→建議動作→可能原因→證據，證據預設 2 筆、相同來源與摘錄者合併為 `×N`，完成 meta 顯示時間與耗時，嚴重度色條（US4） |
| 6 | 快取命中 | 對同一台再診斷 | 結果整塊出現；`快取 · N ms` 大字與上一次耗時並列（SC-008 之一） |
| 7 | 失敗與重試 | 停掉 worker 後診斷，或填無效 key | 人類可讀分類錯誤、重試可用、中斷前推理以原始串流保留（不顯示骨架） |
| 8 | 異常 latch | 等 mock 尖峰：壓製機 02 critical → healthy | 卡片與側欄摘要列保留標記 30 ± 1 s（自回復起算）；點卡片標記、摘要列清除鈕或聚焦卡片按 `x` → 兩處同時改為劃線、期滿一起消失；相對時間進行中為「進入 N 秒前」、回復後為「已回復 N 秒前」；期間再異常則以最新等級重置；已劃線的 warning 升為 critical 時恢復未確認；Pause 期間標記凍結顯示，恢復後依實際經過時間判定（Pause 期間計入，已滿 30 秒者立即消失）（SC-009） |
| 9 | 事件流 | 觀察 oven-04 反覆 warning（中間夾回復正常） | 相距 ≤ 10 s 的同機台同嚴重度事件合併成一列並顯示 ×N、該列移到頂端；點擊事件列項選取該台；時間為 24 小時制 |
| 10 | 鍵盤 | 只用鍵盤：`/`→輸入 press→Enter→`d`→Escape→Escape；聚焦帶異常標記的卡片按 `x`；`?` | Enter 選取後焦點移到壓製機 02 卡片，接著按 `d` 觸發診斷（不被輸入欄守門擋下）；整條流程 ≤ 10 次按鍵；5 張卡片 5 個 Tab 停駐點；`x` 使標記劃線；說明層可開關；IME 組字 Enter 不選取；Escape 每次只關一層（SC-014） |
| 11 | 對比與字級抽測 | 兩主題各 30 處（徽章、單位、計數、時間戳、chip、事件列項）以 DevTools 或 `impeccable detect` 的 low-contrast 規則 | 100% ≥ 4.5:1；無 < 12px 功能性文字（SC-003、SC-006） |
| 12 | 文案 | 全站巡一遍 | 無英文 UI 標籤（例外：machine id、job id、技術單位、`Mock`、`AI`、`WS`、AI 回覆）（SC-013） |
| 13 | README 截圖 | `node apps/web/scripts/screenshots.cjs --readme` | 產出 12 張功能（light）＋ dark ＋ 拓樸，共 14 張，與介面一致（SC-012） |
| 14 | critique 重跑 | `/impeccable critique`（雙 agent） | ≥ 30/40 且 specificity 為「為本產品而作」（SC-002） |
| 15 | 真實來源回補 | 全文搜尋 `design-spec.md`、`refs/` | 每處已改寫或標示歷史（豁免：`specs/` 與 `docs/*-research-review*.md` 歷史工件）；憲章視覺條目與品質門檻段指向 PRODUCT.md + DESIGN.md、版本遞增；PRODUCT.md 已反映改版後現況（SC-011） |
| 16 | 三機制同輪可見 | 依 README 改寫後的 22 秒 demo 劇本，在 1440×900、面板不收合下：載入 → 選台 → 診斷（觀察串流）→ 完成後再診斷同一台 | 同一輪操作中依序找到背壓比值（液位線）、串流中逐步填入的結果骨架、快取命中的耗時對比，三項皆在首次操作找到（SC-008） |

**finish review**：`impeccable-finish-reviewer` 對照 `apps/web/.impeccable/surfaces/src-app-vue.md` 與 `assigned.html`；修完 material fixes 後 `impeccable-documenter` 重寫 `apps/web/DESIGN.md` 與 sidecar。
