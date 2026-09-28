import { describe, expect, it } from "vitest";
import { isOriginAllowed, parseAllowedOrigins } from "./ws-origin.js";

describe("parseAllowedOrigins", () => {
  it("未設定、空字串、只有空白與逗號 → 空清單（不檢查）", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(" , ,")).toEqual([]);
  });

  it("逗號分隔、去空白、去尾端斜線、轉小寫、去重", () => {
    expect(
      parseAllowedOrigins(" http://localhost:5173/ ,HTTPS://Demo.Example.com,http://localhost:5173"),
    ).toEqual(["http://localhost:5173", "https://demo.example.com"]);
  });
});

describe("isOriginAllowed", () => {
  const allowed = ["http://localhost:5173"];

  it("白名單為空一律放行", () => {
    expect(isOriginAllowed("http://evil.example", [])).toBe(true);
  });

  it("沒有 Origin（非瀏覽器 client）放行", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed("", allowed)).toBe(true);
  });

  it("在白名單內放行（大小寫、尾端斜線不影響）", () => {
    expect(isOriginAllowed("http://localhost:5173", allowed)).toBe(true);
    expect(isOriginAllowed("HTTP://LOCALHOST:5173/", allowed)).toBe(true);
  });

  it("不在白名單內拒絕（含 port 不同、字串 null）", () => {
    expect(isOriginAllowed("http://evil.example", allowed)).toBe(false);
    expect(isOriginAllowed("http://localhost:8080", allowed)).toBe(false);
    expect(isOriginAllowed("null", allowed)).toBe(false);
  });
});
