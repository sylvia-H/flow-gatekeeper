import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_DOTENV_PATH } from "./env-file.js";

describe("API_DOTENV_PATH", () => {
  it("指向 apps/api/.env（與 cwd 無關）", () => {
    const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    expect(API_DOTENV_PATH).toBe(join(apiRoot, ".env"));
    // 同層應有 .env.example——確認推導出的是套件根，而不是 src 或 repo 根。
    expect(existsSync(join(dirname(API_DOTENV_PATH), ".env.example"))).toBe(true);
    expect(existsSync(join(dirname(API_DOTENV_PATH), "package.json"))).toBe(true);
  });
});
