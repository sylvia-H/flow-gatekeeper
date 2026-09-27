import { describe, expect, it } from "vitest";
import { parseChaosAllowInProduction, parseChaosConfig, shouldArmChaos } from "./chaos.js";

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

describe("parseChaosAllowInProduction／shouldArmChaos（production 守衛獨立開關）", () => {
  it("未設定、空值、false → 不放行、無警告", () => {
    for (const v of [undefined, "", "  ", "false", "FALSE"]) {
      expect(parseChaosAllowInProduction({ WORKER_CHAOS_ALLOW_IN_PRODUCTION: v })).toEqual({ allow: false, warnings: [] });
    }
  });

  it("true（大小寫不拘）→ 放行", () => {
    expect(parseChaosAllowInProduction({ WORKER_CHAOS_ALLOW_IN_PRODUCTION: "true" }).allow).toBe(true);
    expect(parseChaosAllowInProduction({ WORKER_CHAOS_ALLOW_IN_PRODUCTION: " TRUE " }).allow).toBe(true);
  });

  it("非法值 → warn 並視為 false（不放行）", () => {
    const r = parseChaosAllowInProduction({ WORKER_CHAOS_ALLOW_IN_PRODUCTION: "yes" });
    expect(r.allow).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("yes");
  });

  it("非 production 一律武裝；production 只在開關放行時武裝", () => {
    expect(shouldArmChaos(undefined, false)).toBe(true);
    expect(shouldArmChaos("development", false)).toBe(true);
    expect(shouldArmChaos("production", false)).toBe(false);
    expect(shouldArmChaos("production", true)).toBe(true);
  });

  it.each<[string | undefined, boolean, boolean]>([
    [undefined, false, true],
    ["", false, true],
    ["test", false, true],
    ["production", false, false],
    ["Production", false, false],
    ["PRODUCTION", false, false],
    [" production ", false, false],
    ["production\n", false, false],
    ["Production", true, true],
    ["productions", false, true],
  ])("真值表：NODE_ENV=%j、allow=%s → %s（production 判斷不分大小寫、忽略前後空白）", (nodeEnv, allow, expected) => {
    expect(shouldArmChaos(nodeEnv, allow)).toBe(expected);
  });
});
