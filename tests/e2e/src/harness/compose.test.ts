import { describe, expect, it } from "vitest";
import { isServiceHealthy, parseComposePs } from "./compose.js";

/** compose.ts 的純函式（`compose ps --format json` 解析與 healthy 判定）——不需 Docker。 */

const row = (service: string, state: string, health: string): string =>
  JSON.stringify({ Name: `flow-gatekeeper-e2e-${service}-1`, Service: service, State: state, Health: health });

describe("parseComposePs", () => {
  it("NDJSON（Compose 2.21+：一列一個物件）", () => {
    const out = `${row("api", "running", "healthy")}\r\n${row("worker", "running", "starting")}\n`;
    expect(parseComposePs(out)).toEqual([
      { service: "api", state: "running", health: "healthy" },
      { service: "worker", state: "running", health: "starting" },
    ]);
  });

  it("JSON 陣列（舊版 Compose）", () => {
    const out = `[${row("api", "running", "healthy")},${row("seed", "exited", "")}]`;
    expect(parseComposePs(out)).toEqual([
      { service: "api", state: "running", health: "healthy" },
      { service: "seed", state: "exited", health: "" },
    ]);
  });

  it("開頭是 [ 但不是完整 JSON 陣列 → 退回逐列解析", () => {
    const out = `[+] Running 1/1 (progress noise)
${row("api", "running", "healthy")}
`;
    expect(parseComposePs(out)).toEqual([{ service: "api", state: "running", health: "healthy" }]);
  });

  it("空輸出與非 JSON 列略過", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs(`warning: something\n${row("api", "running", "")}`)).toEqual([
      { service: "api", state: "running", health: "" },
    ]);
  });
});

describe("isServiceHealthy", () => {
  it("有 healthcheck 須 healthy；沒有 healthcheck（空字串）須 running", () => {
    expect(isServiceHealthy([{ service: "api", state: "running", health: "healthy" }], "api")).toBe(true);
    expect(isServiceHealthy([{ service: "api", state: "running", health: "starting" }], "api")).toBe(false);
    expect(isServiceHealthy([{ service: "api", state: "running", health: "unhealthy" }], "api")).toBe(false);
    expect(isServiceHealthy([{ service: "x", state: "running", health: "" }], "x")).toBe(true);
    expect(isServiceHealthy([{ service: "x", state: "restarting", health: "" }], "x")).toBe(false);
  });

  it("沒有該服務的容器（剛重啟尚未列出）為 false；其他服務不影響判定", () => {
    expect(isServiceHealthy([], "api")).toBe(false);
    expect(isServiceHealthy([{ service: "worker", state: "running", health: "healthy" }], "api")).toBe(false);
    expect(
      isServiceHealthy(
        [
          { service: "api", state: "running", health: "healthy" },
          { service: "worker", state: "exited", health: "" },
        ],
        "api",
      ),
    ).toBe(true);
  });
});
