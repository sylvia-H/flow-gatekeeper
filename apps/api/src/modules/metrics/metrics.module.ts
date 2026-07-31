import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.js";
import { MetricsService } from "./metrics.service.js";

/**
 * US3：週期指標結算與廣播，與既有 config／history／health／jobs 同層同構。
 *
 * 只 import `ConfigModule`——指標來源（queue counts、ws 連線數）與出口（廣播）由組合根
 * `main.ts` 以 `MetricsService.bind()` 注入，理由見 `metrics.service.ts` 的 `MetricsSources`。
 * `exports` 使 `AppModule` 層（含 main.ts 的 `app.get()`）能取得同一個實體。
 * timer 於 `onModuleDestroy` 清除，優雅關閉不留殘窗摘要。
 */
@Module({
  imports: [ConfigModule],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
