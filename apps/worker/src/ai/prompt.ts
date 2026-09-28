import type { DiagnosisContext } from "../context/context-builder.js";
import { DIAGNOSIS_RESULT_JSON_SCHEMA } from "../lib/zod-json-schema.js";

/**
 * prompt 版本（進 cache signature）。**改動本檔 prompt 內容時 MUST 同時升版**——版本與內容放在
 * 同一個檔案，就是為了讓改 prompt 的人不會忘記讓舊 cache 失效（否則舊 cache 會續服務到 TTL）。
 */
// v2：結構說明由手寫範例改為內嵌 DiagnosisResultSchema 推導的 JSON Schema。
export const PROMPT_VERSION = "diagnosis-v2";

/**
 * 由機台脈絡組出診斷 prompt（指南 §8.9）：彙總近期 telemetry／errorlogs／maintenance，
 * 並**要求模型只回傳指定 JSON 結構**。結構描述由 `DiagnosisResultSchema` 推導（與 provider 的
 * structured output 同源），這裡只補欄位語意；解析／驗證仍在 worker（`parseResult`）。
 */
export function buildPrompt(args: { machineId: string; context: DiagnosisContext }): string {
  const { machineId, context } = args;
  const t = context.telemetry;

  const telemetryLine = t
    ? `樣本數 ${t.count}；溫度 avg ${t.avgTemperature}/max ${t.maxTemperature}；` +
      `振動 avg ${t.avgVibration}/max ${t.maxVibration}；錯誤率 avg ${t.avgErrorRate}/max ${t.maxErrorRate}`
    : "（窗口內無遙測資料）";

  const errorsBlock =
    context.recentErrors.length > 0
      ? context.recentErrors.map((e) => `- [${e.timestamp}] ${e.state}: ${e.message}`).join("\n")
      : "（無近期異常事件）";

  const maintenanceBlock =
    context.maintenance.length > 0
      ? context.maintenance.map((m) => `- [${m.performedAt ?? "?"}] ${m.summary}`).join("\n")
      : "（無近期維修紀錄）";

  return [
    "你是工業機台的資深維運診斷專家。根據以下某台機台近期的監控脈絡，產出一份可據以行動的診斷。",
    "",
    `機台：${machineId}`,
    `目前狀態（最近一筆遙測）：${context.latestState}`,
    `近 ${context.windowMinutes} 分鐘遙測彙總：${telemetryLine}`,
    "",
    "近期異常事件：",
    errorsBlock,
    "",
    "近期維修紀錄：",
    maintenanceBlock,
    "",
    "請**只輸出一個 JSON 物件**（不要有其他文字、不要 markdown 圍欄），須符合以下 JSON Schema：",
    JSON.stringify(DIAGNOSIS_RESULT_JSON_SCHEMA),
    "欄位語意：summary 為一句話診斷摘要；likelyCauses 為可能原因；suggestedActions 為可執行的建議動作" +
      "（command 選填）；evidence 必須引用上方脈絡作為佐證（source 標明出處）。",
  ].join("\n");
}
