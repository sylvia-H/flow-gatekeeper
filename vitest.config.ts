import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// root 聚合設定：只給 `pnpm test:coverage`（`vitest run --coverage`）用，把五個套件當 projects 一次跑、
// 產出一份合併的覆蓋率報告。日常 `pnpm test`（`pnpm -r test`）仍逐套件各跑各的，不經過這個檔。
//
// 每個 project 直接指向該套件既有的設定檔，行為（dist 排除、NODE_ENV 壓制、web 的 Vue plugin
// 與各測試檔自帶的 environment 註記）完全沿用套件本身設定；project root 即設定檔所在目錄，因此相對路徑與 workspace 套件的
// "development" condition（→ packages/*/src）解析與單跑時一致。
// tests/e2e 刻意不納入：它需要實際起 infra，由 `pnpm test:e2e` 另跑。
// 注意：vitest 會從 cwd 逐層往上找設定檔；子目錄若沒有自己的 vitest／vite 設定就會撿到本檔。projects 路徑因此
// 一律以「本檔所在目錄」為基準轉成絕對路徑（相對路徑會依 cwd 解析而報 non-existing file）；但撿到本檔就等於
// 跑全部單元測試，所以每個會跑 vitest 的子套件（含 tests/e2e）仍 MUST 有自己的設定檔。
const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// 與各套件設定同一道防線：NODE_ENV=production 會讓 Vite 改選 production condition、吃 packages 的 dist，
// 在 root 先壓回 test，避免 coverage 量到過期產物（或乾淨 clone 下根本沒有 dist 而失敗）。
if (process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

export default defineConfig({
  // 根目錄固定為本檔所在處：coverage include／reportsDirectory 等相對路徑都不隨 cwd 漂移。
  root: fromRoot("."),
  test: {
    projects: [
      fromRoot("./packages/shared/vitest.config.ts"),
      fromRoot("./packages/contracts/vitest.config.ts"),
      fromRoot("./apps/worker/vitest.config.ts"),
      fromRoot("./apps/api/vitest.config.ts"),
      fromRoot("./apps/web/vite.config.ts"),
    ],
    coverage: {
      provider: "v8",
      // 只量 production 原始碼：五個套件的 src。
      include: [
        "packages/shared/src/**/*.ts",
        "packages/contracts/src/**/*.ts",
        "apps/worker/src/**/*.ts",
        "apps/api/src/**/*.ts",
        "apps/web/src/**/*.{ts,vue}",
      ],
      exclude: [
        "**/*.test.ts",
        "**/test-support/**",
        "**/dist/**",
        "**/*.d.ts",
        // 手動執行的開發 CLI，不是執行期程式碼：seed 維修紀錄（需真 MongoDB）、Gemini 連通性 smoke（需真 API key）。
        "apps/api/src/scripts/**",
        "apps/worker/src/ai/smoke-*.ts",
      ],
      // json-summary：產出 coverage-summary.json，供門檻 ratchet 時讀取全域與逐檔實測值（TQ-20）。
      reporter: ["text-summary", "lcov", "json-summary"],
      // COVERAGE_DIR：覆寫輸出目錄（TQ-15）。輸出目錄是共用可變狀態，兩個 coverage（或 coverage 與 Stryker）
      // 並行時會互相污染（.vue 被靜默排除、數字下滑卻仍過門檻）；需要並行時各自指定不同目錄。
      // vitest 每次執行前會整個清空本目錄：COVERAGE_DIR 必須是專屬目錄（不可設成 `reports` 這類共用目錄）。
      // `||` 而非 `??`：設成空字串時退回預設，避免解析成 repo 根目錄而被清空。
      reportsDirectory: process.env.COVERAGE_DIR || fromRoot("./coverage"),
      // 測試失敗時仍產出報告：CI 失敗 run 也能上傳 lcov 供比對（vitest 預設失敗即不出報告）。
      reportOnFailure: true,
      // 「不退步門檻」：守住「不往下掉」而非追求數字。
      // 由來：第二輪審查 §6 Batch D 首設 lines 60／branches 50（落地實測約 67／65，其後升到 81.37／76.44 仍維持）；
      // 第三輪審查 TQ-20 指出門檻低於實測 21～27 pt，刪掉約四分之一有效測試 CI 仍綠、也擋不住 TQ-15 的污染數字。
      // 現況（2026-10-18，review03 Batch E 合併門第 2 輪修正後於 HEAD 隔離實測 lines 92.33／branches 88.40，137 檔 1988 支）：
      // 全域與核心檔逐檔下限一律
      // 「實測 −3、取整數往下」（使用者裁決）。測試增加後可再 ratchet；數字只升不降，下修須有理由。
      // 下修紀錄：合併門第 1／2 輪改寫 job-status-relay（共用 bullmqConnection）與 shared logging（toJSON／child
      // bindings／陣列 command）後分支組成改變，依同一規則重量：job-status-relay branches 80 → 78、
      // shared logging branches 92 → 89（Batch E 首次量測為 98.91／83.33 與 97.91／95.65）。
      // 核心檔以 glob（相對 repo 根）設逐檔下限，避免弱檔被全域平均蓋住；檔案改名或搬移時 MUST 同步改 key——
      // glob 對不到任何檔案時 vitest 不會報錯，該檔的下限就靜默失效。
      // main.ts 入口刻意納入，以免覆蓋率虛高：main.test.ts 只測入口的守衛與 side-effect，
      // bootstrap 本體由 e2e（`pnpm test:e2e`）覆蓋，不計入本報告。
      thresholds: {
        lines: 89,
        branches: 85,
        // 實測 lines／branches：98.64／87.83
        "apps/worker/src/processor.ts": { lines: 95, branches: 84 },
        // 99.49／92.38
        "apps/api/src/modules/websocket/monitoring.gateway.ts": { lines: 96, branches: 89 },
        // 98.79／81.57
        "apps/api/src/modules/websocket/job-status-relay.service.ts": { lines: 95, branches: 78 },
        // 96.55／78.26
        "apps/api/src/modules/websocket/ai-stream-relay.service.ts": { lines: 93, branches: 75 },
        // 96.22／75.00
        "apps/api/src/modules/jobs/jobs.service.ts": { lines: 93, branches: 72 },
        // 100／100
        "apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts": { lines: 97, branches: 97 },
        // 100／91.81
        "apps/web/src/domains/ai-copilot/stores/copilot.store.ts": { lines: 97, branches: 88 },
        // 97.02／73.49
        "apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts": { lines: 94, branches: 70 },
        // 97.14／92.45
        "packages/shared/src/logging/index.ts": { lines: 94, branches: 89 },
        // 100／97.22
        "apps/api/src/logging/pino-logger.service.ts": { lines: 97, branches: 94 },
        // 012 新增的核心檔（2026-10-22 合併門第 1 輪量測，同規則「實測 −3、取整」）。
        // 100／94.82
        "apps/api/src/modules/websocket/job-routing-registry.ts": { lines: 97, branches: 91 },
        // 98.88／94.59
        "apps/api/src/modules/jobs/diagnosis-lookup.service.ts": { lines: 95, branches: 91 },
        // 100／100
        "apps/api/src/modules/websocket/job-status-payload.ts": { lines: 97, branches: 97 },
      },
    },
  },
});
