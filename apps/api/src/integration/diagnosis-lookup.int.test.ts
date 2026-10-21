import { randomBytes, randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import type { RedisOptions } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosisJobPayload, DiagnosisJobReturnValue, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { silenceNestLogger } from "../test-support/nest-logger.js";
import { loadApiDotenv } from "../lib/env-file.js";
import { AppConfigService } from "../modules/config/config.service.js";
import { DiagnosisLookupService } from "../modules/jobs/diagnosis-lookup.service.js";
import { JobRoutingRegistry } from "../modules/websocket/job-routing-registry.js";

/**
 * 真 Redis＋BullMQ 整合測試：`DiagnosisLookupService`（012 GET `/diagnoses/:jobId`）對真的 job state／hash 的讀取。
 * 以 `Worker.getNextJob` 手動取件（不跑 processor），再 `moveToCompleted`／`moveToFailed`，確認 GET 依 BullMQ 實際
 * 狀態回 200 active（`rebound`、attempt／execution）、completed（`returnvalue`）、failed（`failedReason`）。
 *
 * 隔離：獨立 db（預設 15，`INTEGRATION_REDIS_DB` 可改）＋本輪隨機的 BullMQ prefix 與佇列名；結束時 obliterate。
 */

loadApiDotenv();
const INTEGRATION_DB = Number(process.env.INTEGRATION_REDIS_DB?.trim() || "15");
const RUN_ID = randomBytes(4).toString("hex");
const PREFIX = `fg-int-lookup-${RUN_ID}`;
const QUEUE = "diagnosis";
const SOCKET = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const TOKEN = `token-${RUN_ID}`;
const UNREACHABLE_HINT =
  "無法連線 Redis。請先在 repo 根目錄執行 `docker compose up -d`，並以 `docker compose ps` 確認 redis 為 healthy。";

const RESULT: DiagnosisResult = {
  summary: "主軸溫度偏高",
  severity: "warning",
  likelyCauses: ["冷卻液不足"],
  suggestedActions: [{ label: "補充冷卻液", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temp=92" }],
};

function payload(jobId: string): DiagnosisJobPayload {
  return {
    jobId,
    machineId: "mixer-01",
    requestedBy: "int-test",
    requestedAt: new Date().toISOString(),
    windowMinutes: 5,
  };
}

describe.runIf(process.env.FG_INTEGRATION === "1")("DiagnosisLookupService × 真 Redis／BullMQ（整合）", () => {
  let queue: Queue<DiagnosisJobPayload, DiagnosisJobReturnValue>;
  let worker: Worker<DiagnosisJobPayload, DiagnosisJobReturnValue>;
  let registry: JobRoutingRegistry;
  let service: DiagnosisLookupService;
  let restoreLogger: () => void = () => undefined;

  beforeAll(async () => {
    restoreLogger = silenceNestLogger();
    const base = new AppConfigService().redisOptions("blocking");
    const connection: RedisOptions = { ...base, db: INTEGRATION_DB, connectTimeout: 3000 };
    queue = new Queue(QUEUE, { connection, prefix: PREFIX });
    worker = new Worker(QUEUE, null, { connection, prefix: PREFIX, autorun: false });
    try {
      await queue.waitUntilReady();
      await worker.waitUntilReady();
    } catch (err) {
      throw new Error(`${UNREACHABLE_HINT}\n原始錯誤：${err instanceof Error ? err.message : String(err)}`);
    }
    registry = new JobRoutingRegistry();
    const presence = { isAuthorized: () => true, isOnline: (id: string) => id === SOCKET };
    service = new DiagnosisLookupService(queue, registry, presence, { findDiagnosisResult: async () => null });
  });

  afterAll(async () => {
    try {
      registry?.onModuleDestroy();
      await worker?.close();
      if (queue) {
        await queue.obliterate({ force: true }).catch(() => {});
        await queue.close();
      }
    } finally {
      restoreLogger();
    }
  });

  /** 入列並以 worker 手動取件，回傳 active 中的 job。 */
  async function addAndTake(): Promise<Job<DiagnosisJobPayload, DiagnosisJobReturnValue>> {
    const jobId = randomUUID();
    await queue.add("diagnose-machine", payload(jobId), { jobId });
    const job = await worker.getNextJob(TOKEN);
    if (!job || job.id !== jobId) throw new Error("getNextJob 沒有取到剛入列的 job");
    return job;
  }

  it("waiting → 200 waiting rebound；api 重啟後的暫定綁定補上 machineId 並保留", async () => {
    const jobId = randomUUID();
    await queue.add("diagnose-machine", payload(jobId), { jobId });
    try {
      // 新 job 的 progress 預設 0、attemptsStarted 0（不帶 execution）。
      await expect(service.lookup({ jobId, socketId: SOCKET })).resolves.toEqual({
        status: "waiting",
        jobId,
        progress: 0,
        attempt: 1,
        rebound: true,
      });
      expect(registry.get(jobId)).toMatchObject({ clientId: SOCKET, machineId: "mixer-01" });
    } finally {
      await queue.remove(jobId); // 不留在 wait，免得下一支的 getNextJob 取到它
    }
  });

  it("active → 200 active（attempt＝attemptsMade+1、execution＝attemptsStarted）；moveToCompleted 後 → 200 completed 並補標終態", async () => {
    const job = await addAndTake();
    const jobId = job.id as string;
    await expect(service.lookup({ jobId, socketId: SOCKET })).resolves.toEqual({
      status: "active",
      jobId,
      attempt: 1,
      progress: 0,
      execution: 1,
      rebound: true,
    });

    await job.moveToCompleted({ result: RESULT, cached: true }, TOKEN, false);
    await expect(service.lookup({ jobId, socketId: SOCKET })).resolves.toEqual({
      status: "completed",
      jobId,
      result: RESULT,
      cached: true,
    });
    // 綁定是本 socket 原本那份（unchanged）：GET 補標終態，照寬限刪除。
    expect(registry.get(jobId)?.terminal?.kind).toBe("completed");
  });

  it("moveToFailed（不重試）→ 200 failed 帶 failedReason 原文；暫定綁定撤回", async () => {
    const job = await addAndTake();
    const jobId = job.id as string;
    await job.moveToFailed(new Error("persist_failed: diagnosis record could not be written"), TOKEN, false);
    await expect(service.lookup({ jobId, socketId: SOCKET })).resolves.toEqual({
      status: "failed",
      jobId,
      error: "persist_failed: diagnosis record could not be written",
    });
    expect(registry.isBound(jobId)).toBe(false);
  });

  it("BullMQ 查無此 job（state unknown）→ 走 Mongo 後援 → 404", async () => {
    await expect(service.lookup({ jobId: randomUUID(), socketId: SOCKET })).rejects.toMatchObject({ status: 404 });
  });
});
