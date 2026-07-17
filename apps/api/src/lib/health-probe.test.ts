import { describe, expect, it } from "vitest";
import { isConnectedMessage } from "./health-probe.js";

describe("isConnectedMessage（健康探針判準，FR-011）", () => {
  it("system/connected envelope → 命中", () => {
    expect(isConnectedMessage(JSON.stringify({ type: "system/connected", clientId: "abc" }))).toBe(
      true,
    );
  });

  it("其他 envelope 型別 → 不命中", () => {
    expect(isConnectedMessage(JSON.stringify({ type: "pong", ts: 1 }))).toBe(false);
    expect(isConnectedMessage(JSON.stringify({ type: "machine/subscribed", machineIds: [] }))).toBe(
      false,
    );
    expect(isConnectedMessage(JSON.stringify({ type: "system/unauthorized" }))).toBe(false);
  });

  it("非 JSON／畸形字串 → 不命中且不拋錯", () => {
    expect(isConnectedMessage("")).toBe(false);
    expect(isConnectedMessage("not json")).toBe(false);
    expect(isConnectedMessage("{ broken")).toBe(false);
    expect(isConnectedMessage("null")).toBe(false);
    expect(isConnectedMessage("[1,2,3]")).toBe(false);
    expect(isConnectedMessage("42")).toBe(false);
  });

  it("type 欄位缺失或非字串 → 不命中", () => {
    expect(isConnectedMessage(JSON.stringify({ clientId: "abc" }))).toBe(false);
    expect(isConnectedMessage(JSON.stringify({ type: 123 }))).toBe(false);
  });
});
