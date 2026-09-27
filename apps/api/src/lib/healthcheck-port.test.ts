import { describe, expect, it } from "vitest";
import { resolveHealthcheckPort } from "./healthcheck-port.js";

describe("resolveHealthcheckPort", () => {
  it("env 合法 → 回 API_PORT", () => {
    expect(resolveHealthcheckPort({ API_PORT: "3100" })).toEqual({ ok: true, port: 3100 });
  });

  it("env 不合法 → 回可輸出的原因（含變數名），且不回顯祕密值", () => {
    const result = resolveHealthcheckPort({
      API_PORT: "0",
      WS_AUTH_SECRET: "x",
      REDIS_PASSWORD: "super-secret-password",
      WS_HEARTBEAT_MS: "abc",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("API_PORT");
    expect(result.message).toContain("WS_HEARTBEAT_MS");
    expect(result.message).not.toContain("super-secret-password");
  });
});
