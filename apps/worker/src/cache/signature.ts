import { createHash } from "node:crypto";

/**
 * 快取簽章（純函式，FR-005／FR-018，指南 §8.7）。
 *
 * 反映「機台／當前狀態／近期錯誤類型／promptVersion／model」——`topErrorCodes` **排序後**
 * 併入，使順序不影響結果（決定性）。含 `state` 讓不同嚴重度不共用快取；含 promptVersion/model
 * 讓改 prompt／換模型自動失效舊 cache。取 sha256 前 24 hex 為 cache/lock 鍵尾綴。
 */
export function buildDiagnosisSignature(input: {
  machineId: string;
  state: string;
  topErrorCodes: string[];
  promptVersion: string;
  model: string;
}): string {
  const canonical = JSON.stringify({
    machineId: input.machineId,
    state: input.state,
    topErrorCodes: [...input.topErrorCodes].sort(),
    promptVersion: input.promptVersion,
    model: input.model,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}
