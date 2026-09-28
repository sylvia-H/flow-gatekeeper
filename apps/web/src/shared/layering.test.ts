/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 依賴方向：`shared/` 是 domain-agnostic 的共用層，`domains/*` 可以依賴它，反之不行。
 *
 * 目前只守 `shared/composables` 與 `shared/lib`（非 UI 的共用邏輯）：`useDiagnoseTrigger`
 * 因為同時依賴 monitoring 與 ai-copilot 兩個 store，已移到 `domains/ai-copilot/composables/`。
 * `shared/components/*.vue` 仍有既存的反向匯入（TopBar／MetricsPanel／AppLayout），另案處理。
 */
const here = dirname(fileURLToPath(import.meta.url));
const GUARDED = ["composables", "lib"];

/**
 * 命中任何指向 `domains/` 的模組指定：`import … from`／`export … from`、side-effect
 * `import "…"` 與動態 `import("…")`。只看緊接在 `from`／`import` 之後的模組字串，
 * 註解或一般字串裡出現 "domains/" 不算。
 */
const DOMAIN_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`][^"'`]*\bdomains\//;

function importsDomains(source: string): boolean {
  return DOMAIN_IMPORT.test(source);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

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
});

describe("shared/ 不反向依賴 domains/", () => {
  it.each(GUARDED)("shared/%s 沒有任何 import 指向 domains/", (sub) => {
    const offenders = sourceFiles(join(here, sub)).filter((file) =>
      importsDomains(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => relative(here, f))).toEqual([]);
  });

  it("matcher 對真實檔案有效：shared/components 的既存反向匯入會被抓到", () => {
    // 防止 matcher 退化成永遠不命中而讓上面的守門測試假綠
    const hits = sourceFiles(join(here, "components")).filter((file) =>
      importsDomains(readFileSync(file, "utf8")),
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});
