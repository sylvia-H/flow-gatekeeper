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

/**
 * 通過契約驗證後的單則（非遙測）伺服器訊息。
 *
 * `receivedAt`：client 收到該 frame 的時刻（`performance.now()`，單調時鐘、毫秒）——只用來算相鄰事件的間隔
 * （`maxGap`），不與 Date／容器日誌時間比較。
 */
export type ParsedMessage = (
  | { type: "job/status"; msg: JobStatus }
  | { type: "ai/token"; msg: AiToken }
  | { type: "ai/done"; msg: AiDone }
  | { type: "ai/error"; msg: AiError }
  | { type: "other"; msg: { type: string } }
) & { receivedAt: number };

/**
 * 一串收到時刻（遞增）中相鄰兩者差的最大值；可選的 `[from, to]` 只取落在區間內的時刻（含端點）。
 * 少於兩個時刻時回 0（沒有任何間隔可量）。純函式，供 `E2eClient.maxGap` 與單元測試使用。
 */
export function computeMaxGap(times: readonly number[], from = -Infinity, to = Infinity): number {
  let max = 0;
  let prev: number | undefined;
  for (const t of times) {
    if (t < from || t > to) continue;
    if (prev !== undefined && t - prev > max) max = t - prev;
    prev = t;
  }
  return max;
}

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

  /**
   * 該 job 的診斷事件（`job/status`＋`ai/*`）相鄰收到時間差的最大值（毫秒，SC-001 判準 `< 45_000`）。
   * `from`／`to` 為 `performance.now()` 刻度的可選區間（含端點），只量區間內的事件；不足兩則事件時回 0。
   */
  maxGap(jobId: string, from?: number, to?: number): number {
    return computeMaxGap(
      this.jobEvents(jobId).map((m) => m.receivedAt),
      from,
      to,
    );
  }

  private onMessage(data: RawData): void {
    // 先取時間戳再做任何解析：量的是「frame 到達」的間隔，不含 JSON parse／schema 驗證耗時。
    const receivedAt = performance.now();
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
      this.classify(value, raw, receivedAt);
    }
    this.flushWaiters();
  }

  private classify(value: unknown, raw: string, receivedAt: number): void {
    const type = typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
    const fail = (reason: string): void => {
      this.violations.push(`${String(type)} 不符契約（${reason}）：${raw.slice(0, 300)}`);
    };
    switch (type) {
      case "job/status": {
        const r = JobStatusSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data, receivedAt });
        else fail(r.error.message);
        return;
      }
      case "ai/token": {
        const r = AiTokenSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data, receivedAt });
        else fail(r.error.message);
        return;
      }
      case "ai/done": {
        const r = AiDoneSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data, receivedAt });
        else fail(r.error.message);
        return;
      }
      case "ai/error": {
        const r = AiErrorSchema.safeParse(value);
        if (r.success) this.messages.push({ type, msg: r.data, receivedAt });
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
        this.messages.push({ type: "other", msg: r.data, receivedAt });
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
  return { status: res.status, body: await readBody(res) };
}

/** 回應 body：JSON 就 parse，否則（例如 nginx 的 429／502 HTML）照原文回傳，交給斷言訊息呈現。 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** `GET /diagnoses/:jobId` 的 URL（query 以 URLSearchParams 編碼；`previousSocketId` 只在有給時附上）。 */
export function diagnosisLookupUrl(jobId: string, socketId: string, previousSocketId?: string): string {
  const query = new URLSearchParams({ socketId });
  if (previousSocketId !== undefined) query.set("previousSocketId", previousSocketId);
  return `${BASE_URL}/diagnoses/${encodeURIComponent(jobId)}?${query.toString()}`;
}

/**
 * `GET /diagnoses/:jobId?socketId=…[&previousSocketId=…]`（經 nginx 同源入口，FR-005／SC-003／SC-005）。
 *
 * 任何 HTTP 狀態碼都照實回傳、不丟錯——404／409／400 由場景自己斷言。連線層失敗（api 重啟中 nginx 之外的
 * 斷線、ECONNREFUSED）同樣不丟錯，回 `status: 0` 與錯誤訊息，讓「重啟後輪詢到 200」的場景可以直接重試。
 */
export async function getDiagnosis(
  jobId: string,
  socketId: string,
  previousSocketId?: string,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    // 10 s 上限：api 重啟中 nginx 收了連線卻遲遲不回時，不讓單次 GET 掛到 vitest 逾時（逾時同樣回 status 0）
    res = await fetch(diagnosisLookupUrl(jobId, socketId, previousSocketId), { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { status: 0, body: err instanceof Error ? err.message : String(err) };
  }
  return { status: res.status, body: await readBody(res) };
}

/**
 * 重連流程（場景 6a／6b）：關掉舊 client（已被 api 重啟斷開時為 no-op）、新建 `E2eClient`、`connect`＋`subscribe`，
 * 回傳新 client 與它的 `clientId`（＝之後 GET 要帶的 `socketId`；舊的 `old.clientId` 即 `previousSocketId`）。
 * 失敗時新 client 會被關閉後再拋出，不留未關的 socket 讓 vitest 掛著。
 */
export async function reconnectClient(
  old: E2eClient,
  machineIds: string[],
  timeoutMs = 10_000,
): Promise<{ client: E2eClient; clientId: string }> {
  old.close();
  const client = await E2eClient.connect(timeoutMs);
  try {
    await client.subscribe(machineIds, timeoutMs);
  } catch (err) {
    client.close();
    throw err;
  }
  return { client, clientId: client.clientId };
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
