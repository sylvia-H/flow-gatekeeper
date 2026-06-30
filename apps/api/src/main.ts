import { Logger } from "@nestjs/common";

/**
 * apps/api entry — Feature 001 僅為可編譯的最小骨架（FR-013）。
 *
 * MUST NOT 在本 feature 實際啟動 HTTP server 或掛載 WebSocket Gateway；
 * 完整的原生 `ws` Gateway（path `/ws`）行為留待 Feature 002。
 * 本 module 保持 side-effect-free，以便 entry smoke 測試可乾淨 import（FR-014）。
 */
export function bootstrap(): void {
  const logger = new Logger("api");
  logger.log("flow-gatekeeper api skeleton (001) — gateway 行為留待 002");
}

// 僅在被直接執行時才呼叫；被 import 時不產生副作用。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  bootstrap();
}
