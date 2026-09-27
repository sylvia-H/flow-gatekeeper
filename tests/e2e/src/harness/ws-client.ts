import WebSocket from "ws";
import type { RawData } from "ws";
import {
  AiDoneSchema,
  AiErrorSchema,
  AiTokenSchema,
  CreateDiagnosisResponseSchema,
  isTelemetryBatch,
  JobStatusSchema,
  MachineSubscribedSchema,
  PongSchema,
  SystemConnectedSchema,
  SystemMetricsSchema,
  SystemUnauthorizedSchema,
} from "@flow-gatekeeper/contracts";
import type {
  AiDone,
  AiError,
  AiToken,
  CreateDiagnosisBody,
  CreateDiagnosisResponse,
  JobStatus,
  MachineSubscribe,
} from "@flow-gatekeeper/contracts";
import { BASE_URL, WS_URL } from "./compose.js";

/** 通過契約驗證後的單則（非遙測）伺服器訊息。 */
export type ParsedMessage =
  | { type: "job/status"; msg: JobStatus }
  | { type: "ai/token"; msg: AiToken }
  | { type: "ai/done"; msg: AiDone }
  | { type: "ai/error"; msg: AiError }
  | { type: "other"; msg: { type: string } };

/** 每則訊息以對應的契約 schema `safeParse`（與 web 入口同一道檢查）；不符者記入 `violations`。 */
const SCHEMAS = {
  "system/connected": SystemConnectedSchema,
  "machine/subscribed": MachineSubscribedSchema,
  "system/metrics": SystemMetricsSchema,
  "system/unauthorized": SystemUnauthorizedSchema,
  pong: PongSchema,
} as const;

