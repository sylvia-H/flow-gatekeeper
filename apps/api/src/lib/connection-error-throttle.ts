import { ConnectionErrorThrottle } from "@flow-gatekeeper/shared/logging";

// 轉態節流器 `ConnectionErrorThrottle` 與通用節流窗常數 `ERROR_LOG_THROTTLE_MS` 已收進
// `@flow-gatekeeper/shared/logging`（與 worker 共用同一份實作）；此檔只留 ioredis 事件接線。

/** 可掛 `error`／`ready` 監聽的連線（ioredis `Redis` 即符合）。 */
export type ConnectionEvents = {
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "ready", listener: () => void): unknown;
};

export type ThrottledConnectionLog = {
  /** 放行的錯誤；`suppressed` 為上次放行以來壓掉的則數。 */
  error(err: Error, suppressed: number): void;
  /** 故障後恢復。 */
  recovered(suppressed: number): void;
};

/**
 * BullMQ 的 `Queue`／`QueueEvents` 共有的形狀：自身轉發底層連線的 `error`，`client` 是底層 ioredis
 * 連線（第一次 ready 才 resolve）。
 */
export type BullmqEmitter = {
  on(event: "error", listener: (err: Error) => void): unknown;
  readonly client: Promise<{ on(event: "ready", listener: () => void): unknown; readonly status: string }>;
};

/**
 * 把 BullMQ 的 `Queue`／`QueueEvents` 轉成節流器要的 `error`／`ready` 事件介面。兩者都只轉發
 * `error`、不發 `ready`，恢復訊號取自底層 ioredis 連線（重連成功時發 `ready`）。`client` 要等第一次
 * `ready` 才 resolve，掛上監聽時那一次已經發過——此時連線若已是 ready 就補觸發一次，否則開機期間的
 * 故障永遠記不到恢復。取連線失敗（例如關閉中）時只是收不到恢復訊號，不影響 error 監聽本身。
 *
 * `Queue` 尤其 MUST 掛上 error 監聽：bullmq 的 `QueueBase.emit` 在沒有監聽者時直接
 * `console.error(err)`，ioredis 的 `ReplyError` 會把 `command.args`（AUTH 時即 `REDIS_PASSWORD`）
 * 明文寫進 stderr，完全繞過 pino 的遮蔽（API-1）。
 */
export function bullmqConnection(emitter: BullmqEmitter): ConnectionEvents {
  return {
    on(event: "error" | "ready", listener: ((err: Error) => void) | (() => void)) {
      if (event === "error") {
        emitter.on("error", listener);
      } else {
        const onReady = listener as () => void;
        emitter.client.then(
          (client) => {
            client.on("ready", onReady);
            if (client.status === "ready") onReady();
          },
          () => undefined,
        );
      }
      return undefined;
    },
  };
}

/**
 * 把 `ConnectionErrorThrottle` 接到連線的 `error`／`ready` 事件上。`error` 監聽 MUST 存在
 * （沒有監聽者時 EventEmitter 會把 error 當未捕捉例外拋出、行程結束），故此處一律掛上，只是節流輸出。
 */
export function attachThrottledErrorLog(
  connection: ConnectionEvents,
  log: ThrottledConnectionLog,
  opts: { intervalMs?: number; now?: () => number } = {},
): ConnectionErrorThrottle {
  const throttle = new ConnectionErrorThrottle(opts.intervalMs);
  const now = opts.now ?? Date.now;
  connection.on("error", (err) => {
    const decision = throttle.onError(now());
    if (decision.log) log.error(err, decision.suppressed);
  });
  connection.on("ready", () => {
    const decision = throttle.onReady();
    if (decision.log) log.recovered(decision.suppressed);
  });
  return throttle;
}
