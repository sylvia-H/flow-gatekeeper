# Specification Quality Checklist: 012-lite 串流韌性（Stream Resilience）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-21
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs)（部分不通過，理由見 Notes 第 2 點）
- [x] Focused on user value and business needs
- [ ] Written for non-technical stakeholders（部分不通過：User Stories 與 SC 以使用者可見結果描述，FR 為契約與協定層級，見 Notes 第 2 點）
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain（14 條設計決策已依 ADR-003 代理裁決寫入 Clarifications，待使用者覆核）
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [ ] Success criteria are technology-agnostic (no implementation details)（部分不通過：SC-002／SC-004／SC-005／SC-010 保留驗收必需的技術識別項，見 Notes 第 3 點）
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification（同 Content Quality 第 1 項，見 Notes 第 2 點）

## Notes

1. 第一輪驗證（2026-10-21，specify 階段）：User Stories US1～US6 依 spec-input 的優先序（P1、P1、P2、P2、P3、P3），各含 Why this priority、Independent Test 與 Given/When/Then 情境；US3 與 US4 註明 MUST 同批交付。FR 共 46 條（FR-001～FR-046），分七群：完成語意、結果讀取與 rebind、重派與 keepalive、冪等與成本、契約、前端呈現（含 UI 文案表）、文件回補，另加不變量與驗收基礎建設；每條末尾標出對應的 US 或 SC。SC-001～SC-011 皆有驗證方式（e2e、單元測試、`pnpm check`），皆可量測。
2. **「No implementation details」與「Written for non-technical stakeholders」不完全通過，刻意保留**：本 feature 的本質是完成語意、通訊契約與佇列參數的修正，需求本身就是協定層的行為（`job/status` 欄位、`GET /diagnoses/:jobId` 的狀態碼、BullMQ `lockDuration`／`stalledInterval`／`maxStalledCount`、Redis 鍵與 TTL、nginx 限流區）。依憲章 III「契約優先」與 CLAUDE.md「新增 event/payload 先改契約」，這些識別項必須在 spec 層定案，下游 plan／tasks 與審查才能追溯；改寫成抽象敘述會讓 SC-005／SC-010 無從驗收。前例 013 亦保留 `packages/contracts`、`asyncapi.yaml`、`POST /diagnoses` 等名稱並在 Notes 說明。非技術讀者可只讀 User Stories、Edge Cases 與 Success Criteria——這三節以畫面文案與使用者看得到的結果（不出現假失敗、不多付 LLM 費用、多久內看到結果）描述。
3. **「Success criteria are technology-agnostic」不完全通過**：SC-001、SC-003、SC-006～SC-009、SC-011 以使用者可見結果或計數描述；SC-002（`CLIENT KILL TYPE pubsub`、`DiagnosisResultSchema`）、SC-004（`docker compose pause redis`、`diagnosisTriggers`）、SC-005（HTTP 狀態碼與 `removeOnComplete`）、SC-010（`asyncapi.yaml` 版本、`pnpm check`）保留故障注入方式與契約名稱，因為判準本身就是「在這種故障下」與「契約是否到位」，換成泛稱會失去可重現性。spec-input 的 SC 原文即如此，本 spec 已盡量把措辭改為使用者導向。
4. 模板中的 `Clarifications` 一節依 013 前例放在 User Scenarios 之前；`Out of Scope` 一節為本 spec 新增（模板無此節），內容照 spec-input「明確不做」。
5. 待 plan 階段處理的已知點（不是 [NEEDS CLARIFICATION]，已在 Assumptions 標明）：轉「結果未送達」失敗之後再抵達的同 jobId 結果是否仍救回（ADR-003 D3 寫「改由 D10 取代」）；FR-013 的 `returnvalue` 驗證失敗分支為 spec 補充；憲章 Principle III 的 PATCH 修訂待使用者確認。
