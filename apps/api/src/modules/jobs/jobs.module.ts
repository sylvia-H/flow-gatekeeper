import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";

/**
 * BullMQ 佈線模組（003）：註冊 producer 連線與 `DIAGNOSIS_QUEUE`，並 re-export `BullModule`
 * 使 `JobsService`（於 AppModule 提供）能 `@InjectQueue` 取得同一佇列。
 *
 * 連線：producer 用 `maxRetriesPerRequest: null`（BullMQ blocking 需求）。T020 的 QueueEvents
 * 另建**獨立 blocking 連線**、與此 producer 分離（憲章 IV／F4）。
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: {
          host: config.redisHost,
          port: config.redisPort,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: DIAGNOSIS_QUEUE }),
  ],
  exports: [BullModule],
})
export class JobsModule {}
