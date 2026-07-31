import { Injectable, type LoggerService } from "@nestjs/common";
import type { FlowLogger } from "@flow-gatekeeper/shared/logging";

type UnknownArgs = readonly unknown[];

/** 仿 Nest `ConsoleLogger.isStackFormat`：判斷是否為典型的 Error stack 格式。 */
function isStackFormat(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^(.)+\n\s+at .+:\d+:\d+/.test(value);
}

/**
 * 拆出 context 與其餘訊息。**`args` MUST 含 `message` 作為第一個元素**（`[message,
 * ...optionalParams]`）——這與 Nest 內建 `ConsoleLogger.getContextAndMessagesToPrint` 的
 * 呼叫方式完全一致（該方法內部也是以 `[message, ...optionalParams]` 為輸入）：Nest 的
 * `Logger` 實例持有 context 時，會把 context 字串 concat 到 optionalParams 最後一位再呼叫
 * `localInstance.log(message, ...optionalParams)`；若在這裡改用「只傳 optionalParams」
 * 會在 optionalParams 長度為 1（最常見情形：呼叫端只傳一個 message、context 來自建構子）時
 * 誤判成「無 context」，見 T013 修正記錄。此演算法對齊框架，才能同時正確處理本專案 6 個
 * 呼叫點與框架自身的內部日誌呼叫。
 */
function splitContextAndMessages(args: UnknownArgs): {
  context: string | undefined;
  messages: UnknownArgs;
} {
  if (args.length <= 1) return { context: undefined, messages: args };
  const last = args[args.length - 1];
  if (typeof last !== "string") return { context: undefined, messages: args };
  return { context: last, messages: args.slice(0, -1) };
}

/**
 * `error()` 額外可能帶 stack。`args` 同樣 MUST 含 `message`——對齊
 * `ConsoleLogger.getContextAndStackAndMessagesToPrint`。
 */
function splitContextStackAndMessages(args: UnknownArgs): {
  context: string | undefined;
  stack: string | undefined;
  messages: UnknownArgs;
} {
  if (args.length === 2) {
    return isStackFormat(args[1])
      ? { messages: [args[0]], stack: args[1], context: undefined }
      : { messages: [args[0]], context: args[1] as string, stack: undefined };
  }
  const { context, messages } = splitContextAndMessages(args);
  if (messages.length <= 1) return { context, messages, stack: undefined };
  const last = messages[messages.length - 1];
  if (typeof last !== "string" && last !== undefined) {
    return { context, messages, stack: undefined };
  }
  return { context, stack: last, messages: messages.slice(0, -1) };
}

type PinoWriteLevel = "info" | "error" | "warn" | "debug" | "trace";

/**
 * Nest `LoggerService` adapter：把 Nest 的 `log/error/warn/debug/verbose` 映射到 pino
 * 對應等級（`log→info`、`verbose→trace`，其餘同名），並把 Nest 的 context 參數原樣帶入
 * 結構化的 `context` 欄位（contracts/log-fields.md §3）。經 `NestFactory.create(AppModule,
 * { logger })` 整批接管——api 現況已全面使用 Nest 內建 `Logger`（6 處呼叫點 + 框架自身的
 * 啟動/生命週期訊息），不需逐檔改寫呼叫點即可整批轉為結構化輸出（research R1）。
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: FlowLogger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    const { context, messages } = splitContextAndMessages([message, ...optionalParams]);
    this.write("info", messages, context);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    const { context, stack, messages } = splitContextStackAndMessages([message, ...optionalParams]);
    this.write("error", messages, context, stack);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    const { context, messages } = splitContextAndMessages([message, ...optionalParams]);
    this.write("warn", messages, context);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    const { context, messages } = splitContextAndMessages([message, ...optionalParams]);
    this.write("debug", messages, context);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const { context, messages } = splitContextAndMessages([message, ...optionalParams]);
    this.write("trace", messages, context);
  }

  private write(
    level: PinoWriteLevel,
    messages: UnknownArgs,
    context: string | undefined,
    stack?: string,
  ): void {
    const [rawMessage, ...extraMessages] = messages;
    const bindings: Record<string, unknown> = {};
    if (context) bindings.context = context;
    if (stack) bindings.err = { stack };
    if (extraMessages.length > 0) bindings.extra = extraMessages;
    const msg = typeof rawMessage === "string" ? rawMessage : JSON.stringify(rawMessage);
    this.logger[level](bindings, msg);
  }
}
