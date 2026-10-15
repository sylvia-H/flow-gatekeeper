import { describe, expect, it } from "vitest";
import type { TelemetryPoint } from "@flow-gatekeeper/contracts";
import { metricUnit, offendingMetrics, relativeTimeLabel } from "./telemetry-format.js";

type Telemetry = TelemetryPoint["telemetry"];

function telemetry(over: Partial<Telemetry> = {}): Telemetry {
  return { temperature: 20, vibration: 0.2, throughput: 100, errorRate: 0.0, ...over };
}

describe("metricUnit（FR-003）", () => {
  it("每個 metric 有對應單位", () => {
    expect(metricUnit("temperature")).toBe("°C");
    expect(metricUnit("vibration")).toBe("mm/s");
    expect(metricUnit("throughput")).toBe("u/min");
    expect(metricUnit("errorRate")).toBe("%");
  });
});

describe("offendingMetrics（FR-002；門檻鏡射 002 producer）", () => {
  it("未越界時全為 null", () => {
    const r = offendingMetrics(telemetry());
    expect(r).toEqual({ temperature: null, vibration: null, throughput: null, errorRate: null });
  });

  it("temperature 78 邊界不越界、>78 為 warn、>95 為 crit", () => {
    expect(offendingMetrics(telemetry({ temperature: 78 })).temperature).toBeNull();
    expect(offendingMetrics(telemetry({ temperature: 80 })).temperature).toBe("warn");
    expect(offendingMetrics(telemetry({ temperature: 96 })).temperature).toBe("crit");
  });

  it("vibration 與 errorRate 分級", () => {
    expect(offendingMetrics(telemetry({ vibration: 1.0 })).vibration).toBe("warn");
    expect(offendingMetrics(telemetry({ vibration: 2.0 })).vibration).toBe("crit");
    expect(offendingMetrics(telemetry({ errorRate: 0.05 })).errorRate).toBe("warn");
    expect(offendingMetrics(telemetry({ errorRate: 0.2 })).errorRate).toBe("crit");
  });

  it("throughput 不參與 amber（恆 null）", () => {
    expect(offendingMetrics(telemetry({ throughput: 0 })).throughput).toBeNull();
    expect(offendingMetrics(telemetry({ throughput: 9999 })).throughput).toBeNull();
  });
});

describe("relativeTimeLabel（委派 formatRelative，FR-022 邊界）", () => {
  const now = 1_000_000_000;
  it("≤ 2s（閉區間）→ 剛剛", () => {
    expect(relativeTimeLabel(now, now)).toBe("剛剛");
    expect(relativeTimeLabel(now - 2_000, now)).toBe("剛剛");
  });
  it("秒／分邊界", () => {
    expect(relativeTimeLabel(now - 2_001, now)).toBe("2 秒前");
    expect(relativeTimeLabel(now - 59_000, now)).toBe("59 秒前");
    expect(relativeTimeLabel(now - 60_000, now)).toBe("1 分鐘前");
    expect(relativeTimeLabel(now - 60 * 60_000, now)).toBe("60 分鐘前");
  });
  it("未來時間夾為剛剛（不出現負值）", () => {
    expect(relativeTimeLabel(now + 5_000, now)).toBe("剛剛");
  });
});
