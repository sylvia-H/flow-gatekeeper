import { describe, expect, it } from "vitest";
import { ClientControlMessageSchema } from "./ws-client.js";

describe("ClientControlMessageSchema", () => {
  it("接受 ping 與合法的 machine/subscribe", () => {
    expect(ClientControlMessageSchema.safeParse({ type: "ping" }).success).toBe(true);
    const parsed = ClientControlMessageSchema.parse({
      type: "machine/subscribe",
      token: "t",
      machineIds: ["press-01", "cnc-02"],
    });
    expect(parsed.type).toBe("machine/subscribe");
  });

  it.each([
    ["null", null],
    ["數字", 1],
    ["未知 type", { type: "machine/unsubscribe" }],
    ["machineIds 為數字", { type: "machine/subscribe", token: "t", machineIds: 1 }],
    ["machineIds 為字串", { type: "machine/subscribe", token: "t", machineIds: "press-01" }],
    ["machineIds 含非字串", { type: "machine/subscribe", token: "t", machineIds: [{}] }],
    ["machineIds 含空字串", { type: "machine/subscribe", token: "t", machineIds: [""] }],
    [
      "machineIds 超過 50 筆",
      { type: "machine/subscribe", token: "t", machineIds: Array.from({ length: 51 }, (_, i) => `m${i}`) },
    ],
    ["machineId 超過 64 字", { type: "machine/subscribe", token: "t", machineIds: ["x".repeat(65)] }],
    ["token 超過 512 字", { type: "machine/subscribe", token: "x".repeat(513), machineIds: [] }],
    ["缺 token", { type: "machine/subscribe", machineIds: [] }],
  ])("拒絕不可信輸入：%s", (_label, value) => {
    expect(ClientControlMessageSchema.safeParse(value).success).toBe(false);
  });
});
