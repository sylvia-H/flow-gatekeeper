import { writeSync } from "node:fs";

/**
 * api 的行程級致命處理（let it crash，與 worker 語意對齊）。
 *
 * 未處理的例外／rejection 發生後，行程狀態已不可信：記一則 fatal 後立即 `exit(1)`，交由
 * 監督者（compose `restart: on-failure`）重啟乾淨的行程。exit code 即監督語意：`1` 重啟、
 * 優雅關閉 `0` 不重啟。
 *
 * 為什麼不直接呼叫 pino 的 `logger.fatal()`：pino 的寫入是非同步的（pretty 模式還經過 worker
 * thread transport），緊接著 `process.exit(1)` 會在緩衝 flush 前中止行程、丟掉唯一重要的那一行。
 * 因此這裡自己組一行**與 pino 輸出同形**的 JSON（`level: 60`、`time`、`service`、`context`、
 * `err{type,message,stack}`、`msg`），用 `writeSync` 同步寫到 stdout，保證退出前落地，
 * 也讓 log 收集端照常以 JSON 解析、不需要為崩潰行另開規則。
 */

export type FatalKind = "uncaughtException" | "unhandledRejection" | "bootstrap";

type SerializedError = {
  type: string;
  message: string;
  stack?: string;
  /** Zod 等驗證錯誤的 issue 摘要：讓「環境變數設定錯誤」在崩潰行裡直接可讀。 */
  issues?: string[];
};

/** pino `level: fatal` 的數值。 */
const PINO_FATAL = 60;

function serializeError(value: unknown): SerializedError {
  if (value instanceof Error) {
    const out: SerializedError = {
      type: value.name || value.constructor?.name || "Error",
      message: value.message,
      stack: value.stack,
    };
    const issues = (value as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      out.issues = issues.slice(0, 20).map((issue) => {
        const i = issue as { path?: unknown; message?: unknown };
        const path = Array.isArray(i.path) && i.path.length > 0 ? i.path.join(".") : "(root)";
        // ZodError issue 的 message 恆為字串；非字串一律視為缺漏（避免物件被序列化成 "[object Object]"）。
        const message = typeof i.message === "string" ? i.message : "invalid";
        return `${path}: ${message}`;
      });
    }
    return out;
  }
  return { type: typeof value, message: String(value) };
}

/** 純函式：組 fatal log 的單行 JSON（不含換行）。 */
export function formatFatalLog(kind: FatalKind, value: unknown, now: Date = new Date()): string {
  let line: string;
  try {
    // serializeError 也放在 try 內：reason 可能是 Object.create(null) 或 toString 會拋的物件，
    // 致命路徑本身絕不能再拋，否則唯一重要的那一行會遺失。
    const err = serializeError(value);
    const hint = err.issues?.length ? ` (${err.issues.join("; ")})` : "";
    line = JSON.stringify({
      level: PINO_FATAL,
      time: now.getTime(),
      pid: process.pid,
      service: "api",
      context: "fatal",
      kind,
      err,
      msg: `${kind}: ${err.message}${hint} - api exiting with code 1 for supervisor restart`,
    });
  } catch {
    line = JSON.stringify({
      level: PINO_FATAL,
      time: now.getTime(),
      service: "api",
      context: "fatal",
      kind,
      msg: `${kind}: <unserializable reason> - api exiting with code 1 for supervisor restart`,
    });
  }
  return line;
}

/** 同步寫出 fatal log 後以 exit code 1 結束行程。 */
export function fatalExit(kind: FatalKind, value: unknown): never {
  try {
    writeSync(1, `${formatFatalLog(kind, value)}\n`);
  } catch {
    // stdout 已關閉也要照樣退出，不能讓致命處理自己卡住。
  }
  process.exit(1);
}

let installed = false;

/**
 * 掛上行程級致命 handler（冪等）。只在 entry 真的被執行時呼叫，被 import（entry smoke 測試）
 * 時不掛，維持 import 無副作用。
 */
export function installFatalHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (err) => fatalExit("uncaughtException", err));
  process.on("unhandledRejection", (reason) => fatalExit("unhandledRejection", reason));
}
