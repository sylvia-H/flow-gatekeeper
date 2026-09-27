import { createHash, timingSafeEqual } from "node:crypto";

/**
 * 常數時間字串比較（比對共享密鑰用）。
 *
 * `a !== b` 在第一個不同字元就返回，比較耗時會洩漏「前綴猜對幾個字元」，可被逐字元暴力猜解。
 * `timingSafeEqual` 要求兩邊等長、否則直接 throw；先各自做 SHA-256 讓長度恆為 32 bytes，
 * 既不因長度不同丟例外，也不讓長度差異本身成為可量測的時序訊號。
 */
export function safeEqualString(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