interface Waiter {
  predicate: () => boolean;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * e2e 用的原生 `ws` client（CLAUDE.md 硬規則 2：不用 Socket.IO）：收下所有訊息、逐則以契約驗證，
 * 提供「等到某條件成立」的等待原語。遙測批次只計數（高頻、與診斷斷言無關）。
 */
export class E2eClient {
  readonly messages: ParsedMessage[] = [];
  /** 未通過契約驗證的訊息（原文＋原因）；每個場景結束時斷言為空。 */
  readonly violations: string[] = [];
  telemetryFrames = 0;
  /** 收到過 `machine/data` 的機台。 */
  readonly telemetryMachines = new Set<string>();
  clientId = "";
  private waiters: Waiter[] = [];
  /** 連線已關閉的原因；之後的 waitFor 立即 reject，不必空等到逾時。 */
  private closedReason: string | undefined;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: RawData) => this.onMessage(data));
    // 常駐 error listener 從建構起就在：沒有 listener 時 EventEmitter 會直接 throw（未捕捉例外讓 vitest worker 崩潰）。
    // ws 在 error 之後必定接著 emit close，waiter 的失敗由 watchClose 的 close handler 統一處理。
    ws.on("error", () => undefined);
  }

  /** 連線中途被關（api 重啟、nginx 斷線）時讓所有 pending waiter 立即失敗並帶上 code／reason。 */
  private watchClose(): void {
    this.ws.on("close", (code: number, reason: Buffer) => {
      this.closedReason = `WebSocket 已關閉（code ${code}${reason.length > 0 ? `，reason: ${reason.toString("utf8")}` : ""}）`;
      const pending = this.waiters;
      this.waiters = [];
      for (const w of pending) w.reject(new Error(this.closedReason));
    });
  }

  /** 連線並等到 `system/connected`（取得 clientId）。 */
  static async connect(timeoutMs = 10_000): Promise<E2eClient> {
    const ws = new WebSocket(WS_URL);
    const client = new E2eClient(ws);
    // 握手階段也要有逾時：nginx 收了 TCP 但 upstream 不回 upgrade 時 open／error 都不會觸發，
    // 沒有計時器就會掛到 vitest 逾時且 socket 不會被 terminate。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`WebSocket 握手逾時（${timeoutMs} ms）：${WS_URL}`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    client.watchClose();
    try {
      await client.waitFor(() => client.clientId !== "", timeoutMs, "system/connected");
    } catch (err) {
      ws.terminate(); // 未關的 socket 會讓 vitest 掛著不結束
      throw err;
    }
    return client;
  }

  /** 送 `machine/subscribe` 並等 `machine/subscribed` 回執含所有指定機台。 */
  async subscribe(machineIds: string[], timeoutMs = 10_000): Promise<void> {
    const msg: MachineSubscribe = { type: "machine/subscribe", token: "", machineIds };
    this.ws.send(JSON.stringify(msg));
    await this.waitFor(
      () =>
        this.messages.some((m) => {
          if (m.type !== "other" || m.msg.type !== "machine/subscribed") return false;
          const parsed = MachineSubscribedSchema.safeParse(m.msg);
          return parsed.success && machineIds.every((id) => parsed.data.machineIds.includes(id));
        }),
      timeoutMs,
      "machine/subscribed",
    );
  }

  close(): void {
    this.ws.close();
  }

  /** 等到 predicate 成立；逾時 reject 並附上說明。 */
  waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    if (this.closedReason !== undefined) {
      return Promise.reject(new Error(`等待「${what}」失敗：${this.closedReason}`));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(new Error(`等待「${what}」失敗：${err.message}`));
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待「${what}」逾時（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  statuses(jobId: string): JobStatus[] {
    return this.messages.flatMap((m) => (m.type === "job/status" && m.msg.jobId === jobId ? [m.msg] : []));
  }

  tokens(jobId: string): AiToken[] {
    return this.messages.flatMap((m) => (m.type === "ai/token" && m.msg.jobId === jobId ? [m.msg] : []));
  }

  done(jobId: string): AiDone | undefined {
    for (const m of this.messages) if (m.type === "ai/done" && m.msg.jobId === jobId) return m.msg;
    return undefined;
  }

  errors(jobId: string): AiError[] {
    return this.messages.flatMap((m) => (m.type === "ai/error" && m.msg.jobId === jobId ? [m.msg] : []));
  }

  /** 該 job 的診斷事件（job/status、ai/*）依收到順序。 */
  jobEvents(jobId: string): ParsedMessage[] {
    return this.messages.filter((m) => m.type !== "other" && m.msg.jobId === jobId);
  }

  private onMessage(data: RawData): void {
    const raw = rawToString(data);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.violations.push(`非 JSON：${raw.slice(0, 200)}`);
      return;
    }
    if (Array.isArray(value)) {
      if (isTelemetryBatch(value)) {
        this.telemetryFrames++;
        for (const p of value) this.telemetryMachines.add(p.machineId);
      } else {
        this.violations.push(`畸形 machine/data 批次：${raw.slice(0, 200)}`);
      }
    } else {
      this.classify(value, raw);
    }
    this.flushWaiters();
  }

  private classify(value: unknown, raw: string): void {
    const type = typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
    const fail = (reason: string): void => {
      this.violations.push(`${String(type)} 不符契約（${reason}）：${raw.slice(0, 300)}`);
    };
    switch (type) {
      case "job/status": {
        const r = JobStatusSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data });
        else fail(r.error.message);
        return;
      }
      case "ai/token": {
        const r = AiTokenSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data });
        else fail(r.error.message);
        return;
      }
      case "ai/done": {
        const r = AiDoneSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data });
        else fail(r.error.message);
        return;
      }
      case "ai/error": {
        const r = AiErrorSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data });
        else fail(r.error.message);
        return;
      }
      default: {
        if (typeof type !== "string" || !(type in SCHEMAS)) {
          fail("未知的 type");
          return;
        }
        const r = SCHEMAS[type as keyof typeof SCHEMAS].safeParse(value);
        if (!r.success) {
          fail(r.error.message);
          return;
        }
        if (r.data.type === "system/connected") this.clientId = r.data.clientId;
        this.messages.push({ type: "other", msg: r.data });
      }
    }
  }

  private flushWaiters(): void {
    const ready = this.waiters.filter((w) => w.predicate());
    if (ready.length === 0) return;
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** `POST /diagnoses`（經 nginx 同源入口）；回傳狀態碼與 JSON body。 */
export async function postDiagnosis(body: CreateDiagnosisBody): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/diagnoses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON（例如 nginx 的 429／502 HTML）照原文回傳，交給斷言訊息呈現
  }
  return { status: res.status, body: parsed };
}

/** 成功建立診斷：斷言 201 且回應符合 `CreateDiagnosisResponseSchema`。 */
export async function createDiagnosis(body: CreateDiagnosisBody): Promise<CreateDiagnosisResponse> {
  const res = await postDiagnosis(body);
  if (res.status !== 201) {
    throw new Error(`POST /diagnoses 預期 201，實得 ${res.status}：${JSON.stringify(res.body)}`);
  }
  return CreateDiagnosisResponseSchema.parse(res.body);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
