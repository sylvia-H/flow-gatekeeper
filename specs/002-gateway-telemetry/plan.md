# Implementation Plan: 即時 Gateway、遙測產生器與 MongoDB 歷史層

**Branch**: `002-gateway-telemetry` | **Date**: 2026-06-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-gateway-telemetry/spec.md`

## Summary

在 001 的骨架與契約之上，讓系統第一次「動起來」：`apps/api` 啟動 NestJS HTTP server 並掛上
**原生 `ws`** Gateway（path `/ws`），支援連線生命週期、心跳（客戶端 ping→pong + 伺服器端
主動探活）、機台訂閱，並把 mock producer 每 10–50ms 產生的遙測**只推給訂閱者**；同時把
**全部機台**每個 tick 的遙測全量、與訂閱解耦地（fire-and-forget 批次）寫入 MongoDB 時序
歷史（可調 TTL），並在機台**轉入** warning/critical 時寫 errorlog，另附維修紀錄 seed。

技術取捨並非本 plan 自由決定，而是憲章（`.specify/memory/constitution.md`）與實作指南
（`docs/Flow-Gatekeeper-SDD-完整實作指南.md` §7）已固定的既有約束。本 feature 的範圍**僅止於**
遙測／訂閱／連線生命週期／歷史落地；job/status 與 AI 串流的實際轉發留待 003，本 feature 僅
保留 Gateway「對單一連線推送任意 payload」的 `send(clientId, payload)` 作為銜接點（FR-015）。

## Technical Context

**Language/Version**: TypeScript 5.6（strict），Node 24（本機與 CI 對齊），ESM（`"type": "module"`）

**Primary Dependencies**: NestJS 10（api）、原生 `ws` 8（Gateway，掛 NestJS HTTP server，
path `/ws`，**非 Socket.IO**）、`mongodb` 官方驅動（時序歷史與 errorlogs/maintenanceRecords）、
`@flow-gatekeeper/contracts`（沿用並**擴充**通訊契約）、Vitest（測試）。
**本 feature 需新增的相依**（apps/api）：`mongodb`、`@nestjs/platform-express`（`NestFactory.create`
所需 HTTP 平台、取得可交給 `ws` 的 server）、`tsx`（devDep，跑 seed 腳本）、`dotenv`（載入
`apps/api/.env`，與 worker 一致）。

**Storage**: MongoDB 7（`docker compose`）——`telemetry`（time-series，`timeField: timestamp`、
`metaField: metadata`、`expireAfterSeconds = TELEMETRY_TTL_SECONDS`）、`errorlogs`（index
`{ machineId:1, timestamp:-1 }`）、`maintenanceRecords`（index `{ machineId:1, performedAt:-1 }`）。
Redis 在本 feature **不使用**（BullMQ/cache/PubSub 留待 003）。

**Testing**: Vitest。至少一支實際（非 no-op）純函式單元測試（FR-016），覆蓋「依訂閱過濾遙測」
與「errorlog 僅於狀態轉換時記錄一次（去重）」其一或兩者。

**Target Platform**: 開發者本機（Windows / PowerShell 為主），執行期 Node 24；手動驗收以
命令列 WebSocket 客戶端（`wscat`）或最小整合腳本進行（前端 rAF 端到端整合留待 004）。

**Project Type**: pnpm monorepo — 本 feature 重心在 `apps/api`（worker/web 不在範圍）。

**Performance Goals**: 遙測 cadence 10–50ms（`MOCK_TELEMETRY_INTERVAL_MS`，預設 50）；推送只
送訂閱者；持久化與推送**解耦**（fire-and-forget 批次 `insertMany`），落地進行時推送節奏不被
可觀察拖慢（SC-008）；伺服器端心跳間隔 `WS_HEARTBEAT_MS`（預設 15000）。

**Constraints**: 即時通道固定原生 `ws`（path `/ws`），MUST NOT Socket.IO（憲章 IV）；歷史
MUST 落地 MongoDB，MUST NOT 只放 Redis（憲章 VII）；errorlog **僅於狀態轉換**寫入、同狀態
不重複（FR-011）；落地範圍涵蓋**全部機台、與訂閱無關**（FR-009，訂閱只過濾推送）；新增的
控制訊息（system/connected、machine/subscribed、pong、system/unauthorized）MUST **先進契約再
實作**（contract-first，憲章 II/III）；連線／斷線／授權失敗／落地錯誤四類事件 MUST 記錄
（FR-017，Nest `Logger`），結構化 metrics／tracing 不在範圍；strict TS、無 `any` 擴散。

**Scale/Scope**: ~5 台固定示範機台；遙測每 tick 全量落地；多連線並行（demo 至少 2）。新增
1 個 ws Gateway、1 個 mock producer、1 個 history service、1 個 seed 腳本，並擴充 contracts +
asyncapi 的控制訊息。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 與本 feature 的關係 | 狀態 |
|------|--------------------|------|
| I. 規格驅動開發 | 走完整 Spec Kit 流程，於 `002-gateway-telemetry` branch（從 `develop`）；不手貼 code 又跑 implement | ✅ PASS |
| II. 單一真實來源 | 通訊一律依 `packages/contracts` + `asyncapi.yaml`；本 feature 用到的控制訊息**先擴充契約與 AsyncAPI** 再實作，MUST NOT 在 Gateway 內散落未入契約的訊息結構 | ✅ PASS（含契約擴充任務） |
| III. 契約優先與全棧型別安全 | 新增 event/payload 先改契約；事件型別沿用 001 的 TS 型別來源（與 001 一致，runtime 驗證僅用於必要處）；strict TS、無 `any` | ✅ PASS |
| IV. 即時通道架構紀律 | 後端原生 `ws` 掛 NestJS HTTP server（path `/ws`）；高頻遙測在後端為「只送訂閱者」，前端 rAF batching 屬 004；本 feature 不涉及 worker emit / Pub-Sub（留待 003） | ✅ PASS |
| V. AI 診斷紀律 | 本 feature 不呼叫 LLM、不做 cache/lock；`DiagnosisResult` 契約已就緒，AI 行為留待 003 | ✅ PASS（N/A 行為層） |
| VI. 祕密與設定衛生 | 沿用 001 `.env.example`／`.gitignore`；本 feature 不新增祕密，dev 授權用 `WS_AUTH_SECRET` | ✅ PASS |
| VII. 資料可追溯性 | telemetry/errorlogs/maintenanceRecords 全部落地 MongoDB；Redis 不作為歷史來源 | ✅ PASS（本 feature 的核心交付） |
| 測試門檻 | 至少一支實際單元測試（訂閱過濾／errorlog 去重）；其餘 package 維持 `--passWithNoTests` | ✅ PASS |
| 可重播驗收 | mock telemetry producer（決定性規律、含週期性尖峰）+ maintenanceRecords seed 即可重播 demo | ✅ PASS |
| Phase 化遞交 | implement 將以 tasks.md 的 phase 為遞交單位，逐 phase 勾選並 commit | ✅ PASS（流程約束） |

**Gate 結論**：無違規，無需 Complexity Tracking。所有「未實作」項目（worker emit、Pub/Sub、
AI、前端整合）皆為憲章與 spec 明確劃歸後續 feature 的範圍切割，非繞過原則。控制訊息以
「先入契約」方式處理，符合 contract-first。

## Project Structure

### Documentation (this feature)

```text
specs/002-gateway-telemetry/
├── plan.md              # This file
├── research.md          # Phase 0 output（技術決策）
├── data-model.md        # Phase 1 output（collection / 連線狀態 / 控制訊息）
├── quickstart.md        # Phase 1 output（可重播驗收腳本）
├── contracts/           # Phase 1 output（控制訊息契約規格）
│   └── control-messages.contract.md
├── checklists/
│   └── requirements.md  # /speckit-specify 既有產物
└── tasks.md             # /speckit-tasks 產物（非本指令建立）
```

### Source Code (repository root)

```text
flow-gatekeeper/
├── asyncapi.yaml                       # ★ 擴充：新增 system/connected、machine/subscribed、
│                                       #    ping/pong、system/unauthorized 控制訊息
├── packages/contracts/src/
│   ├── events.ts                       # ★ 擴充：控制訊息型別（client→server / server→client）
│   └── index.ts                        # re-export（沿用）
└── apps/api/
    ├── package.json                    # ★ 新增 mongodb / @nestjs/platform-express / tsx / dotenv
    │                                   #    並新增 "start:dev" 與 "seed" script
    ├── src/
    │   ├── main.ts                     # ★ 改寫：NestFactory.create → listen → gateway.attach(httpServer)
    │   ├── app.module.ts               # ★ 新增：彙整下列 module（DI 注入）
    │   ├── modules/
    │   │   ├── config/                 # 環境設定（dotenv 載入 + 型別化讀取）
    │   │   ├── websocket/
    │   │   │   └── monitoring.gateway.ts   # ★ 原生 ws server；連線/訂閱/心跳/推送/send()
    │   │   ├── telemetry/
    │   │   │   └── mock-telemetry.service.ts  # ★ 決定性 mock producer（含尖峰）
    │   │   └── history/
    │   │       └── history.service.ts  # ★ ensureCollections + persistBatch（fire-and-forget）
    │   ├── scripts/
    │   │   └── seed.ts                  # ★ maintenanceRecords seed（tsx 執行）
    │   └── lib/
    │       ├── subscription-filter.ts   # ★ 純函式：依訂閱過濾 points（可單測）
    │       ├── subscription-filter.test.ts
    │       ├── errorlog-transition.ts   # ★ 純函式：狀態轉換偵測（errorlog 去重，可單測）
    │       └── errorlog-transition.test.ts
    └── (tsconfig.json / tsconfig.build.json / .env 沿用 001)
```

**Structure Decision**: 沿用 001 的 pnpm monorepo 佈局，本 feature 幾乎只動 `apps/api` 與
`packages/contracts`（+ `asyncapi.yaml`）。Gateway／producer／history 拆成獨立 NestJS provider
以利 DI 與測試；**把「依訂閱過濾」與「狀態轉換偵測」抽成 `lib/` 下的純函式**，讓 FR-016 的
單元測試不需啟動 ws/Mongo 即可驗證決定性邏輯。`send(clientId, payload)` 為 Gateway public
方法，作為 003 AI relay 的銜接點（本 feature 不實作 relay 本身）。

## Complexity Tracking

> 無 Constitution Check 違規，本節不適用。
