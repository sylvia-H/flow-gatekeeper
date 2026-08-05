# Feature Specification: Monorepo 基礎、共用契約、本機 Infra 與環境設定

**Feature Branch**: `001-foundation-contracts`

**Created**: 2026-06-30

**Status**: Draft

**Input**: User description: "建立 flow-gatekeeper 的 monorepo 基礎、即時通訊契約、環境設定與本機 infra"

## Clarifications

### Session 2026-06-30

- Q: 三個 app（api/worker/web）在 001 要交付到什麼程度？ → A: install + typecheck + build
  通過即可；app 為可編譯的最小骨架，MUST NOT 要求實際啟動或連線，執行期行為留待
  002/003。「build 過卻啟動炸」的工具鏈風險改以一支 smoke 單元測試（斷言 entry module
  能乾淨 import）覆蓋，併入測試門檻，而非以執行期驗收條件存在。
- Q: `packages/contracts` 在 001 要不要包含 BullMQ 任務契約？ → A: 不要，留 003。001 的
  contracts 僅含 6 條 WebSocket 通道事件型別與 `DiagnosisResultSchema`（Zod 單一來源）；
  佇列常數（`DIAGNOSIS_QUEUE`）與 `DiagnosisJobPayload` 等任務契約於 Feature 003 開始時
  再加入。

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」是專案的開發者（含後續 feature 的實作者與 demo 展示時的操作者）。
其價值是：讓任何人 clone 專案後，能用最少步驟把工作區與本機基礎設施跑起來，並讓三端
（web / api / worker）共用同一份通訊契約，作為後續所有 feature 的地基。

### User Story 1 - 一鍵啟動可驗證的工作區與基礎設施 (Priority: P1)

開發者 clone 專案後，能用單一套指令安裝所有 workspace、啟動本機資料服務，並確認整個
工作區型別檢查通過、資料服務可連線。這是其他所有 feature 能開始的前提，也是最小可行
產物（MVP）：沒有它，002 之後無從動工。

**Why this priority**: 沒有可啟動、可驗證的骨架，後續 feature 完全無法進行；這是整個
專案的 root dependency。

**Independent Test**: 在乾淨環境執行安裝指令與啟動資料服務後，工作區型別檢查全數通過、
Redis 與 MongoDB 皆可連線——即可獨立驗收，無需任何後續 feature。

**Acceptance Scenarios**:

1. **Given** 一個乾淨 clone 的專案，**When** 開發者執行工作區安裝指令，**Then** web、api、
   worker、contracts、shared 五個 workspace 全部安裝成功且型別檢查通過。
2. **Given** 已安裝的工作區，**When** 開發者啟動本機資料服務，**Then** Redis 與 MongoDB
   兩個服務皆進入可連線狀態。
3. **Given** 啟動中的資料服務，**When** 開發者執行連線檢查，**Then** 兩個服務都回應健康。

---

### User Story 2 - 三端共用單一通訊契約 (Priority: P2)

後續 feature 的實作者能從單一契約來源 import 所有即時事件與診斷結果的結構與型別，
web、api、worker 三端拿到的是同一份定義，不必各自手寫平行型別。

**Why this priority**: 契約是 002（gateway/telemetry）與 003（job/AI streaming）的共同
依賴；先固定契約，三端才不會在整合期分歧。但它依賴 US1 的工作區骨架先存在。

**Independent Test**: 在 web、api、worker 各寫一支匯入契約的最小檔案並型別檢查，三端皆
能解析同一份事件/結果型別且編譯通過——即可驗收。

**Acceptance Scenarios**:

1. **Given** 契約套件已建立，**When** api 匯入 telemetry 與診斷結果型別，**Then** 編譯通過
   且型別與契約來源一致。
2. **Given** 契約套件已建立，**When** worker 匯入診斷結果驗證器，**Then** 能對一筆結構錯誤
   的資料判定為不合法。
3. **Given** 契約定義的所有即時通道，**When** 對通訊文件執行契約 lint，**Then** 無違規。

---

### User Story 3 - 品質與祕密防護門檻可運作 (Priority: P3)

專案具備自動化檢查與祕密防護：推送時 CI 會跑契約 lint、型別檢查、lint 與測試；本機與
範例設定分離，真正的祕密永遠不會進入版本控制。

**Why this priority**: 提升長期可維護性與安全性，是「展示 SDD/工程紀律」的一部分；但
不是讓專案能跑起來的硬前提，故列 P3。

**Independent Test**: 故意放一個本機設定檔，確認它不被版本控制追蹤；在 CI 觸發一次，確認
契約 lint／型別檢查／lint／測試四道檢查都被執行。

**Acceptance Scenarios**:

1. **Given** 一份本機設定檔存在，**When** 檢視版本控制狀態，**Then** 該檔不被追蹤，只有
   範例設定檔在版本控制內。
2. **Given** 一次 push 或 pull request，**When** CI 啟動，**Then** 契約 lint、型別檢查、lint、
   測試四道檢查皆被執行並回報結果。
3. **Given** 某個 workspace 目前尚無測試，**When** CI 執行其測試步驟，**Then** 該步驟以
   通過收場，不因「無測試」而使 CI 失敗。

### Edge Cases

- 開發者本機未啟動容器執行環境時，啟動資料服務的步驟 MUST 給出可理解的失敗訊息，而非
  靜默卡住。
- 缺少 `redis-cli` / `mongosh` 等選用工具時，仍能透過容器狀態確認服務健康，不阻斷驗收。
- 某個 workspace 尚無實際測試時，測試步驟 MUST 可通過（no-op），不得使 CI 紅燈。
- 通訊文件若違反契約 lint 規則，檢查 MUST 失敗並指出違規位置。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 專案 MUST 提供單一 workspace 安裝指令，一次安裝 web、api、worker、contracts、
  shared 五個 workspace。
