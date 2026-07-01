import type { DiagnosisContext } from "../context/context-builder.js";

/**
 * 由機台脈絡組出診斷 prompt（指南 §8.9）：彙總近期 telemetry／errorlogs／maintenance，
 * 並**要求模型只回傳指定 JSON 結構**（對齊 `DiagnosisResultSchema`；解析/驗證在 worker）。
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
    "請**只輸出一個 JSON 物件**（不要有其他文字、不要 markdown 圍欄），結構如下：",
    "{",
    '  "summary": string,                       // 一句話診斷摘要',
    '  "severity": "ok" | "warning" | "critical",',
    '  "likelyCauses": string[],                // 可能原因',
    '  "suggestedActions": [                     // 建議動作',
    '    { "label": string, "priority": "low" | "medium" | "high", "command"?: string }',
    "  ],",
    '  "evidence": [                             // 佐證（引用上述脈絡）',
    '    { "source": "telemetry" | "errorlog" | "maintenance", "id"?: string, "excerpt": string }',
    "  ]",
    "}",
  ].join("\n");
}
