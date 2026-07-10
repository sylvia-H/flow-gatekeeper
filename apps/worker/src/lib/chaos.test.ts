import { describe, expect, it } from "vitest";
import { parseChaosConfig } from "./chaos.js";

/** parseChaosConfig 解析決定性（憲章測試門檻；research D6、data-model E3）。 */
describe("parseChaosConfig", () => {
  it("未設定＝關閉、零影響、無警告", () => {
    expect(parseChaosConfig({})).toEqual({ config: null, warnings: [] });
  });

  it("空字串（WORKER_CHAOS=）視同未設定，不警告", () => {
    expect(parseChaosConfig({ WORKER_CHAOS: "" })).toEqual({ config: null, warnings: [] });
    expect(parseChaosConfig({ WORKER_CHAOS: "  " })).toEqual({ config: null, warnings: [] });
  });

  it("合法組合：兩型態 × 兩時點", () => {
    for (const kind of ["uncaught", "rejection"] as const) {
      for (const at of ["startup", "job"] as const) {
        expect(parseChaosConfig({ WORKER_CHAOS: kind, WORKER_CHAOS_AT: at })).toEqual({
          config: { kind, at },
          warnings: [],
        });
      }
    }
  });

  it("WORKER_CHAOS_AT 未設定時預設 startup", () => {
    expect(parseChaosConfig({ WORKER_CHAOS: "uncaught" })).toEqual({
      config: { kind: "uncaught", at: "startup" },
      warnings: [],
    });
  });

  it("WORKER_CHAOS 非法值 → warn 並視為關閉（零影響原則）", () => {
    const r = parseChaosConfig({ WORKER_CHAOS: "kaboom" });
    expect(r.config).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("kaboom");
  });

  it("WORKER_CHAOS_AT 非法值 → warn 並視為關閉（不猜測時點）", () => {
    const r = parseChaosConfig({ WORKER_CHAOS: "uncaught", WORKER_CHAOS_AT: "later" });
    expect(r.config).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("later");
  });

  it("僅設 WORKER_CHAOS_AT（無型態）＝關閉，不警告", () => {
    expect(parseChaosConfig({ WORKER_CHAOS_AT: "job" })).toEqual({ config: null, warnings: [] });
  });
});
