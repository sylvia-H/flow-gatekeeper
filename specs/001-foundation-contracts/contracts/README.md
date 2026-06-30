# Contracts: Foundation & Contracts (001)

本資料夾是 Feature 001 對外/三端介面的**契約規格**（spec 層），描述本 feature 將交付的
通訊契約其結構、不變量與驗收點。實際可執行的單一真實來源是：

- **Zod schema**：`packages/contracts/src/schemas.ts`（`DiagnosisResultSchema`，型別由
  `z.infer` 推導）— 憲章 III 規定的唯一來源。
- **事件型別**：`packages/contracts/src/events.ts`（6 條通道事件）。
- **通訊文件**：repo root `asyncapi.yaml`（AsyncAPI 2.6，Spectral lint 對象）。

> 這些檔案的完整 reference code 見實作指南 §6.8 / §6.9。本資料夾不重貼 code，只定義
> 契約義務與驗收，避免雙重來源分歧。

## 介面清單

| 介面 | 消費者 | 契約檔 |
|------|--------|--------|
| 6 條 WebSocket 通道事件型別 | web / api / worker | [events.contract.md](./events.contract.md) |
| `DiagnosisResultSchema`（執行期驗證 + 型別） | worker（驗證）/ api / web（型別） | [diagnosis-result.contract.md](./diagnosis-result.contract.md) |
| `asyncapi.yaml` 通訊文件 | Spectral contract lint | 見 events.contract.md「文件對應」 |

## 契約義務（本 feature MUST 滿足）

1. 三端（web/api/worker）皆能 `import` 契約並通過 strict typecheck（FR-006、SC-003）。
2. 型別 MUST 由 Zod `z.infer` 推導，MUST NOT 手寫平行型別（FR-005、憲章 III）。
3. `DiagnosisResultSchema.parse()` 對結構錯誤資料 MUST 丟錯（FR-007）。
4. `asyncapi.yaml` 通過 `spectral lint` 0 違規（FR-008、SC-004）。
5. 佇列常數與任務 payload 契約 MUST NOT 出現於本 feature（FR-004，留待 003）。
