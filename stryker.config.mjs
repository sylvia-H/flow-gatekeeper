// @ts-check
/**
 * Stryker 變異測試設定（第二輪審查 docs/20260927-research-review02.md §6 Batch D「變異測試常態化」）。
 *
 * - 範圍：只變異五個接線層核心檔（報告 §2.4／§3.6、附錄 A 手工變異的來源），不做全 repo 變異——
 *   全量變異耗時與雜訊都不成比例，目的是守住「斷言面」而非衝覆蓋率。
 * - 執行：repo 根 `pnpm test:mutation`（= `stryker run`）；nightly 見 .github/workflows/nightly-mutation.yml。
 * - monorepo：單一 root config，vitest-runner 透過 root vitest.config.ts 的 test.projects 載入
 *   各套件既有測試設定（related 模式只會挑到 worker／api／web 的相關測試）；Stryker 會把各層 node_modules 以 junction／symlink 接進 sandbox。
 * - 縮小範圍（本機除錯用）：`pnpm test:mutation --mutate apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts`
 *
 * - 報告目錄覆寫（TQ-15）：Stryker 本身只吃設定檔與 CLI 旗標、不讀環境變數，本檔是 JS 模組，故在此讀
 *   `MUTATION_REPORT_DIR`（預設 reports/mutation）。並行的兩個 Stryker 會互相覆寫報告檔；sandbox 則各自獨立
 *   （每次在 `tempDirName` 下以 mkdtemp 建 `sandbox-XXXXXX`，收尾只刪自己那份），故 `tempDirName` 不開放覆寫——
 *   Stryker 另以 basename 比對 `tempDirName` 排除掃描，設成多層路徑時比對會失效。勿並行跑；需要並行時以
 *   `MUTATION_REPORT_DIR` 分開報告（與 coverage 並行時，coverage 端另用 COVERAGE_DIR）。
 */
// 明確 import：root 的 eslint 設定對 .mjs 不提供 Node globals（no-undef）。
import process from "node:process";

/** 報告輸出目錄（TQ-15，見檔頭）。 */
const reportDir = process.env.MUTATION_REPORT_DIR ?? "reports/mutation";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: {
    // 沿用 root vitest.config.ts（test.projects 聚合五個套件；其 coverage 設定在 Stryker 下會被關閉、不影響）。
    configFile: "vitest.config.ts",
    // related 模式：每個變異只跑 import 圖上相關的測試檔，搭配 perTest 覆蓋分析進一步縮小。
    related: true,
  },
  mutate: [
    "apps/worker/src/processor.ts",
    "apps/api/src/modules/websocket/monitoring.gateway.ts",
    "apps/api/src/modules/websocket/job-status-relay.service.ts",
    "apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts",
    "apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts",
  ],
  // sandbox 只需要原始碼與設定；產物、報告、文件與 e2e 套件一律不複製（node_modules 由 Stryker 另行 symlink）。
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "tests/e2e/**",
    "reports/**",
    "docs/**",
    "specs/**",
    "apps/web/design/**",
    ".codegraph/**",
    "**/*.log",
  ],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: `${reportDir}/mutation.html` },
  jsonReporter: { fileName: `${reportDir}/mutation.json` },
  // 門檻：high／low 只影響報告配色；break 為 nightly 失敗線（報告要求 70%）。
  // 注意：break 只看「總分」，弱檔會被強檔平均蓋住。
  // 2026-09-27 首跑基準（量測時 TQ-4～TQ-6 測試尚未完全到位）：copilot-reducer 88.1／job-status-relay 81.6／
  // useHighFrequencyWs 73.3／monitoring.gateway 66.5／processor 62.7，總分 72.0（餘裕僅約 2 分）。
  // monitoring.gateway 與 processor 單檔低於 70，列為追蹤項目（待斷言面補齊後複查單檔分數）。
  thresholds: { high: 80, low: 70, break: 70 },
  timeoutMS: 10000,
};
