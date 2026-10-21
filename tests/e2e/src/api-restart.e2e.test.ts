import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosisLookupResponseSchema, DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import { restartApi, startWorker, stopWorker, waitHealthy } from "./harness/compose.js";
import { clearDiagnosisCache } from "./harness/infra.js";
import { createDiagnosis, E2eClient, getDiagnosisUntilSettled, reconnectClient, sleep } from "./harness/ws-client.js";

/**
 * 場景 6（012 US2、SC-003；research P18）：api 重啟後，新連線以 GET 續接重啟前發起的任務。
 *
 * - 6a 串流中重啟 api：fake 串流約 10 s，短於 api 冷啟動，job 必在 api 停機期間完成（WS 推不到）；重連後以新 socketId
 *   GET → 200 completed＋result。
 * - 6b job 仍在佇列時重啟 api：先停 worker → POST → 重啟 api → 重連 GET → 200 waiting `rebound: true`（api 新行程的
 *   registry 是空的，GET 暫定建立綁定）→ 啟動 worker → 新連線收到帶 result 的 completed。
 * - 判準：兩者都在 api healthy 後 60 s 內完成（SC-003）。active 狀態的改綁由 api 單元測試與場景 8 的 previousSocketId 覆蓋。
 *
 * 機台選 press-02（不與場景 1／2／3／5 共用簽章）。6a 必須走 LLM 串流路徑，故 beforeAll 清空 `ai-cache:*`——檔案執行
 * 順序不保證，場景 8（同用 press-02）若先跑會留下快取。6b 命中 6a 留下的快取也無妨（completed 一樣帶 result）。
 */

const MACHINE = "press-02";
const TELEMETRY_FLUSH_WAIT_MS = 3_000;
/** SC-003：api healthy 後 60 s 內續接完成。 */
const RESUME_DEADLINE_MS = 60_000;
/** api 重啟：SIGTERM 收尾（stop_grace_period 15 s）＋冷啟動＋healthcheck，留寬。 */
const API_HEALTHY_TIMEOUT_MS = 120_000;

/** healthy 後 nginx 偶有短暫 502：重連最多試 5 次、間隔 2 s。 */
async function reconnectWithRetry(old: E2eClient): Promise<{ client: E2eClient; clientId: string }> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      return await reconnectClient(old, [MACHINE]);
    } catch (err) {
      lastErr = err;
      await sleep(2_000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

describe.skipIf(!process.env.E2E)("跨 process e2e：api 重啟後以 GET 續接", () => {
  let client: E2eClient;
  let workerStopped = false;

  beforeAll(async () => {
    const cleared = await clearDiagnosisCache();
    console.log(`[e2e] 場景 6 前清空 ai-cache：${cleared} 鍵`);
    client = await E2eClient.connect();
    await client.subscribe([MACHINE]);
    await client.waitFor(() => client.telemetryMachines.has(MACHINE), 15_000, `${MACHINE} 的 machine/data`);
    await sleep(TELEMETRY_FLUSH_WAIT_MS);
  });

  afterAll(async () => {
    client?.close();
    if (workerStopped) await startWorker().catch(() => undefined);
  });

  it("6a 串流中重啟 api → 重連後新 socketId GET → 200 completed＋result（api healthy 後 60 s 內）", { timeout: 240_000 }, async () => {
    const jobId = randomUUID();
    const oldSocketId = client.clientId;
    await createDiagnosis({ jobId, machineId: MACHINE, socketId: oldSocketId });
    await client.waitFor(() => client.tokens(jobId).length > 0, 30_000, "第一個 ai/token（串流已開始）");
    const tokensBeforeRestart = client.tokens(jobId).length;

    const t0 = Date.now();
    await restartApi();
    const waitedMs = await waitHealthy("api", API_HEALTHY_TIMEOUT_MS);
    const healthyAt = Date.now();

    const re = await reconnectWithRetry(client);
    client = re.client;
    expect(re.clientId).not.toBe(oldSocketId);
    const res = await getDiagnosisUntilSettled(jobId, re.clientId, oldSocketId, RESUME_DEADLINE_MS);
    const resumedMs = Date.now() - healthyAt;

    expect(res.status, `GET 應回 200：${JSON.stringify(res.body)}`).toBe(200);
    expect(DiagnosisLookupResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({ status: "completed", jobId, cached: false });
    expect(DiagnosisResultSchema.safeParse((res.body as { result?: unknown }).result).success).toBe(true);
    expect(resumedMs).toBeLessThan(RESUME_DEADLINE_MS);
    expect(client.violations).toEqual([]);

    console.log(
      `[e2e] 場景 6a：重啟前收到 ${tokensBeforeRestart} 個 token；restart＋healthy ${healthyAt - t0}ms` +
        `（waitHealthy ${waitedMs}ms）；healthy → GET 200 ${resumedMs}ms`,
    );
  });

  it("6b job 仍在佇列時重啟 api → 重連 GET → 200 waiting rebound:true → 啟動 worker → 新連線收到帶 result 的 completed", { timeout: 300_000 }, async () => {
    await stopWorker();
    workerStopped = true;
    const jobId = randomUUID();
    const oldSocketId = client.clientId;
    await createDiagnosis({ jobId, machineId: MACHINE, socketId: oldSocketId });
    await client.waitFor(() => client.statuses(jobId).some((s) => s.status === "waiting"), 10_000, "waiting");

    await restartApi();
    const waitedMs = await waitHealthy("api", API_HEALTHY_TIMEOUT_MS);
    const healthyAt = Date.now();

    const re = await reconnectWithRetry(client);
    client = re.client;
    const res = await getDiagnosisUntilSettled(jobId, re.clientId, oldSocketId, RESUME_DEADLINE_MS);
    expect(res.status, `GET 應回 200：${JSON.stringify(res.body)}`).toBe(200);
    expect(DiagnosisLookupResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({ status: "waiting", jobId, rebound: true });
    const reboundMs = Date.now() - healthyAt;

    await startWorker();
    workerStopped = false;
    const remaining = Math.max(1_000, RESUME_DEADLINE_MS - (Date.now() - healthyAt));
    await client.waitFor(
      () => client.statuses(jobId).some((s) => s.status === "completed" || s.status === "failed"),
      remaining,
      "新連線收到 completed（api healthy 後 60 s 內）",
    );
    const completedMs = Date.now() - healthyAt;
    const completed = client.statuses(jobId).find((s) => s.status === "completed");
    expect(completed, "應收到 completed 而非 failed").toBeDefined();
    expect(DiagnosisResultSchema.safeParse(completed?.result).success).toBe(true);
    expect(completedMs).toBeLessThan(RESUME_DEADLINE_MS);
    expect(client.errors(jobId)).toEqual([]);
    expect(client.violations).toEqual([]);

    console.log(
      `[e2e] 場景 6b：waitHealthy ${waitedMs}ms；healthy → GET waiting ${reboundMs}ms；healthy → completed ${completedMs}ms` +
        `（cached=${String(completed?.cached)}）`,
    );
  });
});
