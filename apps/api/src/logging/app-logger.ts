import { createLogger } from "@flow-gatekeeper/shared/logging";
import type { FlowLogger } from "@flow-gatekeeper/shared/logging";

let cached: FlowLogger | undefined;

/**
 * 行程內單例、**惰性**建立（第一次實際呼叫才 `createLogger`，而非模組匯入當下）——確保
 * entry smoke 測試（僅 import、不呼叫 bootstrap）不會意外建立 pino 實例或觸發 pretty
 * transport 的 worker thread。Nest `@Injectable()` provider 的欄位初始化式只在**實際被
 * DI 容器建構**（`NestFactory.create()` 真正執行時）才跑，並非在 class 檔案被 import 時，
 * 故服務類別可放心在欄位初始化式呼叫本函式。
 *
 * 與 main.ts 的 `PinoLoggerService` 共用同一個底層 `FlowLogger` 實例（同一個 pino sink），
 * 使「透過 Nest Logger 整批轉接」與「本檔案案例中需要結構化關聯鍵的個別呼叫點」輸出一致
 * 的 `service`/`context` 欄位，不產生第二套並存格式（FR-004）。
 */
export function getAppLogger(): FlowLogger {
  cached ??= createLogger("api");
  return cached;
}
