import { describe, expect, it } from "vitest";
import { formatFatalLog } from "./fatal.js";

describe("formatFatalLog", () => {
  const now = new Date("2026-09-27T00:00:00.000Z");

  it("輸出與 pino 同形的單行合法 JSON（level 60、err 含 type/message/stack）", () => {
    const line = formatFatalLog("uncaughtException", new TypeError("boom"), now);
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 60,
      time: now.getTime(),
      service: "api",
      context: "fatal",
      kind: "uncaughtException",
      err: { type: "TypeError", message: "boom" },
    });
    expect((parsed.err as { stack?: string }).stack).toContain("TypeError: boom");
    expect(parsed.msg).toContain("uncaughtException: boom");
  });

  it("非 Error 的 rejection 值一律 String() 處理", () => {
    const parsed = JSON.parse(formatFatalLog("unhandledRejection", 42, now)) as {
      err: { type: string; message: string };
    };
    expect(parsed.err).toEqual({ type: "number", message: "42" });
    expect(JSON.parse(formatFatalLog("unhandledRejection", undefined, now)).err.message).toBe(
      "undefined",
    );
  });

  it("無法字串化的 reason（Object.create(null)、toString 會拋）仍輸出合法 JSON、不拋出", () => {
    const bare = Object.create(null) as object;
    const hostile = {
      toString(): string {
        throw new Error("nope");
      },
    };
    for (const reason of [bare, hostile]) {
      const parsed = JSON.parse(formatFatalLog("unhandledRejection", reason, now)) as {
        level: number;
        kind: string;
      };
      expect(parsed).toMatchObject({ level: 60, kind: "unhandledRejection" });
    }
  });

  it("帶 issues 的驗證錯誤（如環境變數 Zod 驗證）在 msg 與 err.issues 中可讀", () => {
    const err = Object.assign(new Error("invalid environment"), {
      name: "ZodError",
      issues: [
        { path: ["MONGO_URL"], message: "Invalid url" },
        { path: [], message: "Required" },
      ],
    });
    const parsed = JSON.parse(formatFatalLog("bootstrap", err, now)) as {
      err: { type: string; issues: string[] };
      msg: string;
    };
    expect(parsed.err.type).toBe("ZodError");
    expect(parsed.err.issues).toEqual(["MONGO_URL: Invalid url", "(root): Required"]);
    expect(parsed.msg).toContain("MONGO_URL: Invalid url");
  });
});
