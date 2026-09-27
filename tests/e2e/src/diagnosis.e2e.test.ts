import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import { createDiagnosis, E2eClient, postDiagnosis, sleep } from "./harness/ws-client.js";

/**
 * 跨 process e2e：web(nginx) → api(Gateway) → BullMQ → worker(fake AiProvider) → Redis Pub/Sub → Gateway → ws client。
 *
 * 機台選 mixer-01：mock telemetry 對它不注入 warning／critical 尖峰（index 0），state 恆為 healthy、
 * 不產生 errorlog → 診斷簽章（machineId／state／topErrorCodes／provider／model）在場景 1 與 2 之間穩定，
 * cache 命中可重現。它沒有 seed 維修紀錄，脈絡來自 api 持續寫入的遙測，故 POST 前先確認遙測已到並已 flush。
 */

const MACHINE = "mixer-01";
/** fake provider 設定（docker-compose.e2e.yml）：20 段。 */
const FAKE_TOKENS = 20;
/**
 * POST 前的硬等：api 每秒把遙測 flush 進 Mongo，但沒有任何可觀測訊號（WS／HTTP）能確認「已落地」，
 * 只能等兩個 flush 週期再多一點，確保 worker 讀得到脈絡、不走 no_context。
 */
const TELEMETRY_FLUSH_WAIT_MS = 3_000;

describe.skipIf(!process.env.E2E)("跨 process e2e：診斷全鏈路", () => {
  let client: E2eClient;
  let firstResult: unknown;

  beforeAll(async () => {
    client = await E2eClient.connect();
    await client.subscribe([MACHINE]);
    await client.waitFor(() => client.telemetryMachines.has(MACHINE), 15_000, `${MACHINE} 的 machine/data`);
    await sleep(TELEMETRY_FLUSH_WAIT_MS);
  });

  afterAll(() => {
    client?.close();
  });

  it("場景 1 happy path：job/status waiting→active→進度遞增→completed，ai/token seq 0 起連號、attempt 1，ai/done 通過契約", async () => {
    const t0 = Date.now();
    const jobId = randomUUID();
    const res = await createDiagnosis({ jobId, machineId: MACHINE, socketId: client.clientId });
    expect(res).toEqual({ jobId, machineId: MACHINE, status: "waiting" });

    await client.waitFor(
      () => client.done(jobId) !== undefined && client.statuses(jobId).some((s) => s.status === "completed"),
      45_000,
      "ai/done 與 job/status completed",
    );

    const done = client.done(jobId);
    expect(done?.cached).toBe(false);
    expect(done?.attempt).toBe(1);
    expect(DiagnosisResultSchema.safeParse(done?.result).success).toBe(true);
    expect(done?.result.summary).toContain("[fake provider]");
    expect(client.errors(jobId)).toEqual([]);

    // ai/token：seq 從 0 逐一遞增、attempt 皆 1，接回的全文就是最終結果（worker 以同一份文字 parseResult）
    const tokens = client.tokens(jobId);
    expect(tokens.map((t) => t.seq)).toEqual(Array.from({ length: FAKE_TOKENS }, (_, i) => i));
    expect(new Set(tokens.map((t) => t.attempt))).toEqual(new Set([1]));
    expect(JSON.parse(tokens.map((t) => t.text).join(""))).toEqual(done?.result);

    // job/status：waiting 先於 active；active 的進度依真實階段里程碑遞增（0/20/40/60/80/100）；completed 收尾
    const statuses = client.statuses(jobId);
    const order = statuses.map((s) => s.status);
    expect(order[0]).toBe("waiting");
    expect(order.indexOf("active")).toBeGreaterThan(0);
    expect(order.at(-1)).toBe("completed");
    expect(order.filter((s) => s === "completed")).toHaveLength(1);
    expect(order).not.toContain("failed");
    const progress = statuses.flatMap((s) => (s.progress === undefined ? [] : [s.progress]));
    expect(progress).toEqual([0, 20, 40, 60, 80, 100]);
    expect(statuses.every((s) => s.machineId === MACHINE)).toBe(true);

    // 最後一個 token 必在 ai/done 之前（同一 Pub/Sub 頻道、同一條 WS 連線保序）
    const types = client.jobEvents(jobId).map((e) => e.type);
    expect(types.lastIndexOf("ai/token")).toBeLessThan(types.indexOf("ai/done"));

    firstResult = done?.result;
    expect(client.violations).toEqual([]);
    console.log(`[e2e] 場景 1 耗時 ${Date.now() - t0}ms（POST → completed）`);
  });

  it("場景 2 cache 命中：同機台同簽章再 POST → ai/done cached:true、無 ai/token、進度 0/20/100", async () => {
    expect(firstResult, "需先跑過場景 1").toBeDefined();
    const t0 = Date.now();
    const jobId = randomUUID();
    await createDiagnosis({ jobId, machineId: MACHINE, socketId: client.clientId });

    await client.waitFor(
      () => client.done(jobId) !== undefined && client.statuses(jobId).some((s) => s.status === "completed"),
      20_000,
      "cache 命中的 ai/done 與 completed",
    );
    const done = client.done(jobId);
    expect(done?.cached).toBe(true);
    expect(done?.attempt).toBe(1);
    expect(done?.result).toEqual(firstResult);
    expect(client.tokens(jobId)).toEqual([]);
    expect(client.errors(jobId)).toEqual([]);

    const statuses = client.statuses(jobId);
    expect(statuses.at(-1)?.status).toBe("completed");
    const progress = statuses.flatMap((s) => (s.progress === undefined ? [] : [s.progress]));
    expect(progress).toEqual([0, 20, 100]);
    expect(client.violations).toEqual([]);
    console.log(`[e2e] 場景 2 耗時 ${Date.now() - t0}ms（POST → completed，cache 命中）`);
  });

  it("場景 4a 不在線的 socketId（隨機 uuid）→ 409 Conflict（在綁定與入列之前擋下）", async () => {
    const res = await postDiagnosis({ jobId: randomUUID(), machineId: MACHINE, socketId: randomUUID() });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ statusCode: 409, error: "Conflict" });
  });

  it("場景 4b 名冊外 machineId → 404", async () => {
    const res = await postDiagnosis({ jobId: randomUUID(), machineId: "ghost-99", socketId: client.clientId });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: "Not Found" });
  });
});
