import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import { pubsubKillLoop } from "./harness/infra.js";
import type { PubsubKillSummary } from "./harness/infra.js";
import { createDiagnosis, E2eClient, sleep } from "./harness/ws-client.js";

/**
 * 場景 5（012 US1、SC-002；quickstart 演練 2）：診斷期間 Redis Pub/Sub 每 50 ms 被踢一次 → 任務仍以帶 `result` 的
 * `job/status: completed` 收尾。
 *
 * 為什麼收得到：`ai/*` 走 Redis Pub/Sub（`ai-stream:<jobId>`，api 的 subscriber 連線一直被 `CLIENT KILL TYPE pubsub`
 * 踢掉，token／`ai/done` 會掉），但 `job/status` 來自 BullMQ QueueEvents（Redis Streams 的 XREAD，不是 pubsub 型連線，
 * 不受影響），012 起 `completed` 自帶 worker 的 returnvalue（權威結果）。故判準只看 `completed.result`，
 * `ai/done`、token 是否到達都不斷言（可有可無）。
 *
 * 機台選 pack-03：mock telemetry 不對它注入尖峰（尖峰只在 press-02／oven-04），簽章穩定，且不與場景 1／2（mixer-01）、
 * 場景 3（sorter-05）共用簽章——一定真的走 LLM 串流路徑，故障注入落在串流期間，而不是秒回的 cache 命中。
 */

const MACHINE = "pack-03";
/** POST 前的硬等：同 diagnosis.e2e.test.ts（api 每秒 flush 遙測進 Mongo，無可觀測訊號確認已落地）。 */
const TELEMETRY_FLUSH_WAIT_MS = 3_000;
/** 斷線迴圈長度：涵蓋 fake 串流（首 token 前 2 s＋20 段 × 500 ms ≈ 11.5 s，`FAKE_AI_FIRST_TOKEN_DELAY_MS`）與前後的取鎖、寫庫。 */
const KILL_SECONDS = 20;

describe.skipIf(!process.env.E2E)("跨 process e2e：Redis Pub/Sub 持續斷線", () => {
  let client: E2eClient;
  /** 斷線迴圈：場景中途失敗時 afterAll 仍等它跑完，不讓殘餘的 kill 波及下一個場景檔。 */
  let loop: Promise<PubsubKillSummary> | undefined;

  beforeAll(async () => {
    client = await E2eClient.connect();
    await client.subscribe([MACHINE]);
    await client.waitFor(() => client.telemetryMachines.has(MACHINE), 15_000, `${MACHINE} 的 machine/data`);
    await sleep(TELEMETRY_FLUSH_WAIT_MS);
  });

  afterAll(async () => {
    client?.close();
    await loop?.catch(() => undefined);
  });

  it("場景 5 每 50 ms CLIENT KILL TYPE pubsub 持續 20 s → 以帶 result 的 job/status completed 收尾、無 ai/error", { timeout: 120_000 }, async () => {
    const t0 = Date.now();
    const jobId = randomUUID();
    await createDiagnosis({ jobId, machineId: MACHINE, socketId: client.clientId });
    // POST 回 201 後立即開始注入（背景執行；結束前 await）
    const running = pubsubKillLoop(KILL_SECONDS);
    loop = running;
    // 等 completed 期間迴圈若先失敗，不留浮空 rejection：錯誤在下方 await running 時拋出
    running.catch(() => undefined);

    await client.waitFor(
      () => client.statuses(jobId).some((s) => s.status === "completed" || s.status === "failed"),
      60_000,
      "job/status completed（Pub/Sub 斷線中）",
    );
    const completedAt = Date.now();
    const kill = await running;

    const statuses = client.statuses(jobId);
    const completed = statuses.find((s) => s.status === "completed");
    expect(statuses.map((s) => s.status)).not.toContain("failed");
    expect(completed, "應收到 completed").toBeDefined();
    expect(statuses.at(-1)?.status).toBe("completed");
    const parsed = DiagnosisResultSchema.safeParse(completed?.result);
    expect(parsed.success, "completed.result 應通過 DiagnosisResultSchema").toBe(true);
    expect(completed?.result?.summary).toContain("[fake provider]");
    expect(completed?.cached).toBe(false);
    expect(client.errors(jobId)).toEqual([]);
    expect(client.violations).toEqual([]);
    // 故障確實注入：迴圈至少踢掉過一條 pubsub 連線（api 的 ai-stream subscriber）
    expect(kill.killed).toBeGreaterThan(0);

    console.log(
      `[e2e] 場景 5 耗時 ${completedAt - t0}ms（POST → completed）；斷線迴圈 ${kill.iterations} 輪、踢掉 ${kill.killed} 條 pubsub 連線；` +
        `收到 ai/token ${client.tokens(jobId).length}/20、ai/done ${client.done(jobId) === undefined ? "未到" : "有"}`,
    );
  });
});