- **FR-002**: 五個 workspace MUST 皆可通過型別檢查（strict 型別，無 `any` 擴散）。
- **FR-003**: 專案 MUST 提供本機資料服務（Redis 與 MongoDB）的一鍵啟動方式，啟動後兩者
  皆可連線。
- **FR-004**: 專案 MUST 提供單一通訊契約來源，定義即時通道：machine/subscribe、machine/data、
  job/status、ai/token、ai/done、ai/error。佇列常數與診斷任務 payload 契約 MUST NOT 納入
  本 feature，留待 Feature 003。
- **FR-005**: 契約 MUST 以單一來源同時產生「執行期驗證」與「靜態型別」，MUST NOT 讓兩者
  各寫一份而可能分歧。
- **FR-006**: 通訊契約 MUST 可被 web、api、worker 三端 import 並通過型別檢查。
- **FR-007**: 診斷結果契約 MUST 能驗證一筆資料是否合法，對結構錯誤者判定為不合法。
- **FR-008**: 專案 MUST 有通訊文件並可通過契約 lint。
- **FR-009**: 版本控制 MUST 只包含範例設定檔；真正的本機設定與任何憑證 MUST NOT 被追蹤。
- **FR-010**: CI MUST 於 push / pull request 時執行契約 lint、型別檢查、lint 與測試四道檢查。
- **FR-011**: 任一 workspace 在尚無可測單元時，其測試步驟 MUST 以通過收場（no-op），不使
  CI 失敗。
- **FR-012**: 本 feature 的範圍 MUST 僅止於 docker-compose 與環境設定；資料庫 collection 的
  建立 MUST 留待後續 feature（002）。
- **FR-013**: 三個 app（api/worker/web）在本 feature MUST 僅交付可編譯的最小骨架，MUST 通過
  build 與 typecheck，MUST NOT 要求實際啟動或連線；執行期行為留待 002（gateway）與
  003（worker）。
- **FR-014**: 本 feature MUST 至少提供一支實際（非 no-op）的 smoke／單元測試，覆蓋
  「契約結構驗證」（對結構錯誤的診斷結果判定為不合法）與「entry module 能乾淨 import」
  其一或兩者，以滿足憲章測試門檻並攔截工具鏈啟動期破壞。

### Key Entities *(include if feature involves data)*

- **TelemetryPoint**：單台機台某時刻的遙測資料點，含機台識別、時間、量測值（溫度、振動、
  吞吐、錯誤率）與健康狀態（healthy / warning / critical）。
- **DiagnosisResult**：一次 AI 診斷的結構化結果，含摘要、嚴重度、可能原因、建議行動與佐證。
- **即時通道事件**：machine/subscribe（訂閱）、machine/data（遙測推送）、job/status（診斷
  任務狀態）、ai/token（串流 token）、ai/done（最終結果）、ai/error（錯誤）。
- **環境設定形狀**：以範例設定檔記錄所需的設定鍵（資料服務位址、埠、AI 供應商設定、資料
  生命週期等），不含真實憑證值。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 一位新開發者能在 10 分鐘內，從 clone 到「工作區型別檢查全通過 + 兩個資料
  服務可連線」，且過程不超過 3 個主要指令步驟。
- **SC-002**: 五個 workspace 的型別檢查 100% 通過，0 個 `any` 洩漏的型別錯誤被忽略。
- **SC-003**: web、api、worker 三端各自匯入契約的最小驗證檔皆 100% 編譯通過。
- **SC-004**: 通訊文件契約 lint 0 違規。
- **SC-005**: 本機設定檔在版本控制中被追蹤的數量為 0；範例設定檔存在且被追蹤。
- **SC-006**: CI 單次執行涵蓋 4 道檢查（契約 lint、型別檢查、lint、測試）且全數有結果回報；
  無測試的 workspace 不造成 CI 失敗。
- **SC-007**: 至少 1 支實際 smoke／單元測試存在且通過；三個 app 皆 build 與 typecheck 通過，
  但不以「能啟動」為驗收條件。

## Assumptions

以下技術選型並非本 spec 任意決定，而是專案憲章（`.specify/memory/constitution.md`）與
實作指南已固定的既有約束，於此記錄以界定範圍：

- 套件管理使用 pnpm workspace；monorepo 佈局為 `apps/{web,api,worker}` 與
  `packages/{contracts,shared}`（憲章「技術約束與環境」）。
- 契約以 Zod 為單一來源、型別由 `z.infer` 推導（憲章 Principle III 契約優先）。
- 即時通道一律原生 `ws`，不使用 Socket.IO（憲章 Principle IV）；本 feature 只建立 gateway
  骨架，完整行為留待 002。
- 本機 infra 為 Redis 7 + MongoDB 7，以 `docker compose` 啟動（憲章「技術約束與環境」）。
- 開發者本機具備容器執行環境（Docker Desktop 或等價物）與 Node 20 LTS+。
- 祕密衛生：只提交範例設定檔，不提交任何真實憑證（憲章 Principle VI）。
- 每個 package 至少具備可通過的測試 script（暫無可測單元時為 no-op），且本 feature 至少有
  一支實際 smoke／單元測試（見 FR-014），以滿足憲章「測試門檻」。
- 憲章 Principle VIII「可重播驗收」之於本 foundation feature：因尚無執行期與資料，其「可重播
  demo」即 SC-001 的確定性 bootstrap 序列（clone → 安裝 → typecheck → 啟動 infra → 連線）；
  真正的 seed／mock telemetry producer 自 Feature 002 起提供，故本 feature 不另建 demo/seed
  產物即視為符合該門檻。
