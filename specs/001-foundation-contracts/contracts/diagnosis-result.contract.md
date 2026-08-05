# Contract: DiagnosisResultSchema（Zod 單一來源）

**來源**：`packages/contracts/src/schemas.ts`
**參考 code**：實作指南 §6.9
**型別**：`export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>`

## 結構

```text
DiagnosisResult {
  summary:          string                       // 必填
  severity:         'ok' | 'warning' | 'critical' // 必填
  likelyCauses:     string[]                       // 必填
  suggestedActions: Array<{                        // 必填
    label:    string
    priority: 'low' | 'medium' | 'high'
    command?: string
  }>
  evidence: Array<{                                // 必填
    source:  'telemetry' | 'errorlog' | 'maintenance'
    id?:     string
    excerpt: string
  }>
}
```

## 不變量

1. 型別 MUST 由 `z.infer` 推導，MUST NOT 另寫平行 `type DiagnosisResult`（憲章 III、FR-005）。
2. `severity` 與機台 `state` 為**不同列舉**（前者 `ok|warning|critical`，後者
   `healthy|warning|critical`），MUST 維持區分。
3. worker（Feature 003）取得 LLM 回傳後 MUST 走 `DiagnosisResultSchema.parse()`；失敗走
   `ai/error`（憲章 V）。本 feature 僅確立 schema 與其可驗證性。

## 驗收（FR-007、FR-014）

| 案例 | 輸入 | 期望 |
|------|------|------|
| 合法結果 | 含全部必填欄位、enum 合法 | `parse()` 回傳型別正確物件 |
| 缺必填欄位 | 缺 `summary` 或 `severity` | `parse()` 丟 `ZodError` |
| enum 非法 | `severity: 'fatal'` / `priority: 'urgent'` / `source: 'foo'` | `parse()` 丟 `ZodError` |
| 巢狀結構錯誤 | `suggestedActions` 元素缺 `label` | `parse()` 丟 `ZodError` |

至少一支 Vitest 測試（`packages/contracts/src/schemas.test.ts`）覆蓋「壞 JSON → 丟錯」，
作為 FR-014 的實際（非 no-op）測試與憲章測試門檻佐證。
