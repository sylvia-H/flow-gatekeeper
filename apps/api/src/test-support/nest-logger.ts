import { Logger, type LoggerService } from "@nestjs/common";

/**
 * 測試用：接管或靜音 Nest 全域 Logger，回傳還原函式。
 *
 * `Logger.overrideLogger(false)` 會把私有的 `staticInstanceRef` 設為 undefined，只設 logLevels 還原不了，
 * 所以這裡以 `Reflect` 存取該私有欄位並在還原時寫回原值。Nest 升版若改名，只需改這一處。
 * 本目錄（`test-support/`）不進 dist（tsconfig.build.json 排除）、不計入覆蓋率（root vitest.config.ts 排除）。
 */
export function overrideNestLogger(logger: LoggerService | false): () => void {
  const original: unknown = Reflect.get(Logger, "staticInstanceRef");
  Logger.overrideLogger(logger);
  return () => {
    Reflect.set(Logger, "staticInstanceRef", original);
  };
}

/** 靜音 Nest 全域 Logger（整合測試只讀回 Mongo 實際狀態，log 只是雜訊）；回傳還原函式。 */
export function silenceNestLogger(): () => void {
  return overrideNestLogger(false);
}
