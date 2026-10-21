import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import type { AiToken } from "@flow-gatekeeper/contracts";
import { compose, docker } from "./harness/compose.js";
import { clearDiagnosisCache, workerExitedAt, workerReadyAt, workerReadyBaseline } from "./harness/infra.js";
import { createDiagnosis, E2eClient, sleep } from "./harness/ws-client.js";

/**
 * 場景 3（012 US3、SC-001；plan 風險 1、research P24）：SIGKILL worker → compose 重啟 → BullMQ stalled 偵測重派 → 完成。
 *
 * - 3a 串流中 kill（第 3 個 token 後）；3b 首 token 前 kill（收到 `job/status` progress 20 即 kill：context 已返回、尚未呼叫
 *   LLM；fake 第一個 token 約在 progress 40 後 500 ms，以 20 為觸發點確定落在首 token 前，P24）。
 * - SC-001：使用者看到的最長無事件間隔 `maxGap < 45_000`（前端 watchdog 門檻；設計上界 `K + W + 2S` ≈ 35 s，前提 W ≤ 25 s）。
 *   間隔量整個 job 到 completed 為止（含 kill 前最後一則事件 → kill 後第一則事件那一段，正是要量的空窗）。
 * - `W`（worker 冷啟動，含 compose 重啟延遲）＝ kill 後第一則 `worker ready`（則數基線判定）− 容器 `State.FinishedAt`，
 *   兩者都是 Docker VM 時鐘。W > 25 s 時設計上界不成立：印「上界失效」並判失敗，不放寬（plan 風險 1 要回報使用者）。
 * - 重派可見性：收到 `waiting`＋`reason: "stalled"`，或之後的 `job/status` 帶 `execution ≥ 2`。
 *
 * 機台選 sorter-05（mock telemetry 不注入尖峰，簽章穩定，不與其他檔共用）。3a 完成會留下快取，3b 若命中就測不到
 * 「kill 後重跑 LLM」，故每題 POST 前清空 `ai-cache:*`。
 */

const MACHINE = "sorter-05";
const FAKE_TOKENS = 20;
/** POST 前的硬等：api 每秒 flush 遙測進 Mongo，無可觀測訊號確認已落地（同 diagnosis.e2e.test.ts）。 */
const TELEMETRY_FLUSH_WAIT_MS = 3_000;
/** 3a：收到第幾個 token 後 kill（seq 從 0 起，第 3 個 = seq 2）。 */
const KILL_AFTER_TOKENS = 3;
/** 3b：收到此 progress 即 kill（P24）。 */
const KILL_AT_PROGRESS = 20;
/** SC-001：前端無進展 watchdog 門檻。 */
const MAX_GAP_MS = 45_000;
/** plan 風險 1：W 超過此值時 35 s 設計上界（K + W + 2S）不成立。 */
const MAX_W_MS = 25_000;

