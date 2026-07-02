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
