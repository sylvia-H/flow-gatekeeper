import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import type { JobStatus } from "@flow-gatekeeper/contracts";

/**
 * 契約匯入驗證（FR-006 / SC-003）——長期保留的型別佐證，被 `typecheck` 涵蓋，
 * 以 `*.check.ts` 命名排除於 build 產出。
 *
 * 證明 worker 端能 import 契約「驗證器」（FR-007：對結構錯誤者判定不合法）
 * 與型別，並與單一來源一致。
 */
export const diagnosisValidator = DiagnosisResultSchema;

export const sampleJobStatus: JobStatus = {
  type: "job/status",
  jobId: "job-001",
  machineId: "press-02",
  status: "waiting",
};
