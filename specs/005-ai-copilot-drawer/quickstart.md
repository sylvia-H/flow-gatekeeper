# Quickstart — AI Copilot Drawer 驗收指引

驗證 005 端到端可運作。實作細節不在此（見 tasks.md 與各元件）；本檔為可重播的 live 驗收腳本，對齊 spec 的 Success Criteria 與 Acceptance Scenarios。

## 前置

- infra 起：`docker compose up -d`（Redis 7 + Mongo 7），`docker compose ps` 確認健康。
- seed：`pnpm --filter api seed`。
- **Live 驗收陷阱**（沿用 004 記憶）：`apps/api/.env` 的 `WS_AUTH_SECRET` 需清空，讓 dev 訂閱免 token。
- LLM：`apps/worker/.env` 需可用的 `GEMINI_API_KEY`（或以既有 mock provider）。

## 啟動（4 個終端）

```powershell
# infra 已起
pnpm --filter api start:dev       # Gateway/API :3000
pnpm --filter worker start:dev     # 獨立 worker process
pnpm --filter web dev              # :5173
```

## 純函式／store 單元測試（不需 infra）

```powershell
pnpm --filter web test
```

預期涵蓋（research R9 / data-model 轉移表）：

- `copilotReducer`：waiting→active→completed（含 `cached:true`）、`ai/token` 依 `seq` 保序 append、`ai/error`→failed、`job/status:failed`→failed。
- `isStaleJobEvent`：`jobId` 不符目前 active → 忽略（FR-011）。
- `progressLabel`：`null`→indeterminate、數值→`N%`（FR-004）。
- 去重：同機台 `active` 期間 `canDiagnose` 為 false（FR-008）。

## Live 驗收（對應 Acceptance / SC）

開 `http://localhost:5173`，確認第一屏監控台已連線（TopBar 綠點 Connected）。

| # | 操作 | 預期 | 對應 |
|---|------|------|------|
| AC1 | 選一台機台（sidebar 或卡片），看桌機右側常駐 drawer | drawer 顯示該台 idle 摘要與 Run diagnosis；未選取時 Diagnose disabled | FR-002/FR-014, Q5 |
| AC2 | 按 Diagnose | drawer <1s 進入 active、顯示機台識別與進度，不等 AI 文字 | SC-001, US1-1 |
| AC3 | 觀察串流面板 | AI 推理文字逐段出現＋caret，不等 done | SC-002, US1-2 |
| AC4 | 觀察進度條 | 依真實階段推進經過 20/40/60/80（非只有 0→100）；首刻未帶值時 indeterminate | SC-008, FR-018/FR-004 |
| AC5 | 等待 done | 渲染 severity badge／summary／likely causes／evidence／suggested actions 五區塊；串流文字保留但收合 | SC-003, US1-3, FR-006 |
| AC6 | 同機台 active 期間再按 Diagnose | 送出被禁用/忽略，不建第二任務 | SC-004, US2-1, FR-008 |
| AC7 | 對同機台同類再診斷（第二次） | 命中快取時顯示 Cached badge 且明顯快 | SC-004, US2-2, FR-009 |
| AC8 | A 台 active 時切到 B 台診斷，再切回 A | 各台狀態獨立、切回還原 A 的呈現，不混淆 | FR-010, US2-3 |
| AC9 | 暫停 worker 後對某台 Diagnose（或注入錯誤） | drawer 進 failed、顯示可讀錯誤＋Retry；恢復後 Retry 可完成 | SC-005, US3, FR-007 |
| AC10 | active 期間手動斷線重連（新 clientId） | 該台 active 標中斷/failed＋Retry，不卡 active 假象 | FR-012, R7 |
| AC11 | 四 viewport（寬桌機/桌機/平板/手機390×844） | 桌機常駐右欄、手機 bottom-sheet；皆不溢出、不遮頂欄 | SC-006, FR-015 |
| AC12 | 高頻遙測期間跑一次診斷 | 遙測 UI 仍流暢、BackpressureBadge 比值不崩，診斷串流不干擾 | SC-007, FR-017 |

## 進度里程碑驗證（FR-018，worker）

- 於 worker log 或前端進度條觀察單次診斷經過 `0→20→40→60→80→100`；`40` 對應開始呼叫 LLM、`60` 對應首個 token、`80` 對應 schema 解析成功。
- 快取命中路徑進度直接跳 `100`（AC7）。

## 回寫

驗收通過後，於 tasks.md 對應 Polish 任務回寫結果（AC1–AC12 通過與否），保留可重播 demo（憲章「可重播驗收」）。

### Live 驗收結果（2026-07-02，Playwright headless + Edge `msedge` channel）

完整 stack：docker（Redis 7 + Mongo 7）+ `pnpm --filter api seed` + API :3000 + worker（真實 `GEMINI_API_KEY`）+ web :5173。

| # | 結果 | 佐證 |
|---|------|------|
| AC1 | ✅ PASS | 未選取時 Diagnose disabled；選台後桌機右欄 drawer 顯示 idle 摘要 + Run diagnosis |
| AC2 | ✅ PASS | 按 Diagnose → drawer **341ms** 進入 active（<1s，SC-001） |
| AC3 | ✅ PASS | 串流文字於 done 前逐段成長（取樣成長 8 次、最終 791 字）+ caret |
| AC4 | ✅ PASS | 進度取樣到 `處理中…→40%→60%`（真實階段里程碑，非只 0→100） |
| AC5 | ✅ PASS | done 後五區塊（summary/severity/likely causes/evidence/suggested actions）齊；串流文字保留且預設收合，展開仍在 |
| AC6 | ✅ PASS | 該台 active 期間 TopBar Diagnose disabled（去重，FR-008） |
| AC7 | ✅ PASS | 同機台第二次診斷顯示 **Cached** badge（178ms，明顯快，FR-009） |
| AC8 | ✅ PASS | 切到另一台為 idle、切回還原原台狀態（多台獨立，FR-010） |
| AC9 | ✅ PASS | 壞金鑰注入 worker 失敗（Gemini 400 API_KEY_INVALID，重試耗盡）→ drawer 顯示可讀錯誤 + Retry；還原 worker 後 Retry → completed（FR-007） |
| AC10 | ✅ PASS | active 期間殺 API→重啟→前端以新 clientId 重連 → 該台標「連線中斷」failed + Retry（FR-012） |
| AC11 | ✅ PASS | 四 viewport（1366/1440/768/390）皆無水平溢出；桌機右欄常駐、手機 bottom-sheet 且頂欄未被遮住 |
| AC12 | ✅ PASS | 診斷期間 BackpressureBadge 比值維持 12:1（遙測 rAF 批次未被診斷串流破壞，FR-017/SC-007） |

> 觀察（非阻斷）：AC9 的可讀錯誤目前直接顯示 provider 原文（Gemini 400 訊息），符合 FR-007「非原始堆疊之可讀訊息」；未來可加一層對應更精簡的使用者訊息（polish，non-goal）。
