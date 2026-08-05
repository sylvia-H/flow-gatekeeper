import { describe, expect, it } from "vitest";
import type { DependencyProbe } from "./health-aggregate.js";
import { aggregateHealth } from "./health-aggregate.js";

const up: DependencyProbe = { status: "up", latencyMs: 5, error: null };
const down = (error: string): DependencyProbe => ({ status: "down", latencyMs: null, error });

describe("aggregateHealth", () => {
  it("全部 up → healthy", () => {
    expect(aggregateHealth({ redis: up, mongo: up })).toBe("healthy");
  });

  it("單一 down → unhealthy", () => {
    expect(aggregateHealth({ redis: down("timeout"), mongo: up })).toBe("unhealthy");
  });

  it("多重 down → 仍為 unhealthy（呼叫端的 body 各自逐項列出，本函式只回整體狀態）", () => {
    expect(aggregateHealth({ redis: down("timeout"), mongo: down("ECONNREFUSED") })).toBe(
      "unhealthy",
    );
  });

  it("不變量：unhealthy 時輸入至少有一個 down（用以反向驗證聚合邏輯未誤判）", () => {
    const dependencies = { redis: down("timeout"), mongo: up };
    const status = aggregateHealth(dependencies);
    const hasDown = Object.values(dependencies).some((p) => p.status === "down");
    expect(status === "unhealthy").toBe(hasDown);
  });
});
