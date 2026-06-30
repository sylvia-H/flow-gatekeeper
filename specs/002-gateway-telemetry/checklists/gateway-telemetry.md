# Requirements Quality Checklist: 即時 Gateway、遙測產生器與 MongoDB 歷史層

**Purpose**: implement 前的正式品質門檻——以「需求的單元測試」驗證 spec 在即時 Gateway／連線
生命週期、遙測落地與可追溯、契約優先（控制訊息）三大面向的完整度、清晰度、一致性與可量測性。
**Created**: 2026-06-30
**Feature**: [spec.md](../spec.md)

**Note**: 本檔測試的是「需求寫得好不好」，不是「程式跑得對不對」。每題問的是 spec 本身是否
完整／無歧義／一致／可量測，而非驗證實作行為。勾選 `[x]` = 該需求面向已確認夠好；未勾且
列於下方「Gate Result」者為**本期刻意接受**（demo 範圍，不阻擋 implement）。

## Requirement Completeness

- [x] CHK001 連線建立需求（指派 clientId + 通知連線端）是否連同通知訊息的精確結構一併指定？ [Completeness, Spec §FR-001, Contracts C1]
- [x] CHK002 連線「尚未訂閱任何機台」時的預期狀態是否有需求定義（收不到資料 vs 收到 idle 提示）？ [Gap]
- [x] CHK003 示範機台清單（數量、識別字）是否在需求中明確列舉，而非留給實作決定？ [Completeness, Spec §FR-005 / Assumptions]
- [ ] CHK004 遙測量測欄位是否連同單位／合理範圍被指定，或僅有欄位名稱？ [Clarity/Gap, Key Entities]
- [x] CHK005 telemetry → healthy/warning/critical 的判定門檻是否在需求中定義或明確委派給他處？ [Gap, Spec §FR-005]
- [ ] CHK006 維修紀錄 seed 的內容（筆數、可重播決定性）是否有需求描述？ [Completeness, Spec §FR-013]

## Requirement Clarity & Measurability

- [x] CHK007 「高頻節奏（10–50ms）」是否收斂到具體預設值與容差，而非僅留一個區間？ [Clarity, Spec §FR-005, §SC-008]
- [x] CHK008 SC-008「不被可觀察的拖慢」是否量化為可測門檻（如允許偏離 cadence 的上限）？ [Measurability, Spec §SC-008]
- [ ] CHK009 伺服器端心跳的探活間隔與「判定失效前可容忍的未回應次數／寬限」是否清楚指定？ [Clarity, Spec §FR-007b, Research R3]
- [x] CHK010 SC-002／SC-003 的「一段觀察期」是否給定具體時長以利客觀驗證？ [Measurability, Spec §SC-002/§SC-003]
- [x] CHK011 SC-003「errorlog 筆數＝轉換次數」在落地與觀察存在時間差時，是否仍可客觀量測（定義量測時點）？ [Measurability, Spec §SC-003]

## Requirement Consistency

- [x] CHK012 MachineState（healthy/warning/critical）是否與 DiagnosisResult severity（ok/warning/critical）在全 spec 維持一致且刻意區分？ [Consistency, Key Entities]
- [x] CHK013 FR-004（推送依訂閱過濾）與 FR-009（落地與訂閱無關、存全部機台）是否維持不衝突且界線清楚？ [Consistency, Spec §FR-004/§FR-009, Clarif Q2]
- [x] CHK014 「連線中斷」是否在 FR-008、SC-005、Edge Cases 一致地涵蓋「正常關閉」與「心跳逾時」兩種情形？ [Consistency, Spec §FR-008/§SC-005]
- [x] CHK015 訂閱「取代式」語意是否在 FR-002、US1 場景 5、Assumptions（空集合＝全部取消）間一致？ [Consistency, Spec §FR-002/US1]

## Acceptance Criteria Quality

- [x] CHK016 每條功能需求（FR-001..017）是否都有至少一條對應的可量測成功標準或驗收情境（或明確的覆蓋備註）？ [Coverage, Traceability]
- [x] CHK017 SC-001（0% 串流外洩）是否搭配明確的觀察視窗與機台集合以使其可測？ [Measurability, Spec §SC-001]
- [x] CHK018 通用 send() 銜接點（FR-015）是否有可在本 feature 驗收的標準，或被明確標記為本期不可驗收？ [Gap, Spec §FR-015]

## Scenario Coverage

- [x] CHK019 是否涵蓋替代流程需求：串流途中重送新的訂閱集合並即時改變推送？ [Coverage, Spec §US1-5]
- [x] CHK020 是否涵蓋例外流程需求：無效授權、無法解析訊息？ [Coverage, Spec §FR-003/§FR-014]
- [ ] CHK021 是否處理復原流程需求：客戶端斷線重連後須重新訂閱——這是被寫成「需求」還是僅列於假設？ [Coverage, Assumption]
- [x] CHK022 訂閱「不存在的機台識別」是否有需求定義其安全處理？ [Edge Case, Spec Edge Cases]
- [ ] CHK023 多連線「重疊（非互斥）」訂閱集合是否有需求覆蓋，或只測了互斥情形（SC-001）？ [Coverage, Gap]

