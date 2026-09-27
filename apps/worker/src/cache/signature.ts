import { createHash } from "node:crypto";

/**
 * 快取簽章（純函式，FR-005／FR-018，指南 §8.7）。
 *
 * 反映「機台／當前狀態／近期錯誤類型／prompt 版本／provider＋model」——`topErrorCodes`
 * **排序後**併入，使順序不影響結果（決定性）。含 `state` 讓不同嚴重度不共用快取；含
 * promptVersion 讓改 prompt 自動失效舊 cache；含 providerId＋model 讓換供應商或換模型不會
 * 拿到別家模型產生的結果（不同供應商可能用同名模型字串）。取 sha256 前 24 hex 為 cache/lock 鍵尾綴。
 */
export function buildDiagnosisSignature(input: {
  machineId: string;
  state: string;
  topErrorCodes: string[];
  promptVersion: string;
  providerId: string;
  model: string;
}): string {
  const canonical = JSON.stringify({
    machineId: input.machineId,
    state: input.state,
    topErrorCodes: [...input.topErrorCodes].sort(),
    promptVersion: input.promptVersion,
    providerId: input.providerId,
    model: input.model,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}
