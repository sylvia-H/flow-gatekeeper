/**
 * @flow-gatekeeper/shared — 跨端共用工具。
 *
 * Feature 001 僅提供可編譯的最小骨架；實際工具（時間/格式化/常數等）
 * 隨後續 feature 需求逐步加入。
 */

/** workspace 佔位常數，證明 package 可被建置與 import。 */
export const SHARED_PACKAGE = "@flow-gatekeeper/shared" as const;

export * from "./telemetry-thresholds.js";
export { isProductionEnv } from "./env.js";

// ⚠️ MUST NOT `export * from "./logging/*"` 或直接／間接 re-export ./logging 任何內容。
// apps/web 相依本 package（telemetry-format.ts 匯入 METRIC_THRESHOLDS）；根 export 一旦
// 帶出 logging 模組，pino 就會被拉進瀏覽器 bundle（research R10）。logging 只能經**子路徑**
// `@flow-gatekeeper/shared/logging` 匯入（packages/shared/package.json 的 exports 欄位）。
