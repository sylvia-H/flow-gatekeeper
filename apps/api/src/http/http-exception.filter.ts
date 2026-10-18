import { STATUS_CODES } from "node:http";
import { Catch, HttpException, IntrinsicException } from "@nestjs/common";
import type { ArgumentsHost, HttpServer, NestApplicationOptions } from "@nestjs/common";
import { BaseExceptionFilter, HttpAdapterHost, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ERROR_LOG_THROTTLE_MS, LogThrottle } from "@flow-gatekeeper/shared/logging";
import type { ChildLogger } from "@flow-gatekeeper/shared/logging";
import { getAppLogger } from "../logging/app-logger.js";
import { withoutRequestBody } from "../logging/without-request-body.js";
import { throttledFields } from "../lib/throttled-log.js";

/**
 * request body 上限（API-7，裁決 6）。唯一的 body 端點 `POST /diagnoses` 正常請求不到 300 bytes；
 * express 預設 100 kb 只是讓任何人能以大 body 白白佔用解析時間與記憶體。
 */
export const REQUEST_BODY_LIMIT = "16kb";

/** 交給 `NestFactory.create` 的選項：body parser 改由 `configureHttpApp` 自行掛（見該函式）。 */
const HTTP_APP_OPTIONS = { bodyParser: false } as const;

/** 對外固定英文訊息：不回顯輸入（JSON 解析錯誤的原訊息會引用請求本文片段）。 */
const BODY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "entity.parse.failed": "Invalid JSON body",
  "entity.too.large": "Payload too large",
};

/** 未知錯誤（含 >=500）的對外訊息，與 Nest 預設的 `UNKNOWN_EXCEPTION_MESSAGE` 同字。 */
const INTERNAL_ERROR_MESSAGE = "Internal server error";

function fixedMessage(status: number, type?: string): string {
  return (type !== undefined ? BODY_ERROR_MESSAGES[type] : undefined) ?? STATUS_CODES[status] ?? "Request error";
}

/**
 * body-parser 錯誤換成的錯誤：只帶狀態碼與 body-parser 的 `type`，訊息固定英文、不帶 `body`。
 * 刻意不是 `SyntaxError`：Nest 的 router 會把 `SyntaxError` 換成 `BadRequestException(err.message)`，
 * filter 就認不出它來自 body-parser，回應也會回顯 JSON 解析訊息裡的請求本文片段。
 */
export class RequestBodyError extends Error {
  override readonly name = "RequestBodyError";
  readonly statusCode: number;

  constructor(
    readonly status: number,
    readonly type: string,
  ) {
    super(fixedMessage(status, type));
    this.statusCode = status;
  }
}

/** body-parser（經 http-errors 建立）的錯誤：帶字串 `type` 與 4xx／5xx 狀態碼。 */
function isBodyParserError(err: unknown): err is { status: number; type: string } {
  if (typeof err !== "object" || err === null) return false;
  const { type } = err as { type?: unknown };
  return typeof type === "string" && httpErrorStatus(err) !== undefined;
}

/**
 * express error middleware（四個參數才會被 express 當成 error handler）：緊接在 body parser 之後，
 * 把 4xx 的 body-parser 錯誤換成 `RequestBodyError`，其餘錯誤原樣往下傳給 Nest。
 *
 * 5xx（`stream.encoding.set`、`stream.not.readable` 等，屬程式或執行環境問題）不換：原樣往下傳，
 * filter 記 error 時保留原 message 與 stack 供診斷（先經 `withoutRequestBody`）。這類錯誤不是
 * `SyntaxError`，Nest 的 router 不會改寫它。
 */
export function normalizeBodyParserError(
  err: unknown,
  _req: unknown,
  _res: unknown,
  next: (err?: unknown) => void,
): void {
  const status = httpErrorStatus(err);
  if (isBodyParserError(err) && status !== undefined && status < 500) {
    next(new RequestBodyError(status, err.type));
    return;
  }
  next(err);
}

/** http-errors 形狀（`status`／`statusCode` 為 400–599 的整數）的狀態碼；不是則回 `undefined`。 */
function httpErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const value = typeof statusCode === "number" ? statusCode : status;
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

type RequestLike = { method?: unknown; path?: unknown };

/**
 * 全域 ExceptionFilter（API-7／API-17，裁決 6）。
 *
 * - `HttpException`：直接交給 `BaseExceptionFilter`，回應形狀與文字、不記 log 的行為都與 Nest 原本
 *   相同（JobsController 的 400／404／409／415、503 等；需要記錄的由呼叫端自行記，例如 409／503 由
 *   JobsService 記 warn），這裡再記一則不會多帶資訊。
 * - 其他帶 4xx 狀態碼的 http-errors（body-parser 的 400／413／415 等）：記 warn 並節流，回
 *   `{ statusCode, message }`、固定英文訊息。原本的行為：壞 JSON 由 Nest 11 的 router 先換成
 *   `BadRequestException`（回應回顯解析訊息裡的本文片段），`BaseExceptionFilter` 不記錄 HttpException，
 *   所以完全沒有日誌；413、415 等非 HttpException 則走 `handleUnknownError`，每則 `logger.error` 且
 *   不節流，任何人送超大 body 就能洗版。節流 key 為狀態碼加 body-parser 的 `type`（有限集合），
 *   壞 JSON 與其他 400 不互相壓掉。
 * - 其餘（含 >=500 的 http-errors 與真正未預期的例外）：記 error（帶 err，剝掉 `body`），回
 *   `{ statusCode, message }`，訊息固定英文。
 *
 * 日誌一律不帶請求本文與錯誤原訊息（4xx 只記狀態碼、方法、路徑與 body-parser 的 `type`）。
 */
