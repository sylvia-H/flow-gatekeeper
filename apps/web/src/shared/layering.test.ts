/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 依賴方向：`shared/` 是 domain-agnostic 的共用層，`domains/*` 可以依賴它，反之不行。
 *
 * 守門範圍：`shared/composables`、`shared/lib`（非 UI 的共用邏輯）與 `shared/components`（共用元件）。
 * - `useDiagnoseTrigger` 因為同時依賴 monitoring 與 ai-copilot 兩個 store，已移到 `domains/ai-copilot/composables/`。
 * - 背壓速率序列 `rate-series.ts`（純計算與型別）由 `domains/monitoring/lib/` 搬到 `shared/lib/`（合併門第 2 輪）：
 *   `BackpressureStrip`／`Sparkline` 是 shared 元件，原本反向匯入它。
 * - `shared/components` 只允許 `LEGACY_COMPONENT_IMPORTS` 列出的反向匯入：TopBar 與 MetricsPanel 直接讀
 *   monitoring／metrics store，是 **1.1.0 遺留**（tag `1.1.0` 已存在），另案處理；清單之外新增的反向匯入一律擋下，
 *   清單內的匯入被移除時也要同步縮小清單（下方「清單與實際一致」測試）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const GUARDED = ["composables", "lib", "components"];

/** 1.1.0 遺留的反向匯入（相對 `shared/` 的檔案路徑 → 允許的模組指定）。 */
const LEGACY_COMPONENT_IMPORTS: Record<string, readonly string[]> = {
  "components/MetricsPanel.vue": [
    "../../domains/monitoring/stores/metrics.store.js",
    "../../domains/monitoring/lib/metrics-view.js",
  ],
  "components/TopBar.vue": [
    "../../domains/monitoring/stores/monitoring.store.js",
    "../../domains/ai-copilot/composables/useDiagnoseTrigger.js",
  ],
};

/**
 * 命中任何指向 `domains/` 的模組指定：`import … from`／`export … from`、side-effect
 * `import "…"` 與動態 `import("…")`。只看緊接在 `from`／`import` 之後的模組字串，
 * 註解或一般字串裡出現 "domains/" 不算。
 */
const DOMAIN_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]([^"'`]*\bdomains\/[^"'`]*)["'`]/g;

/** 檔案內所有指向 `domains/` 的模組指定（依出現順序）。 */
function domainImports(source: string): string[] {
  return [...source.matchAll(DOMAIN_IMPORT)].map((m) => m[1]!);
}

function importsDomains(source: string): boolean {
  return domainImports(source).length > 0;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** 相對 `shared/` 的正斜線路徑（Windows 也一致）。 */
const rel = (file: string): string => relative(here, file).split(sep).join("/");

describe("importsDomains — matcher 本身", () => {
  it.each([
    'import { x } from "../../domains/monitoring/stores/monitoring.store.js";',
    "import type { T } from '../domains/a.js';",
    'export { y } from "../../domains/ai-copilot/lib/z.js";',
    'import "../../domains/monitoring/side-effect.js";',
    "const m = await import('../../domains/monitoring/lazy.js');",
    'const m = import(\n  "../../domains/x.js"\n);',
  ])("命中：%s", (sample) => {
    expect(importsDomains(sample)).toBe(true);
  });

  it.each([
    'import { x } from "../lib/state-style.js";',
    'import "./styles.css";',
    "const m = await import('./lazy.js');",
    "// 註解提到 domains/monitoring 不算",
    'const label = "see domains/ folder";',
  ])("不命中：%s", (sample) => {
    expect(importsDomains(sample)).toBe(false);
  });

  it("domainImports 取出每一個模組指定", () => {
    expect(
      domainImports('import a from "../../domains/x.js";\nimport { b } from "../lib/y.js";\nexport * from "../domains/z.js";'),
    ).toEqual(["../../domains/x.js", "../domains/z.js"]);
  });
});

describe("shared/ 不反向依賴 domains/", () => {
  it.each(GUARDED)("shared/%s 沒有清單之外的 import 指向 domains/", (sub) => {
    const offenders = sourceFiles(join(here, sub)).flatMap((file) => {
      const allowed = LEGACY_COMPONENT_IMPORTS[rel(file)] ?? [];
      return domainImports(readFileSync(file, "utf8"))
        .filter((spec) => !allowed.includes(spec))
        .map((spec) => `${rel(file)} → ${spec}`);
    });
    expect(offenders).toEqual([]);
  });

  it("1.1.0 遺留清單與實際一致：matcher 對真實檔案有效，且清單內的匯入被移除時須同步縮小清單", () => {
    // 防止 matcher 退化成永遠不命中而讓上面的守門測試假綠，也防止清單留著已不存在的匯入
    const actual = Object.fromEntries(
      sourceFiles(join(here, "components"))
        .map((file) => [rel(file), domainImports(readFileSync(file, "utf8"))] as const)
        .filter(([, specs]) => specs.length > 0),
    );
    expect(actual).toEqual(LEGACY_COMPONENT_IMPORTS);
  });
});
