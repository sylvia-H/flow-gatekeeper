import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import { pauseRedis, unpauseRedis } from "./harness/compose.js";
import {
  cacheCounters,
  clearDiagnosisCache,
  countLlmCalls,
  countTriggers,
  nextMetricsSummary,
  readWorkerLogs,
} from "./harness/infra.js";
import { createDiagnosis, E2eClient, sleep } from "./harness/ws-client.js";

/**
 * 場景 7（012 US4、SC-004；research P25、FR-046；quickstart 演練 4）：Redis 凍結 50 s 讓 worker 失去 job lock、
 * BullMQ 判 stalled 重派，冪等短路吸收第二次執行——trigger 1 筆、LLM 1 次、cache hit＋miss 合計 1、結果非快取。
 *
 * 時序（P25）：收到該 jobId 第 3 個 `ai/token` 後才 `pause`，停頓落在 exec1 首 token 之後——exec1 在停頓期間跑完
 * LLM 串流、停在 `report(80)`；恢復後 exec1 的 SET `ai-result` 先於 exec2 的短路查詢送進 Redis，exec2 一定在短路命中。
 *
 * 停頓期間 client 收不到任何事件（api 的 Redis 也凍住）：本場景不量 `maxGap`。
 * 本檔撰寫於 Phase 5（US4），執行點在 US3 checkpoint（鎖參數 15／5／2 就位後才是驗收條件）。
 *
 * 機台選 oven-04（不與其他場景共用簽章）；本場景必須是 cache miss，故 beforeAll 清空 `ai-cache:*`（檔案順序不保證）。
 * `cacheCounters` 以 worker 日誌的 `worker metrics summary` 為窗界加總，前提是全套 e2e 循序執行（vitest.config.ts）。
 */

const MACHINE = "oven-04";
const TELEMETRY_FLUSH_WAIT_MS = 3_000;
const PAUSE_AFTER_TOKENS = 3;
const PAUSE_MS = 50_000;

describe.skipIf(!process.env.E2E)("跨 process e2e：Redis 停頓 50 s 後冪等收斂", () => {
  let client: E2eClient;
  let paused = false;

  beforeAll(async () => {
    const cleared = await clearDiagnosisCache();
    console.log(`[e2e] 場景 7 前清空 ai-cache：${cleared} 鍵`);
    client = await E2eClient.connect();
    await client.subscribe([MACHINE]);
    await client.waitFor(() => client.telemetryMachines.has(MACHINE), 15_000, `${MACHINE} 的 machine/data`);
    await sleep(TELEMETRY_FLUSH_WAIT_MS);
  });

  afterAll(async () => {
    // 中途失敗時務必解凍，否則之後所有場景都會卡住
    if (paused) await unpauseRedis().catch(() => undefined);
    client?.close();
  });

  it("場景 7 第 3 個 token 後 pause redis 50 s → 重派被冪等吸收：trigger 1、LLM 1、cache hit＋miss 1、cached:false", { timeout: 300_000 }, async () => {
    // 窗界 from：POST 前等到的一則 summary，之前的計數（前一場景）不會落進 (from, to]
    const from = await nextMetricsSummary(Date.now());
    const jobId = randomUUID();
    await createDiagnosis({ jobId, machineId: MACHINE, socketId: client.clientId });
    await client.waitFor(
      () => client.tokens(jobId).length >= PAUSE_AFTER_TOKENS,
      30_000,
      `第 ${PAUSE_AFTER_TOKENS} 個 ai/token`,
    );

    await pauseRedis();
    paused = true;
    try {
      await sleep(PAUSE_MS);
    } finally {
      await unpauseRedis();
      paused = false;
    }
    const unpausedAt = Date.now();

    await client.waitFor(
      () => client.statuses(jobId).some((s) => s.status === "completed" || s.status === "failed"),
      120_000,
      "解凍後的 job/status completed",
    );
    const completedAfterMs = Date.now() - unpausedAt;
    // 窗界 to：完成後第一則 summary（收進 exec2 可能記下的 hit／miss）
    const to = await nextMetricsSummary(Date.now());

    const statuses = client.statuses(jobId);
    const completed = statuses.find((s) => s.status === "completed");
    const triggers = await countTriggers(jobId);
    const llmCalls = await countLlmCalls(jobId);
    const cacheTotal = await cacheCounters(from, to);
    const shortCircuits = (await readWorkerLogs())
      .filter((e) => e.msg === "idempotent short-circuit" && e.jobId === jobId)
      .map((e) => (typeof e.source === "string" ? e.source : JSON.stringify(e.source)));
    const stalled = statuses.some((s) => s.reason === "stalled");
    const maxExecution = Math.max(0, ...statuses.map((s) => s.execution ?? 0));

    console.log(
      `[e2e] 場景 7：解凍 → completed ${completedAfterMs}ms；trigger ${triggers}、LLM call ${llmCalls}、cache hit＋miss ${cacheTotal}` +
        `（窗界 ${from} → ${to}）；stalled=${String(stalled)}、最大 execution ${maxExecution}；` +
        `idempotent short-circuit source：${shortCircuits.length > 0 ? shortCircuits.join(", ") : "（無）"}`,
    );

    // 重派必須真的發生，否則本場景沒驗到 AR-4（不放寬判準）
    if (!stalled && maxExecution < 2) console.log("[e2e] 場景 7：未重現 AR-4（沒有 stalled 也沒有 execution ≥ 2）");
    expect(stalled || maxExecution >= 2, "應收到 reason:stalled 或 execution ≥ 2（未重現 AR-4）").toBe(true);

    expect(statuses.map((s) => s.status)).not.toContain("failed");
    expect(completed, "應收到 completed").toBeDefined();
    expect(DiagnosisResultSchema.safeParse(completed?.result).success).toBe(true);
    expect(completed?.cached).toBe(false);
    expect(triggers).toBe(1);
    expect(llmCalls).toBe(1);
    expect(cacheTotal).toBe(1);
    expect(client.violations).toEqual([]);
  });
});