## Edge Case Coverage

- [x] CHK024 持久化寫入失敗「不影響串流」是否被寫成需求（而非僅 research 註記）？ [Edge Case, Spec Edge Cases/§FR-010]
- [ ] CHK025 空訂閱集合（不訂閱任何機台）在「推送」與「回執」兩端的行為是否有需求定義？ [Edge Case, Contracts C5]
- [x] CHK026 FR-011 是否同時定義「持續異常不重複寫」與「轉回 healthy 是否記錄」兩種情形？ [Edge Case, Spec §FR-011]
- [x] CHK027 缺少選用工具（命令列 ws／資料庫客戶端）時的替代驗收路徑是否明確不阻斷？ [Coverage, Spec Edge Cases]

## Non-Functional Requirements

- [x] CHK028 殭屍／半死連線回收的可靠度是否可量測（從中斷到回收的最長時間）？ [Measurability, Spec §FR-007/§SC-005]
- [x] CHK029 可觀測性需求（連線、斷線、心跳逾時、落地錯誤的記錄）是否被指定或明確排除？ [Gap, NFR]
- [ ] CHK030 安全需求是否明確界定「僅 dev 共享密鑰、無傳輸加密、無逐使用者認證」以消除歧義？ [Clarity, Spec Assumptions]
- [ ] CHK031 規模假設（機台數、並行連線數、50ms 下的寫入量）是否記錄以框定效能期望？ [Completeness, Plan Scale]

## Contract-First（控制訊息）

- [x] CHK032 所有新增控制訊息（system/connected、machine/subscribed、pong、system/unauthorized、ping）是否以需求列出且含 payload 結構？ [Completeness, Contracts §C, data-model §C]
- [x] CHK033 「先入 `packages/contracts` 與 `asyncapi.yaml` 再實作」（contract-first）是否被寫成明確要求？ [Consistency, Constitution II/III, Research R1]
- [x] CHK034 遙測推送 envelope（陣列 vs 單筆 TelemetryPoint）是否無歧義指定，並與 asyncapi 的單筆 schema 對齊／調和？ [Ambiguity, data-model §C, Contracts]
- [x] CHK035 客戶端如何區分「遙測陣列」與「控制物件」（以是否帶 type）是否有需求說明？ [Clarity, data-model §C]

## Dependencies & Assumptions

- [x] CHK036 各項假設（固定機台清單、dev 密鑰授權、不跨重連記憶訂閱、歷史僅存 MongoDB）是否明列並可被檢核？ [Assumption, Spec Assumptions]
- [x] CHK037 對 001 既有契約／環境鍵（WS_AUTH_SECRET、WS_HEARTBEAT_MS、MOCK_TELEMETRY_INTERVAL_MS、TELEMETRY_TTL_SECONDS、MONGO_*）的依賴是否被記為前置條件？ [Dependency, Spec/Plan]
- [x] CHK038 對 003 的範圍邊界（job/status、AI relay）是否無歧義，使相關需求不洩漏進本 feature？ [Scope, Spec §FR-015]

## Ambiguities & Conflicts

- [x] CHK039 「示範機台 約 5 台」是否釘到確切數字，或「約」字引入會影響 SC 計數的歧義？ [Ambiguity, Spec Assumptions]
- [x] CHK040 需求與成功標準的 ID 體系（FR-/SC-/US）是否一致套用且可追溯？ [Traceability]

## Gate Result (2026-06-30)

初次評估 21 PASS / 11 PARTIAL / 8 FAIL。已就「真正影響 implement 與驗收正確性」與「低成本消
歧義」共 11 項回寫 spec（CHK003/005/007/008/010/011/016/018/028/029/039），現 **32/40 通過**。

**刻意接受、不阻擋 implement（demo 範圍，8 項，維持未勾）**：

- CHK004 遙測欄位單位／範圍、CHK006 seed 筆數、CHK009 心跳容忍次數 → 由 mock 規格／research R3
  指導實作即足夠，過度規格化違背「別把 demo 寫成生產規格」。
- CHK021 重連重訂閱（僅列假設）、CHK025 空訂閱 ack（推送端已定義、回執端隱含）、CHK023 重疊
  訂閱集合（FR-004 邏輯已涵蓋，僅未獨立列情境） → 行為可由既有需求推導，風險低。
- CHK030 傳輸加密（dev 用 ws 非 wss）、CHK031 50ms 寫入量 → 屬 demo 環境既定前提。

> 標記語意：[Gap] 需求缺漏、[Ambiguity] 措辭含糊、[Conflict] 彼此矛盾、[Assumption] 待驗證假設。
