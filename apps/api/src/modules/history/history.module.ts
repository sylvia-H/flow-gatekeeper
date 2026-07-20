import { Module } from "@nestjs/common";
import { HistoryService } from "./history.service.js";

/**
 * 讓 `HistoryService`（Mongo 連線持有者）可跨模組共用同一個實例——
 * 009 US2 的 `HealthModule` 需複用其 `Db` 執行 `ping()`（contracts/health-endpoint.md §4：
 * 「不另開連線」）。Nest 的 imported module 為單例快取，AppModule 與 HealthModule 皆 import
 * 本模組時取得同一個 HistoryService 實體，而非各自建立。
 */
@Module({
  providers: [HistoryService],
  exports: [HistoryService],
})
export class HistoryModule {}