@Catch()
export class HttpExceptionFilter extends BaseExceptionFilter {
  private readonly logger: ChildLogger;
  private readonly now: () => number;
  /** 4xx warn 的節流（key 見 `warnClientError`，集合有界）：此路徑可由任何人反覆觸發。 */
  private readonly clientErrorThrottle = new LogThrottle(ERROR_LOG_THROTTLE_MS);

  constructor(
    private readonly adapter: HttpServer,
    opts: { logger?: ChildLogger; now?: () => number } = {},
  ) {
    super(adapter);
    this.logger = opts.logger ?? getAppLogger().child({ context: HttpExceptionFilter.name });
    this.now = opts.now ?? Date.now;
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<RequestLike>();
    if (exception instanceof HttpException) {
      super.catch(exception, host);
      return;
    }

    const status = httpErrorStatus(exception);
    if (status !== undefined && status < 500) {
      // body-parser 的 `type` 只採用 RequestBodyError 的（body-parser 自己的有限集合）；其他來源的
      // http-errors 若帶 `type` 可能是任意字串，不拿來當節流 key 或日誌欄位。
      const errorType = exception instanceof RequestBodyError ? exception.type : undefined;
      this.warnClientError(status, req, errorType);
      this.reply(host, status, fixedMessage(status, errorType));
      return;
    }

    const statusCode = status ?? 500;
    if (!(exception instanceof IntrinsicException)) {
      this.logger.error(
        {
          err: exception instanceof Error ? withoutRequestBody(exception) : exception,
          statusCode,
          ...requestFields(req),
        },
        "unhandled request error",
      );
    }
    this.reply(host, statusCode, statusCode === 500 ? INTERNAL_ERROR_MESSAGE : fixedMessage(statusCode));
  }

  private warnClientError(statusCode: number, req: RequestLike, errorType?: string): void {
    const fields = throttledFields(
      this.clientErrorThrottle,
      errorType !== undefined ? `${statusCode}:${errorType}` : String(statusCode),
      { statusCode, ...requestFields(req), ...(errorType !== undefined ? { errorType } : {}) },
      this.now(),
    );
    if (fields) this.logger.warn(fields, "http request rejected");
  }

  private reply(host: ArgumentsHost, statusCode: number, message: string): void {
    const res: unknown = host.getArgByIndex(1);
    if (this.adapter.isHeadersSent(res)) {
      this.adapter.end(res);
      return;
    }
    this.adapter.reply(res, { statusCode, message }, statusCode);
  }
}

function requestFields(req: RequestLike): { method?: string; path?: string } {
  return {
    ...(typeof req.method === "string" ? { method: req.method } : {}),
    ...(typeof req.path === "string" ? { path: req.path } : {}),
  };
}

/**
 * HTTP 層的設定。`app` MUST 以 `HTTP_APP_OPTIONS` 建立（關掉 Nest 自動掛的 body parser）：Nest 在
 * `init()` 時才掛 parser，順序會落在這裡的 error middleware 之後，body-parser 的錯誤就攔不到。
 * 反過來，只套 `HTTP_APP_OPTIONS` 而不呼叫本函式就**完全沒有 body parser**。兩者因此不單獨匯出，
 * 一律經 `createHttpApp` 成對使用。
 */
function configureHttpApp(
  app: NestExpressApplication,
  filterOpts: { logger?: ChildLogger; now?: () => number } = {},
): void {
  // 不在回應標頭宣告框架（Express 預設帶 `X-Powered-By: Express`）。
  app.disable("x-powered-by");
  // 沿用 Nest 預設的兩種 parser（json、urlencoded extended），只改上限。urlencoded 照舊解析：
  // JobsController 先以 Content-Type 回 415，維持既有行為。
  app.useBodyParser("json", { limit: REQUEST_BODY_LIMIT });
  app.useBodyParser("urlencoded", { limit: REQUEST_BODY_LIMIT, extended: true });
  app.use(normalizeBodyParserError);
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost).httpAdapter, filterOpts));
}

type HttpAppModule = Parameters<typeof NestFactory.create>[0];
type HttpAppOptions = Omit<NestApplicationOptions, "bodyParser">;

/**
 * 建立 HTTP app（main.ts 與 HTTP 測試共用，避免兩邊漂移）：以 `HTTP_APP_OPTIONS` 建立，並立即套用
 * `configureHttpApp`（16 kb body parser、body-parser 錯誤正規化、全域 ExceptionFilter、
 * `disable("x-powered-by")`）。`bodyParser` 不開放覆寫。
 */
export async function createHttpApp(
  module: HttpAppModule,
  options: HttpAppOptions = {},
  filterOpts: { logger?: ChildLogger; now?: () => number } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module, { ...options, ...HTTP_APP_OPTIONS });
  configureHttpApp(app, filterOpts);
  return app;
}
