import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosisLookupResponseSchema, DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import { startWorker, stopWorker } from "./harness/compose.js";
import { createDiagnosis, E2eClient, getDiagnosis, sleep } from "./harness/ws-client.js";

/**
 * 場景 8（012 US2、SC-005；quickstart §3）：`GET /diagnoses/:jobId` 的回應形狀與授權模型
 * （contracts/diagnosis-lookup.contract.md §2、§5）。
 *
 * 「進行中」以停 worker 製造：POST 後 job 停在 waiting、綁定在 A，不靠時序搶在串流結束前查詢，也與快取無關
 * （worker 恢復後即使命中快取，`completed` 一樣帶 result）。
 *
 * 機台選 press-02：不與場景 1／2（mixer-01）、3（sorter-05）、5（pack-03）共用簽章，避免本檔先跑時留下的快取讓
 * 那些場景秒回 cache 命中；場景 6 雖也用 press-02，但它在 beforeAll 清空快取（見 api-restart.e2e.test.ts）。
 */

const MACHINE = "press-02";
const TELEMETRY_FLUSH_WAIT_MS = 3_000;

describe.skipIf(!process.env.E2E)("跨 process e2e：GET /diagnoses/:jobId 回應形狀", () => {
  let a: E2eClient;
  let b: E2eClient;
  let workerStopped = false;

  beforeAll(async () => {
    a = await E2eClient.connect();
    b = await E2eClient.connect();
    await a.subscribe([MACHINE]);
    await b.subscribe([MACHINE]);
    await a.waitFor(() => a.telemetryMachines.has(MACHINE), 15_000, `${MACHINE} 的 machine/data`);
    await sleep(TELEMETRY_FLUSH_WAIT_MS);
  });

  afterAll(async () => {
    a?.close();
    b?.close();
    // 中途失敗時也把 worker 拉回來，不影響後續檔案
    if (workerStopped) await startWorker().catch(() => undefined);
  });

  it("8a 不存在的 jobId（隨機 UUID）→ 404", async () => {
    const res = await getDiagnosis(randomUUID(), a.clientId);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: "Not Found" });
  });

  it("8b socketId 非 UUID（abc）→ 400，body 帶 issues、不回顯輸入", async () => {
    const res = await getDiagnosis(randomUUID(), "abc");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: "Bad Request" });
    expect(Array.isArray((res.body as { issues?: unknown }).issues)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("abc");
  });

  it("8c socketId 不在線（隨機 UUID）→ 409 code socket_unauthorized", async () => {
    const res = await getDiagnosis(randomUUID(), randomUUID());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ statusCode: 409, error: "Conflict", code: "socket_unauthorized" });
  });

  it(
    "8d 進行中且綁在 A：B 查 → 409 job_bound_elsewhere；B 帶 previousSocketId=A → 200 waiting rebound:true；之後事件送 B；完成後 A 查 → 200 completed",
    { timeout: 180_000 },
    async () => {
      await stopWorker();
      workerStopped = true;
      const jobId = randomUUID();
      await createDiagnosis({ jobId, machineId: MACHINE, socketId: a.clientId });
      await a.waitFor(() => a.statuses(jobId).some((s) => s.status === "waiting"), 10_000, "A 收到 waiting");

      // 原綁定 A 在線、B 不是本連線、也沒帶 previousSocketId → 衝突
      const conflict = await getDiagnosis(jobId, b.clientId);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ statusCode: 409, error: "Conflict", code: "job_bound_elsewhere" });

      // previousSocketId 等於原綁定 → 改綁到 B（即使 A 仍在線）
      const rebound = await getDiagnosis(jobId, b.clientId, a.clientId);
      expect(rebound.status).toBe(200);
      const parsed = DiagnosisLookupResponseSchema.safeParse(rebound.body);
      expect(parsed.success, `GET 回應應通過 DiagnosisLookupResponseSchema：${JSON.stringify(rebound.body)}`).toBe(true);
      expect(rebound.body).toMatchObject({ status: "waiting", jobId, rebound: true });

      await startWorker();
      workerStopped = false;
      await b.waitFor(
        () => b.statuses(jobId).some((s) => s.status === "completed" || s.status === "failed"),
        120_000,
        "B 收到 completed（改綁後）",
      );
      const completed = b.statuses(jobId).find((s) => s.status === "completed");
      expect(completed, "改綁後 completed 應送到 B").toBeDefined();
      expect(DiagnosisResultSchema.safeParse(completed?.result).success).toBe(true);
      // 改綁後的事件只送新綁定：A 不再收到該 job 的 completed
      expect(a.statuses(jobId).some((s) => s.status === "completed")).toBe(false);

      // 已完成的結果對任何已授權連線可讀，原綁定（B）仍在線也一樣
      const done = await getDiagnosis(jobId, a.clientId);
      expect(done.status).toBe(200);
      expect(DiagnosisLookupResponseSchema.safeParse(done.body).success).toBe(true);
      expect(done.body).toMatchObject({ status: "completed", jobId });
      expect(DiagnosisResultSchema.safeParse((done.body as { result?: unknown }).result).success).toBe(true);
      expect((done.body as { result?: unknown }).result).toEqual(completed?.result);

      expect(a.violations).toEqual([]);
      expect(b.violations).toEqual([]);
    },
  );
});
