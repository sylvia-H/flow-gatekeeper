import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "./config.service.js";

/** 全域設定模組——其他模組可直接注入 AppConfigService，無需重複 import。 */
@Global()
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigModule {}