describe.skipIf(!process.env.E2E)("跨 process e2e：worker 崩潰後 stalled 重派", () => {
  let client: E2eClient;
  let workerKilled = false;

  beforeAll(async () => {
    client = await E2eClient.connect();
    await client.subscribe([MACHINE]);
    await client.waitFor(() => client.telemetryMachines.has(MACHINE), 15_000, `${MACHINE} 的 machine/data`);
    await sleep(TELEMETRY_FLUSH_WAIT_MS);
  });

  afterAll(async () => {
    client?.close();
    // 保險：場景中途失敗時也把 worker 拉回來（冪等），不影響後續檔案或 E2E_KEEP 排查。
    if (workerKilled) await compose(["start", "worker"]).catch(() => undefined);
  });

  /**
   * 共同流程：POST → 等 `killWhen` 成立 → 取 `worker ready` 基線 → SIGKILL → start → 等完成 → 量 W 與 maxGap，
   * 並做兩題共通的斷言。回傳 kill 前已收到的 `job/status` 則數與 token 數，供各題補自己的斷言。
   */
  async function killAndRecover(
    label: string,
    killWhen: (jobId: string) => boolean,
    killWhat: string,
  ): Promise<{ jobId: string; statusesBeforeKill: number; tokensBeforeKill: number }> {
    const cleared = await clearDiagnosisCache();
    // 觸發點到 kill 之間不放任何 compose 呼叫（Windows 上每次 compose CLI 約 1～2 s，第 3 輪實測讓 3b 的 kill 晚到首 token 之後）：
    // worker ready 基線與容器 id 都在 POST 前先取（POST → kill 之間不會有新的 worker ready），kill 直接 docker kill 容器 id。
    const base = await workerReadyBaseline();
    const { stdout: ids } = await compose(["ps", "-q", "worker"]);
    const workerId = ids.split(/\r?\n/).find((l) => l.trim() !== "")?.trim();
    if (workerId === undefined) throw new Error("找不到執行中的 worker 容器");
    const jobId = randomUUID();
    await createDiagnosis({ jobId, machineId: MACHINE, socketId: client.clientId });
    const postedAt = performance.now();

    await client.waitFor(() => killWhen(jobId), 30_000, killWhat);
    const killAt = performance.now();
    await docker(["kill", "--signal", "KILL", workerId]);
    const killCmdMs = performance.now() - killAt;
    workerKilled = true;
    // 標記 kill 之前已收到的事件數：之後的 job/status 才算「重派後」。
    const statusesBeforeKill = client.statuses(jobId).length;
    const tokensBeforeKill = client.tokens(jobId).length;
    await compose(["start", "worker"]);
    workerKilled = false;

    const afterKill = (): ReturnType<E2eClient["statuses"]> => client.statuses(jobId).slice(statusesBeforeKill);
    await client.waitFor(
      () => afterKill().some((s) => s.status === "completed" || s.status === "failed"),
      180_000,
      `${label} 重派後的 job/status completed`,
    );
    const completedAt = performance.now();

    const readyAt = await workerReadyAt(base);
    const exitedAt = await workerExitedAt();
    const w = readyAt - exitedAt;
    const gap = client.maxGap(jobId, undefined, completedAt);
    const after = afterKill();
    const stalled = after.some((s) => s.status === "waiting" && s.reason === "stalled");
    const maxExecution = Math.max(0, ...after.map((s) => s.execution ?? 0));
    console.log(
      `[e2e] 場景 ${label}：清 ai-cache ${cleared} 鍵；kill 時已收 ${tokensBeforeKill} 個 token（POST 後 ${Math.round(killAt - postedAt)}ms 觸發、docker kill 指令 ${Math.round(killCmdMs)}ms）；` +
        `kill → completed ${Math.round(completedAt - killAt)}ms；W ${w}ms；maxGap ${Math.round(gap)}ms；stalled=${String(stalled)}、最大 execution ${maxExecution}`,
    );

    // plan 風險 1：W 超出就是設計上界失效，先印再判失敗（不放寬）
    if (w > MAX_W_MS) console.log(`[e2e] 場景 ${label}：上界失效（W ${w}ms > ${MAX_W_MS}ms，K + W + 2S 不再 < 45 s）`);
    expect(w, `W（worker 冷啟動）應 ≤ ${MAX_W_MS}ms，否則 35 s 設計上界失效`).toBeLessThanOrEqual(MAX_W_MS);
    expect(gap, `SC-001：maxGap 應 < ${MAX_GAP_MS}ms`).toBeLessThan(MAX_GAP_MS);

    expect(stalled || maxExecution >= 2, "應收到 waiting＋reason:stalled 或 execution ≥ 2").toBe(true);
    const all = client.statuses(jobId).map((s) => s.status);
    expect(all).not.toContain("failed");
    expect(all.at(-1)).toBe("completed");
    const completed = client.statuses(jobId).at(-1);
    expect(DiagnosisResultSchema.safeParse(completed?.result).success).toBe(true);
    expect(completed?.cached).toBe(false);
    expect(client.errors(jobId)).toEqual([]);
    expect(client.violations).toEqual([]);

    return { jobId, statusesBeforeKill, tokensBeforeKill };
  }

  it("3a 串流中 SIGKILL（第 3 個 token 後）→ stalled 重派 → completed；maxGap < 45 s、W ≤ 25 s；第二輪 seq 從 0 重播、attempt 仍為 1", { timeout: 360_000 }, async () => {
    const { jobId, statusesBeforeKill, tokensBeforeKill } = await killAndRecover(
      "3a",
      (id) => client.tokens(id).length >= KILL_AFTER_TOKENS,
      `第 ${KILL_AFTER_TOKENS} 個 ai/token`,
    );
    expect(tokensBeforeKill).toBeGreaterThanOrEqual(KILL_AFTER_TOKENS);
    expect(client.statuses(jobId).slice(0, statusesBeforeKill).map((s) => s.status)).toContain("active");

    // ai/token：切成兩輪——第二輪從「第二次出現 seq 0」開始
    const tokens = client.tokens(jobId);
    const restartIdx = tokens.findIndex((t, i) => i > 0 && t.seq === 0);
    expect(restartIdx, "重派後應再從 seq 0 開始送 token").toBeGreaterThan(0);
    const firstRun: AiToken[] = tokens.slice(0, restartIdx);
    const secondRun: AiToken[] = tokens.slice(restartIdx);
    expect(firstRun.length).toBeLessThan(FAKE_TOKENS);
    expect(firstRun.map((t) => t.seq)).toEqual(Array.from({ length: firstRun.length }, (_, i) => i));
    expect(secondRun.map((t) => t.seq)).toEqual(Array.from({ length: FAKE_TOKENS }, (_, i) => i));
    // stalled 重派不遞增 attemptsMade（契約 ai-stream.ts）：兩輪都是 attempt 1
    expect(new Set(tokens.map((t) => t.attempt))).toEqual(new Set([1]));
    // 第二輪串接全文＝權威結果（completed.result）
    expect(JSON.parse(secondRun.map((t) => t.text).join(""))).toEqual(client.statuses(jobId).at(-1)?.result);
  });

  it("3b 首 token 前 SIGKILL（收到 progress 20 即 kill，P24）→ stalled 重派 → completed；maxGap < 45 s、W ≤ 25 s；token 只有重派那一輪", { timeout: 360_000 }, async () => {
    const { jobId, tokensBeforeKill } = await killAndRecover(
      "3b",
      (id) => client.statuses(id).some((s) => s.progress !== undefined && s.progress >= KILL_AT_PROGRESS),
      `job/status progress ${KILL_AT_PROGRESS}`,
    );
    // kill 落在首 token 前：kill 前零 token，之後只有重派那一輪 seq 0–19
    expect(tokensBeforeKill, "kill 應落在首 token 前（P24）").toBe(0);
    const tokens = client.tokens(jobId);
    expect(tokens.map((t) => t.seq)).toEqual(Array.from({ length: FAKE_TOKENS }, (_, i) => i));
    expect(JSON.parse(tokens.map((t) => t.text).join(""))).toEqual(client.statuses(jobId).at(-1)?.result);
  });
});
