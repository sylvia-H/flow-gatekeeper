# Foundation Requirements-Quality Checklist: Monorepo 基礎、共用契約、本機 Infra 與環境設定

**Purpose**: 輕量自檢——在 `/speckit-implement` 前,由作者確認 spec/plan 對「契約、infra、CI/祕密、範圍邊界」四面向的**需求本身**是否寫得完整、明確、可測、無矛盾。測的是「需求寫得好不好」,不是「實作對不對」。
**Created**: 2026-06-30
**Feature**: [spec.md](../spec.md)
**Depth**: 輕量自檢 | **Audience**: 作者（implement 前）

## 契約品質 (Contracts)

- [ ] CHK001 6 條通道事件的 payload 欄位形狀（必填 vs 可選）是否在需求/契約層完整定義,而非僅列通道名稱? [Completeness, Spec §FR-004, data-model]
- [ ] CHK002 「型別由 `z.infer` 推導、MUST NOT 手寫平行型別」是否寫成可驗收的明確要求? [Clarity, Spec §FR-005]
- [ ] CHK003 機台 `state`（healthy/warning/critical）與診斷 `severity`（ok/warning/critical）兩組列舉,是否被明文記為「刻意不同」以避免被誤併? [Consistency, data-model]
- [ ] CHK004 「結構錯誤判定為不合法」是否以具體失敗案例（缺必填／enum 非法／巢狀錯誤）界定,而非僅用「不合法」一詞? [Measurability, Spec §FR-007]
- [ ] CHK005 三端（web/api/worker）各需 import 並 typecheck 契約,是否都有對應的成功判準? [Coverage, Spec §FR-006, SC-003]

## Infra / Bootstrap

- [ ] CHK006 「可連線」是否以客觀檢查（ping／container healthy）定義,而非靠模糊形容詞? [Clarity, Spec §FR-003]
- [ ] CHK007 SC-001 的「10 分鐘／≤3 主要指令」是否可測,且「主要指令步驟」有明確界定? [Measurability, Spec §SC-001]
- [ ] CHK008 未啟動容器執行環境、以及缺 `redis-cli`/`mongosh` 兩種情境,是否各自定義了期望行為? [Edge Case, Spec §Edge Cases]
- [ ] CHK009 「開發者本機具備 Docker 與 Node 20 LTS+」這項前提,是否在 Assumptions 明確記載而非默認? [Assumption, Spec §Assumptions]

## CI / 祕密衛生 (CI & Secrets)

- [ ] CHK010 CI 四道檢查（contract lint／typecheck／lint／test）是否逐項列為需求,且觸發條件（push／PR）明確? [Completeness, Spec §FR-010]
- [ ] CHK011 「無可測單元的 workspace 其測試步驟 MUST 以通過收場」是否定義了達成機制的期望（no-op 行為）? [Clarity, Spec §FR-011]
- [ ] CHK012 「真正的祕密永不進版控」是否界定了何者算祕密、何者為範例（只追蹤 `.env.example`）? [Clarity, Spec §FR-009, SC-005]
- [ ] CHK013 至少 1 支實際（非 no-op）測試是否被列為要求,且其覆蓋對象（契約結構驗證／entry import）明確? [Measurability, Spec §FR-014, SC-007]

## 範圍邊界 (Scope Boundary)

- [ ] CHK014 001 與 002/003 的切割（佇列／任務 payload 契約、collection 建立、執行期行為）是否對每一塊都明文劃歸,而非隱含? [Coverage, Spec §FR-004/012/013]
- [ ] CHK015 「可編譯的最小骨架」是否以可測語言定義（MUST build + typecheck、MUST NOT 啟動/連線）? [Clarity, Spec §FR-013]
- [ ] CHK016 「app MUST build」與「MUST NOT 要求啟動」之間是否存在表面矛盾,且以 smoke import 測試的調和方式被明文交代? [Conflict, Spec §FR-013/014]
- [ ] CHK017 foundation feature 對「可重播驗收」的處理（以 bootstrap 序列替代 demo/seed）是否被明確界定範圍? [Assumption, Spec §Assumptions]

## Notes

- Check items off as completed: `[x]`;發現需求缺口時就地註記,並回頭補 spec 再重跑 `/speckit-checklist` 或進 `/speckit-analyze`。
- 本表為**需求品質**自檢,與既有 [requirements.md](./requirements.md)（specify 內建的 spec 品質表）互補,不重疊。
- 通過本表不代表實作正確;實作行為的驗證見 [quickstart.md](../quickstart.md) 與 `/speckit-analyze`。
