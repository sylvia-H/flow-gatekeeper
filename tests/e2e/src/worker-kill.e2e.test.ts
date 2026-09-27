import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiToken } from "@flow-gatekeeper/contracts";
import { compose } from "./harness/compose.js";
import { createDiagnosis, E2eClient, sleep } from "./harness/ws-client.js";

/**
 * 場景 3：串流中途 SIGKILL worker → 重啟 → BullMQ stalled 偵測把 job 放回 wait → 重跑完成。
 *
 * 機台選 sorter-05：與 mixer-01 同樣沒有尖峰（state 恆 healthy），但簽章不同——不會命中場景 1 的快取，
 * 一定真的走 LLM 串流路徑。
 *
 * 現況語意（如實斷言，見契約 ai-stream.ts 的 `attempt` 註解與審查報告 AR-3）：
 * - stalled 重派**不**遞增 BullMQ `attemptsMade` → 重跑的 `ai/token` 仍是 `attempt: 1`，但 `seq` 從 0 重新開始；
 *   消費端要以「同一 attempt 內再見 seq 0」判定換輪。
 * - api 的 job-status relay 未監聽 `stalled` 事件；前端看得到的是 BullMQ `moveJobToWait` 附帶的 `waiting`，
 *   接著第二次 `active`。
 * - 死掉的持鎖者留下的 `ai-lock` 要等 TTL（e2e 設 20s）過期，重派的 job 才取得到鎖；
 *   BullMQ job lock（30s）過期後 stalled 檢查才會認定 stalled。故整段可能要 30–90 秒。
 */

const MACHINE = "sorter-05";
const FAKE_TOKENS = 20;
/**
 * POST 前的硬等：api 每秒把遙測 flush 進 Mongo，但沒有任何可觀測訊號（WS／HTTP）能確認「已落地」，
 * 只能等兩個 flush 週期再多一點，確保 worker 讀得到脈絡、不走 no_context。
 */
const TELEMETRY_FLUSH_WAIT_MS = 3_000;
/** 收到第幾個 token 後 kill（seq 從 0 起，第 3 個 = seq 2）。 */
const KILL_AFTER_TOKENS = 3;

describe.skipIf(!process.env.E2E)("跨 process e2e：worker 崩潰後 stalled 重派", () => {
  let client: E2eClient;

  beforeAll(async () => {
    client = await E2eClient.connect();
    await client.subscribe([MACHINE]);
    await client.waitFor(() => client.telemetryMachines.has(MACHINE), 15_000, `${MACHINE} 的 machine/data`);
    await sleep(TELEMETRY_FLUSH_WAIT_MS);
  });

  afterAll(async () => {
    client?.close();
    // 保險：場景中途失敗時也把 worker 拉回來（冪等），不影響後續檔案或 E2E_KEEP 排查。
    await compose(["start", "worker"]).catch(() => undefined);
  });

  it("場景 3 SIGKILL worker 於第 3 個 token → 重啟後 seq 從 0 重播、attempt 仍為 1、出現第二次 active、最終 ai/done", { timeout: 360_000 }, async () => {
    const t0 = Date.now();
    const jobId = randomUUID();
    await createDiagnosis({ jobId, machineId: MACHINE, socketId: client.clientId });

    await client.waitFor(() => client.tokens(jobId).length >= KILL_AFTER_TOKENS, 30_000, `第 ${KILL_AFTER_TOKENS} 個 ai/token`);
    const tKill = Date.now();
    await compose(["kill", "-s", "SIGKILL", "worker"]);
    // 標記 kill 之前已收到的事件數：之後的 job/status 才算「重派後」。
    const statusesBeforeKill = client.statuses(jobId).length;
    await compose(["start", "worker"]);
    console.log(`[e2e] 場景 3：第 ${KILL_AFTER_TOKENS} 個 token 於 POST 後 ${tKill - t0}ms 到達，已 kill 並重啟 worker`);

    // 分段計時（供排查 stalled 偵測延遲）：重派的 waiting → 第二次 active → 完成。
    const afterKill = (): string[] => client.statuses(jobId).slice(statusesBeforeKill).map((s) => s.status);
    await client.waitFor(() => afterKill().includes("waiting"), 150_000, "stalled 重派的 job/status waiting");
    const tRequeued = Date.now();
    await client.waitFor(() => afterKill().includes("active"), 60_000, "重派後第二次 active");
    const tReactive = Date.now();
    await client.waitFor(
      () => client.done(jobId) !== undefined && client.statuses(jobId).some((s) => s.status === "completed"),
      60_000,
      "重派後的 ai/done 與 completed",
    );
    const tDone = Date.now();
    console.log(
      `[e2e] 場景 3 分段：kill → waiting ${tRequeued - tKill}ms、→ 第二次 active ${tReactive - tKill}ms、→ completed ${tDone - tKill}ms`,
    );

    // ai/token：切成兩輪——第二輪從「第二次出現 seq 0」開始
    const tokens = client.tokens(jobId);
    const restartIdx = tokens.findIndex((t, i) => i > 0 && t.seq === 0);
    expect(restartIdx, "重派後應再從 seq 0 開始送 token").toBeGreaterThan(0);
    const firstRun: AiToken[] = tokens.slice(0, restartIdx);
    const secondRun: AiToken[] = tokens.slice(restartIdx);
    expect(firstRun.length).toBeGreaterThanOrEqual(KILL_AFTER_TOKENS);
    expect(firstRun.length).toBeLessThan(FAKE_TOKENS);
    expect(firstRun.map((t) => t.seq)).toEqual(Array.from({ length: firstRun.length }, (_, i) => i));
    expect(secondRun.map((t) => t.seq)).toEqual(Array.from({ length: FAKE_TOKENS }, (_, i) => i));
    // stalled 重派不遞增 attemptsMade（契約 ai-stream.ts）：兩輪都是 attempt 1
    expect(new Set(tokens.map((t) => t.attempt))).toEqual(new Set([1]));

    const done = client.done(jobId);
    expect(done?.cached).toBe(false);
    expect(done?.attempt).toBe(1);
    expect(JSON.parse(secondRun.map((t) => t.text).join(""))).toEqual(done?.result);
    expect(client.errors(jobId)).toEqual([]);

    // job/status：kill 前已 active；重派後先 waiting（moveJobToWait 事件）再第二次 active，最後 completed
    const all = client.statuses(jobId).map((s) => s.status);
    const after = all.slice(statusesBeforeKill);
    expect(all.slice(0, statusesBeforeKill)).toContain("active");
    expect(after).toContain("waiting");
    expect(after.indexOf("active")).toBeGreaterThan(after.indexOf("waiting"));
    expect(after.at(-1)).toBe("completed");
    expect(all).not.toContain("failed");
    // 重派後進度從 0 重新走一次里程碑
    const afterProgress = client
      .statuses(jobId)
      .slice(statusesBeforeKill)
      .flatMap((s) => (s.progress === undefined ? [] : [s.progress]));
    expect(afterProgress).toEqual([0, 20, 40, 60, 80, 100]);

    expect(client.violations).toEqual([]);
    console.log(`[e2e] 場景 3 耗時 ${tDone - t0}ms（POST → completed）；kill → completed ${tDone - tKill}ms`);
  });
});
