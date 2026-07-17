# Specification Quality Checklist: Full-Stack Containerization & One-Command Demo

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-15
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs)
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] Success criteria are technology-agnostic (no implementation details)
- [X] All acceptance scenarios are defined
- [X] Edge cases are identified
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [X] Feature meets measurable outcomes defined in Success Criteria
- [X] No implementation details leak into specification

## Notes

**2026-07-15 clarify 後重新驗證：16/16 維持全數通過**（無新增未通過項）。逐項覆核重點：

- **Content Quality**：需求條文維持能力層語言。clarify 帶入的 code 層佐證（未啟用關閉掛鉤、`onModuleDestroy` 從未觸發、seed 的重置語意、api 僅有 `POST /diagnoses`）刻意只保留在 **Clarifications** 作為決策證據，FR 條文改以「停止訊號處理」「即時通道握手」「資料備妥邏輯」等結果語言表述，故本項仍通過。唯一具體命名是 `demo` 分組——屬展示者面對的操作介面（FR-008／SC-007 的驗收對象），非實作細節。
- **可測試性**：clarify 為先前無數字的項目補上可驗收門檻——FR-003 重啟上限 5 次、FR-004 寬限期 15 秒、FR-011 複合就緒訊號、FR-012 一次性備妥且重啟不重置。SC-005 併入「收尾實測遠低於 15 秒上限」使其可量測。
- **矛盾清除**：clarify 產生的兩處自相矛盾已修正——(1) 概述原稱「無行為變更」與 FR-004 新增關閉處理衝突，已改為「純打包 + 明文界定的窄範圍例外」；(2) Assumptions 原稱「不涉及反向代理」與入口拓樸決策衝突，已改為「反向代理僅供單一入口／同源用途，不擴充為生產級邊緣配置」。
- **範圍邊界**：ADR-002 §5.3 把 `/healthz` 劃歸 Feature 009，FR-011 據此明文拒絕新增端點並接受「不涵蓋資料層連通性」的已知限制，避免 008 搶跑 009。
- **跨 Feature 效應**：`supervised` → `demo` 更名影響 007 的既有文件，已立 FR-016 要求回補 README 與指南（CLAUDE.md 的跨 Feature MUST）。**回補標的於 analyze 階段校正為 §14／§16**——原寫 §13／§14，但指南全檔 0 處 `supervised`，§13 為誤列（現況見 spec FR-016 註）。
- **仍留給 plan 的取捨**：靜態伺服與反向代理採用何種伺服器軟體（Assumptions 已載明）。

**2026-07-15 第二輪 clarify 後重新驗證：16/16 維持全數通過**（無新增未通過項）。本輪只解一題（祕密缺漏處置），逐項覆核重點：

- **矛盾清除**：原 Edge Case「祕密缺漏」要求「系統必須指出缺哪一項」，與 FR-014「MUST NOT 變更任何執行語意」實質衝突——現行語意是金鑰留空仍照常啟動、僅診斷走既有錯誤路徑，要「啟動時指名」勢必新增檢查。已改寫為與實際行為一致的條文，並新增 FR-017 承載可驗收要求，衝突消除。
- **Content Quality**：FR-017 與 Edge Case 一律以「LLM 金鑰」「既有錯誤路徑」「訊息映射」等結果語言表述；具體變數名、SDK 行為與 compose 插值限制等 code 層佐證只留在 **Clarifications** 作為決策證據，維持既有分工，故本項仍通過。
- **可測試性**：FR-017 給出可執行的驗收動作（實測金鑰留空的完整路徑）與明確判準（訊息 MUST 指名金鑰、MUST NOT 只顯示通用失敗語），並預先界定「空金鑰 vs 無效金鑰供應商回應可能不同」的實測陷阱。
- **範圍邊界**：FR-017 明文排除三種祕密檢查置放點（編排／app 啟動路徑／獨立服務），避免 plan 階段重新把已排除方案帶回；條件性的映射補齊已在 FR-014 標記為「不構成例外者」，不擴大純打包的破口。

**2026-07-15 `/speckit-analyze` 後修訂：16/16 維持全數通過**（無新增未通過項）。analyze 的跨工件檢查對本檔既有判定造成兩處修訂——上方兩輪 clarify 的敘述**保留原文**（決策背景不重寫），現況以本段為準：

- **可測試性（修正上方第 37 行的判定）**：clarify 當時認為 SC-005 併入「收尾實測**遠低於** 15 秒上限」即已可量測——analyze 判定該措辭仍**不可客觀判定**（「遠低於」「接近」皆無門檻，驗收者各自解讀會得出不同結論），故 SC-005 已改為明文的 **≤ 3 秒**（15 秒上限的 1/5），並同步至 quickstart 場景 1d、tasks T009、data-model 與 release-gate CHK009。本項據新門檻仍通過。
- **可測試性（FR-017 的覆蓋缺口）**：clarify 當時認定 FR-017 判準明確——analyze 發現其 MUST NOT「假設使用者另有管理員可聯繫」在原 tasks 中**無任務涵蓋**（唯一相關的 T016 為條件性，實測命中金鑰條目時即整項跳過，現行「請聯繫管理員」文案將原封留存）。已拆為 T016a（無條件文案改寫，由該 MUST NOT 驅動）與 T016b（條件性映射補齊，依實測結果），research D11 的「文案屬 SHOULD」敘述亦一併修正。本項據新任務拆分仍通過。

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
